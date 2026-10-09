/**
 * The turn: admit a prompt to a session, then wait for the agent's answer.
 *
 * Kept free of the harness so it is testable with plain fakes — no context, no socket, no credential.
 * The two impure edges arrive as `admit` and `subscribe`, which is the whole reason this is a separate
 * module from the plugin that supplies them.
 *
 * ## Why this returns an outcome and not `undefined`
 *
 * The plugin's foundational failure was that **it could not say why a turn produced nothing**.
 * A refused admission, a declined empty prompt and a turn that was admitted and never answered all
 * left this function as the same `undefined`, so from outside the plugin the three most different
 * failures in the system were one indistinguishable silence — and the controller's own reason was
 * discarded in a `catch {}` on the way out.
 *
 * {@link TurnOutcome} is that reason, preserved. It is the smallest change that answers the open
 * question, and everything that reports on a turn downstream — the journal, the diagnostics route,
 * the spoken failure — reads it rather than re-deriving it.
 *
 * @module dsh-realtime-responder/turn
 */

import type { DelegationRequest } from 'dsh-realtime-agent'
import type { SessionEventLike } from './types.ts'

/** What {@link createTurnRunner} needs from its caller. */
export interface TurnDeps {
  /**
   * The session to admit into, and the only session an answer is accepted from.
   *
   * An accessor rather than a value: `sessionId` is one of the fields `docs/control-plane-fields.md`
   * classifies as **live**, so the runner reads it at the start of the turn rather than holding the
   * copy taken when the plugin applied. That is what makes steering the voice at a different session
   * cost a message instead of two restarts.
   */
  readonly sessionId: () => string
  /** Character budget for the prompt, read at the start of the turn. */
  readonly maxPromptChars: () => number
  /** Bound on waiting for the answer, in milliseconds, read at the start of the turn. */
  readonly answerTimeoutMs: () => number
  /** Admit one prompt. Rejects when the controller refuses it. */
  readonly admit: (prompt: string) => Promise<void>
  /**
   * Observe session events, with the id of the session each one belongs to.
   *
   * The id is passed **beside** the event rather than read off it, because the harness does not put one
   * there: a `session/event` listener is called as `(session, event)`, and the event carries only
   * `{ type, seq, time, data }`. A subscriber that read the session off the event would match nothing.
   * Returns the disposer that stops observing.
   */
  readonly subscribe: (listener: (event: SessionEventLike, sessionId: string) => void) => () => void
}

/**
 * How one turn ended.
 *
 * A discriminated union rather than `string | undefined`, because the four cases call for four
 * different responses and only one of them is a bug. `refused` carries the controller's own words;
 * the other three carry nothing, because there is nothing to carry and a fabricated reason would be
 * worse than an honest absence.
 */
export type TurnOutcome =
  /** The agent answered. `text` is non-empty. */
  | { readonly kind: 'answered'; readonly text: string }
  /** There was nothing to ask — the transcript carried no text. Declined before the admission. */
  | { readonly kind: 'declined' }
  /** The controller refused the admission. `reason` is what the controller said. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The admission was accepted and nothing came back inside the bound. */
  | { readonly kind: 'timeout' }

/**
 * Build the prompt for one delegated turn from the conversation the model sent.
 *
 * The transcript is what the voice model heard, so it is the question. Lines are joined in order and
 * truncated on the character budget: a truncated question is worse than a refused one, but a prompt the
 * controller rejects is worse than both, so the budget is applied rather than ignored.
 * @param request - the delegation, carrying the conversation so far.
 * @param maxChars - character ceiling.
 * @returns the prompt, or an empty string when the transcript carried no text.
 */
export function promptFrom(request: DelegationRequest, maxChars: number): string {
  const joined = request.transcript
    .map(line => line.text)
    .filter(text => text.length > 0)
    .join('\n')
    .trim()
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined
}

/**
 * The assistant's completed text, when the event is one.
 *
 * Returns `undefined` for anything that is not an appended `assistant/message`, so the caller can feed it
 * every event on the bus without pre-filtering and without a wrong answer ever resolving the wait.
 *
 * It does **not** decide which session the event belongs to, on purpose: the owning session is the
 * listener's first argument and is never a field on the event, so the caller scopes it. This function used
 * to read `event.sessionId`, a field the harness does not set — which made it return `undefined` for every
 * event ever delivered and every turn end in `timeout`, while a hand-built test event carrying the field
 * passed. See {@link SessionEventLike}.
 * @param event - one session event.
 * @returns the spoken text, or `undefined` when this event is not an answer.
 */
export function answerText(event: SessionEventLike): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  if (event.surfaceOp !== 'append') return undefined
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map(block => (block as { text?: unknown }).text)
    .filter(part => typeof part === 'string')
    .join('\n')
    .trim()
  return text.length === 0 ? undefined : text
}

/**
 * The controller's own words for a refusal, or a stated absence.
 *
 * A rejection that carries no message is still a rejection, and naming it is more useful to a reader
 * than an empty string that reads as "no reason". The fallback is deliberately *not* a paraphrase of
 * the failure — it says only what this function knows, which is that the controller refused.
 * @param error - whatever the admission rejected with.
 * @returns a non-empty reason.
 */
function refusalReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return 'the session controller refused the prompt'
}

/**
 * Run one delegated turn.
 *
 * Subscribes **before** admitting, so an answer that lands on the same tick as the admission is not
 * missed — a fast agent is exactly the case a naive admit-then-subscribe loses. Every way the turn can
 * end is named in the {@link TurnOutcome} it resolves with; nothing is collapsed, so a caller can act
 * on the difference between "the controller said no" and "nobody answered in time".
 * @param deps - the session, the budget, and the two impure edges.
 * @returns a function that answers one delegation, or resolves with why it did not.
 */
export function createTurnRunner(deps: TurnDeps): (request: DelegationRequest) => Promise<TurnOutcome> {
  return async (request: DelegationRequest): Promise<TurnOutcome> => {
    // All three are read **once, here**: a change takes effect on the next use, and a turn is one use.
    // Reading them per event instead would let a change made while a turn is in flight move the very
    // session the answer is expected on, stranding the turn the change was meant to help.
    const sessionId = deps.sessionId()
    const prompt = promptFrom(request, deps.maxPromptChars())
    // An empty prompt is a turn the controller would reject, so it is declined before the admission
    // rather than reported as a failure after one.
    if (prompt.length === 0) return { kind: 'declined' }

    let settle!: (text: string | undefined) => void
    const answered = new Promise<string | undefined>((resolve) => { settle = resolve })
    const timer = setTimeout(() => { settle(undefined) }, deps.answerTimeoutMs())
    const unsubscribe = deps.subscribe((event, eventSessionId) => {
      // Scoped here, from the id the subscriber supplies: the owning session is the listener's first
      // argument and is never a field on the event, so this is the only place the comparison can be made.
      if (eventSessionId !== sessionId) return
      const text = answerText(event)
      if (text === undefined) return
      settle(text)
    })

    try {
      await deps.admit(prompt)
    } catch (error) {
      // The controller refused the admission. Nothing was queued, so there is nothing to wait for —
      // and the reason it gave is the whole point of this patch, so it is returned rather than dropped.
      clearTimeout(timer)
      unsubscribe()
      return { kind: 'refused', reason: refusalReason(error) }
    }

    const text = await answered
    clearTimeout(timer)
    unsubscribe()
    return text === undefined ? { kind: 'timeout' } : { kind: 'answered', text }
  }
}
