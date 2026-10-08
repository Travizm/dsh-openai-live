/**
 * The turn: admit a prompt to a session, then wait for the agent's answer.
 *
 * Kept free of the harness so it is testable with plain fakes — no context, no socket, no credential.
 * The two impure edges arrive as `admit` and `subscribe`, which is the whole reason this is a separate
 * module from the plugin that supplies them.
 *
 * @module dsh-realtime-responder/turn
 */

import type { DelegationRequest } from 'dsh-realtime-agent'
import type { SessionEventLike } from './types.ts'

/** What {@link createTurnRunner} needs from its caller. */
export interface TurnDeps {
  /** The session to admit into, and the only session an answer is accepted from. */
  readonly sessionId: string
  /** Character budget for the prompt. */
  readonly maxPromptChars: number
  /** Bound on waiting for the answer, in milliseconds. */
  readonly answerTimeoutMs: number
  /** Admit one prompt. Rejects when the controller refuses it. */
  readonly admit: (prompt: string) => Promise<void>
  /** Observe session events; returns the disposer that stops observing. */
  readonly subscribe: (listener: (event: SessionEventLike) => void) => () => void
}

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
 * Returns `undefined` for anything that is not an appended `assistant/message` for this session, so the
 * caller can feed it every event on the bus without pre-filtering and without a wrong answer ever
 * resolving the wait.
 * @param event - one session event.
 * @param sessionId - the session this responder is attached to.
 * @returns the spoken text, or `undefined` when this event is not this session's answer.
 */
export function answerText(event: SessionEventLike, sessionId: string): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  if (event.sessionId !== sessionId) return undefined
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
 * Run one delegated turn.
 *
 * Subscribes **before** admitting, so an answer that lands on the same tick as the admission is not
 * missed — a fast agent is exactly the case a naive admit-then-subscribe loses. Declining is a
 * first-class outcome: returning `undefined` lets a later responder answer, and failing everything, the
 * agent's own "I cannot take care of that" notice stands rather than an empty utterance.
 * @param deps - the session, the budget, and the two impure edges.
 * @returns a function that answers one delegation, or `undefined` to decline it.
 */
export function createTurnRunner(deps: TurnDeps): (request: DelegationRequest) => Promise<string | undefined> {
  return async (request: DelegationRequest): Promise<string | undefined> => {
    const prompt = promptFrom(request, deps.maxPromptChars)
    // An empty prompt is a turn the controller would reject, so it is declined before the admission
    // rather than reported as a failure after one.
    if (prompt.length === 0) return undefined

    let settle!: (text: string | undefined) => void
    const answered = new Promise<string | undefined>((resolve) => { settle = resolve })
    const timer = setTimeout(() => { settle(undefined) }, deps.answerTimeoutMs)
    const unsubscribe = deps.subscribe((event) => {
      const text = answerText(event, deps.sessionId)
      if (text === undefined) return
      settle(text)
    })

    try {
      await deps.admit(prompt)
    } catch {
      // The controller refused the admission. Nothing was queued, so there is nothing to wait for.
      clearTimeout(timer)
      unsubscribe()
      return undefined
    }

    const text = await answered
    clearTimeout(timer)
    unsubscribe()
    return text
  }
}
