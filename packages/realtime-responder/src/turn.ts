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
  /**
   * The preamble put in front of the relayed conversation, read at the start of the turn.
   *
   * Required rather than optional, and that is the lesson this field carries. The framing is what tells
   * the session it is answering a spoken relay, and a field a caller *may* omit is a field a caller
   * silently omits: this plugin shipped relaying bare speech, and nothing failed — the session simply
   * inferred a provenance and answered in prose meant to be read. A required accessor makes the plugin
   * the compiler's business instead of the author's memory. Read per turn with the session and the
   * budgets beside it, so a change lands on the next turn.
   */
  readonly frame: () => string
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
  /**
   * The narration policy, read once at the start of the turn. Absent means no narration at all.
   *
   * Absent rather than defaulted, so a caller that has not thought about narration gets silence rather than
   * a plugin deciding on its own to talk during someone's conversation.
   */
  readonly milestone?: () => MilestonePolicy
  /** Where a step is reported, once the policy has decided whether it is spoken or silent. */
  readonly onStep?: (step: TurnStep) => void
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
 * One step of a delegated turn, ready to be narrated.
 *
 * The two channels are the seam's own distinction, reused rather than reinvented: `commentary` is spoken
 * aloud, `thinking` is context the model may use without saying it. "Spoken for milestones, silent for
 * chatter" is a choice about **this field** and nothing else.
 */
export interface TurnStep {
  /** The delegation this step belongs to. Carried so the narrator can address the right turn. */
  readonly id: string
  readonly channel: 'commentary' | 'thinking'
  readonly text: string
}

/**
 * What may be said, as it stands when a turn starts.
 *
 * A *policy* rather than a bare set of numbers, so the split is explicit: the words are a configuration
 * question and belong to the plugin, while pacing is per-turn state and belongs to the runner. Every field
 * is read once, at the start of the turn, like the session and the budgets beside it.
 */
export interface MilestonePolicy {
  /** The phrase to say for a tool, by the tool's own name. Never derives words from tool arguments. */
  readonly phrase: (toolName: string) => string
  /** Shortest gap between two spoken milestones. */
  readonly intervalMs: number
  /** Most milestones spoken aloud in one turn. */
  readonly maxSpoken: number
  /** When false every step is silent — the off switch, which is not the same as a cap of zero. */
  readonly speak: boolean
}

/**
 * A string no longer than the ceiling, by UTF-16 code units.
 *
 * Stated rather than implied: the ceiling is a budget for how much text a turn may carry, not a display
 * width, and the provider counts tokens. A cut inside a surrogate pair is therefore accepted here — it
 * is the same cut the seam has always made, and a grapheme-aware one would be a behaviour change to a
 * bound rather than a framing change, which belongs in its own release.
 * @param text - the text to cut.
 * @param maxChars - the ceiling.
 * @returns the text, or its prefix.
 */
function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/**
 * Build the prompt for one delegated turn from the conversation the model sent.
 *
 * The transcript is what the voice model heard, so it is the question. Lines are joined in order and
 * truncated on the character budget: a truncated question is worse than a refused one, but a prompt the
 * controller rejects is worse than both, so the budget is applied rather than ignored.
 *
 * **The frame says what this is.** Without one the relayed text arrives as a bare block of speech —
 * both sides of the conversation, flattened, with nothing naming where it came from or what shape of
 * answer suits an ear. Measured on a live relay: the session's own reasoning had to *infer* the
 * provenance, and it answered in chat prose (markdown, a file link, a fenced block) which was then read
 * aloud verbatim. The frame names the relay and asks for prose.
 *
 * Two degradations, both total rather than half-applied. An **empty frame** is a deployment that wants
 * none, so the prompt is the bare question. And a budget **too small to carry the frame** is answered
 * with the bare question clipped to the budget: the frame is never allowed to eat the question it exists
 * to introduce, because the question is the part that cannot be reconstructed downstream. Neither is a
 * branch a configuration cannot reach — `maxPromptChars` is a validated positive integer, so a budget of
 * four is as reachable as a budget of four thousand.
 * @param request - the delegation, carrying the conversation so far.
 * @param maxChars - character ceiling for the whole prompt, frame included.
 * @param frame - the preamble, or an empty string for none.
 * @returns the prompt, or an empty string when the transcript carried no text.
 */
export function promptFrom(request: DelegationRequest, maxChars: number, frame: string): string {
  const joined = request.transcript
    .map(line => line.text)
    .filter(text => text.length > 0)
    .join('\n')
    .trim()
  // Nothing was said, so there is no question to introduce — and a frame alone would turn a turn that
  // must be **declined** into one the controller is asked to admit. Checked before the frame is used at
  // all, so framing can never manufacture a prompt out of silence.
  if (joined.length === 0) return ''
  if (frame.length === 0 || maxChars - frame.length - 1 < 1) return clip(joined, maxChars)
  return `${frame}\n${clip(joined, maxChars - frame.length - 1)}`
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
 * The tool a session event names, when it names one at all.
 *
 * **A `tool/call` is not a surface event**, so it carries no `surfaceOp` — a filter written the way
 * {@link answerText}'s is (`surfaceOp === 'append'`) drops every step, silently and for ever, and the
 * narration simply never happens. The event `type` is the whole filter, which is why this is a function
 * with a test rather than an inline condition.
 * @param event - one session event.
 * @returns the tool's name, or `undefined` when this event is not a tool call.
 */
export function stepTool(event: SessionEventLike): string | undefined {
  if (event.type !== 'tool/call') return undefined
  const name = event.data?.name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

/**
 * The phrase table that a list of `tool=phrase` entries describes.
 *
 * Configuration is a flat list of strings because a schema containing an object cannot be *named* by the
 * declaration this package emits, and a config shape that cannot be published is not a config shape.
 *
 * The consequence is worth stating rather than discovering: an entry with no `=`, an empty name, or an
 * empty phrase names **nothing**, so it can attribute a phrase to no tool at all, and that tool falls
 * through to the fallback exactly as an unlisted tool does. Degrading to the fallback is the whole of it —
 * no entry is ever half-applied, and a mistyped entry can never speak a tool's name as if it were prose.
 * @param entries - the configured `tool=phrase` strings.
 * @returns the phrases, by tool name. Only entries that name a tool and a phrase appear.
 */
export function phraseTable(entries: readonly string[]): Map<string, string> {
  const table = new Map<string, string>()
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const tool = entry.slice(0, separator).trim()
    const phrase = entry.slice(separator + 1).trim()
    if (tool.length === 0 || phrase.length === 0) continue
    table.set(tool, phrase)
  }
  return table
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
    // All four are read **once, here**: a change takes effect on the next use, and a turn is one use.
    // Reading them per event instead would let a change made while a turn is in flight move the very
    // session the answer is expected on, stranding the turn the change was meant to help.
    const sessionId = deps.sessionId()
    const prompt = promptFrom(request, deps.maxPromptChars(), deps.frame())
    // An empty prompt is a turn the controller would reject, so it is declined before the admission
    // rather than reported as a failure after one.
    if (prompt.length === 0) return { kind: 'declined' }

    let settle!: (text: string | undefined) => void
    const answered = new Promise<string | undefined>((resolve) => { settle = resolve })
    const timer = setTimeout(() => { settle(undefined) }, deps.answerTimeoutMs())
    // Narration state, per turn: how many milestones have been spoken, and when the last one was. The
    // policy is read once, with the session and the budgets, so a change lands on the next turn.
    const milestone = deps.milestone?.()
    const onStep = deps.onStep
    let spoken = 0
    let lastSpokenAt = 0
    const unsubscribe = deps.subscribe((event, eventSessionId) => {
      // Scoped here, from the id the subscriber supplies: the owning session is the listener's first
      // argument and is never a field on the event, so this is the only place the comparison can be made.
      if (eventSessionId !== sessionId) return
      if (milestone !== undefined && onStep !== undefined) {
        const tool = stepTool(event)
        if (tool !== undefined) {
          const now = Date.now()
          // The first milestone is never held back by the interval: a turn that has said nothing yet has
          // nothing to be paced against, and "I am on it" is the one update worth having immediately.
          const speaks = milestone.speak && spoken < milestone.maxSpoken
            && (spoken === 0 || now - lastSpokenAt >= milestone.intervalMs)
          if (speaks) {
            spoken += 1
            lastSpokenAt = now
          }
          onStep({ id: request.id, channel: speaks ? 'commentary' : 'thinking', text: milestone.phrase(tool) })
        }
      }
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
