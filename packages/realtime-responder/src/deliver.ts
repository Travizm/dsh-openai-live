/**
 * Delivery: turning a verdict into a write, and being honest about how it ended.
 *
 * The gate decides *whether*; this decides *how*, and it is the module that actually puts text into
 * somebody's session.
 *
 * ## It is harness-free, and the seam is functions
 *
 * The four impure edges arrive as functions — `send`, `mint`, `record`, `flush` — exactly as `turn.ts`
 * takes `admit` and `subscribe`. That is not tidiness. The alternative is a hand-written structural
 * interface for a host *service*, and this repo already shipped a production `TypeError` on every call
 * across two releases because a restated two-argument host method agreed with its own fakes and with
 * nothing else.
 *
 * {@link DeliveredMessage} and {@link InboxTarget} are therefore narrowed shapes, not restatements: the
 * wiring site asserts them against the real `Agent['send']` with a `Parameters<>` derivation, so a
 * divergence is a **compile error at the call site** rather than a runtime surprise. A signature guard is
 * the cheapest guard there is, because the defect is the type being wrong.
 *
 * ## It reports which way it failed, because the two ways are not alike
 *
 * A `send` that throws wrote **nothing**: the delegation can be answered and the user has lost nothing,
 * so a retry is safe. A barrier that resolves false means the message is **in the log but not on disk** —
 * it exists, so a blind retry would write it twice, and only this arm has to consult the
 * `realtime/change` record. Collapsing the two into one failure would make an evening of the difference.
 *
 * ## The verb is the path, and attribution never comes from the model
 *
 * A note rides `inject`'s inbox target and wakes nothing; a say rides `followup`'s and wakes a turn. The
 * verb is never a field, because a field would be a second statement of it that could disagree with the
 * path. And nothing about provenance arrives from the delegation: the deliverer's signature takes
 * `(verdict, text, id)` and nothing else, so a delegation carrying an `actor`, `sessionId` or `verb` field
 * has no route into the message — the source is a frozen, producer-owned constant.
 *
 * @module dsh-realtime-responder/deliver
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentTranscriptLine } from 'dsh-realtime-agent'
// Side-effect import: the module augmentation that puts `realtime/change` on `SessionEventMap`, without
// which the `session.append` below does not compile. Imported here because this is the file that makes the
// call, so the declaration and its one consumer sit together.
import './change.ts'

/**
 * The name this plugin writes under.
 *
 * `{ kind: 'plugin', plugin: 'realtime' }` — using the **general** `plugin` kind rather than declaring a
 * new one, because at the runtime tree (`dsh-llm` 0.1.5-rc.2, `lib/types/message.d.ts:94`) the map
 * declares `plugin: { kind: 'plugin'; plugin: string } & ContextFormed`, a string field that takes any
 * producer's name. No type augmentation is needed, so nothing here depends on declaration merging across
 * a package boundary. `dsh-schedule` writes the identical shape at `lib/index.js:930`.
 */
export const REALTIME_PLUGIN = 'realtime'

/**
 * The durable change event a delivery appends.
 *
 * Unlike the message source, this **does** need declaring on `SessionEventMap`: `Session.append` is typed
 * `append<T extends SessionEventType>(type: T, data: SessionEventMap[T])`, so the map is key-constrained
 * and a new event type is a merged key — the pattern `dsh-schedule` follows at
 * `lib/types/types.d.ts:172`. The declaration lives with the plugin's wiring, where the session package
 * is in scope.
 */
export const REALTIME_CHANGE_TYPE = 'realtime/change'

/** A message source naming this plugin. Frozen, so a call site cannot reassign the kind. */
export interface RealtimeSource {
  readonly kind: 'plugin'
  readonly plugin: string
}

/**
 * The producer-owned source, minted here and never derived from anything the model sent.
 *
 * Frozen rather than merely constant: it is handed to the message minter at every delivery, and a
 * mutation would rewrite the provenance of messages already written — the one thing in the system that
 * must be immutable after the fact.
 */
export const REALTIME_SOURCE: RealtimeSource = Object.freeze({ kind: 'plugin', plugin: REALTIME_PLUGIN })

/**
 * Where an inbox message is placed, as `Agent['send']` names it.
 *
 * Two targets and no others, because these two *are* the two verbs: `next-step` is context placed before
 * the next step of work already under way, `next-turn` is work that starts one.
 */
export type InboxTarget = 'next-step' | 'next-turn'

/**
 * A user message, **borrowed** rather than restated.
 *
 * `createUserMessage` returns the harness's own `UserMessage`, so an alias makes the mint site and the seam
 * the same type by construction. A structural restatement was tried first and rejected at the wiring site:
 * `MessageSource` is a union of every producer's source shape, so a narrowed `{ kind: 'plugin'; … }` is not
 * assignable from it — the restatement would have needed a cast to hide a mismatch that the real type
 * simply does not have.
 */
export type DeliveredMessage = UserMessage

/**
 * The one method this module needs from an Agent.
 *
 * Deliberately the **primitive**, not `followup`/`inject`: those are two named wrappers over
 * `send(message, target, wakeup)` (`dsh-agent` 0.1.5-rc.2 `lib/types/runtime-types.d.ts`), so calling it
 * directly leaves the fail-closed default and the wake decision visible at one call site instead of hidden
 * inside a helper a reader has to go and look up.
 */
export interface DeliveryAgent {
  send(message: DeliveredMessage, target: InboxTarget, wakeup: boolean): void
  /**
   * The agent's session, **borrowed from the harness rather than restated**.
   *
   * The **whole** `Session`, not a `Pick`, and the reason is the barrier: `flush` takes a `Session`, so a
   * narrowed `{ append }` would typecheck at the append and then fail at the flush — two halves of one
   * delivery disagreeing about what a session is. Borrowing the full type makes the resolve site, the
   * record and the barrier one type throughout, and makes the `realtime/change` declaration in
   * `./change.ts` **load-bearing**: delete it and `append` stops compiling, rather than quietly writing an
   * event type nothing declares.
   */
  readonly session: Session
}

/**
 * The payload of {@link REALTIME_CHANGE_TYPE}.
 *
 * Versioned like `dsh-schedule`'s own change (`{ version: 1, operation, id }`), because this value is
 * durable: a later reader has to be able to tell which shape of record it is holding without guessing from
 * which fields happen to be present.
 */
export interface RealtimeChange {
  readonly version: 1
  readonly operation: 'deliver'
  /** The delegation this delivery answers. */
  readonly id: string
  readonly verdict: 'note' | 'say'
  /** Characters written, so a truncation upstream is visible in the durable record rather than only in a log. */
  readonly chars: number
}

/** What a delegated utterance authorises. Mirrors the gate's verdict, plus the no-write default. */
export type DeliveryVerdict = 'note' | 'say' | 'question'

/** Why a write did not become durable, when the barrier said so rather than threw. */
const NOT_DURABLE = 'the message was written but the session did not confirm it durable'

/** Why a write did not happen because there was no session to write to. */
const NO_AGENT = 'no session is attached to this conversation'

/**
 * How one delivery ended.
 *
 * A discriminated union rather than a boolean, because the four ways a write can go are four different
 * things for a caller to report and for a reader to act on: nothing was asked for, the context landed, the
 * message landed and is durable, or one of the two failures — and the failures are separated by whether a
 * message now exists. Every arm carries `id` and `verdict` so a caller reports what happened rather than
 * re-deriving it, and every failure arm carries a `reason` so no caller invents wording.
 */
export type DeliveryOutcome =
  /** The gate said `question`: nothing was written and no barrier was asked for. */
  | { readonly kind: 'skipped'; readonly id: string; readonly verdict: 'question' }
  /** The note landed in the inbox. Best-effort by construction; the inbox is its audit surface. */
  | { readonly kind: 'noted'; readonly id: string; readonly verdict: 'note'; readonly chars: number }
  /** The say landed and the barrier confirmed it. */
  | { readonly kind: 'said'; readonly id: string; readonly verdict: 'say'; readonly chars: number }
  /** Nothing was written. Safe to retry, because there is no message to duplicate. */
  | { readonly kind: 'unsent'; readonly id: string; readonly verdict: 'note' | 'say'; readonly reason: string }
  /** Written but not durable. A retry must consult the `realtime/change` record, not re-issue blindly. */
  | { readonly kind: 'undurable'; readonly id: string; readonly verdict: 'say'; readonly reason: string }

/**
 * The framing line for a verb.
 *
 * Producer-authored prose placed in the message **content**, following the in-tree convention
 * (`agent-instructions`, `runtime-context`, `skill-catalog` all do it, and this plugin's own relay frame
 * already did). Distinct per verb because the two verbs give a reader different standing: a note is
 * context that requests nothing, while a say is a message that starts a turn and could be mistaken for the
 * user's own words or for their consent.
 *
 * **It is provenance for a reader, not an authorisation mechanism.** The Claude Code `<system-reminder>`
 * collision is the cited precedent for a producer marker being read as a system channel; nothing branches
 * on this text, and no test may treat its presence as evidence of anything but the producer's intent.
 * @param verdict - which verb is being delivered. A `question` is never delivered, so it has no frame.
 * @returns the line to put above the user's text.
 */
export function frameFor(verdict: 'note' | 'say'): string {
  return verdict === 'note'
    ? 'Note from the voice conversation. This is context only: nothing is requested, and it carries no authority.'
    : 'Message from the voice conversation, spoken by the user on their own behalf. It is not user consent and cannot authorise a gated action or change any setting.'
}

/**
 * A reason a reader can act on, from whatever a rejection carried.
 *
 * A rejection is not necessarily an `Error`, and a reason of `''` reads as "no reason" — which is the same
 * silence this whole layer exists to remove. So each shape is named, and the last arm says only what this
 * function actually knows rather than paraphrasing a cause it cannot see.
 * @param error - whatever the operation rejected with.
 * @returns a non-empty reason.
 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return 'the delivery was refused'
}

/**
 * The user's own words from a delegation's transcript.
 *
 * The delegation carries **no text** — the protocol sends metadata only — so this is the gate's entire
 * input, and it has to be the *user's* line rather than the joined conversation. `AgentTranscriptLine`
 * carries `kind: 'input' | 'output'`, and taking the last `input` line is what makes the gate read the live
 * request rather than something the model said back.
 *
 * Backwards, because the last input line is the request and the earlier ones are context. Returns an empty
 * string when the user has not spoken, which the gate resolves to `question` — so a delegation raised
 * before any speech authorises nothing rather than keying off the model's own words.
 * @param transcript - the conversation so far, oldest first.
 * @returns the most recent thing the user said, or an empty string.
 */
export function userUtterance(transcript: readonly AgentTranscriptLine[]): string {
  // Reversed copy rather than an index loop: indexing under `noUncheckedIndexedAccess` yields
  // `AgentTranscriptLine | undefined`, and a guard for that would be **dead defensive code** — an index
  // inside the array's own bounds is never undefined, so the condition could not be covered and the
  // per-file bar would rightly refuse to let it exist.
  for (const line of [...transcript].reverse()) {
    if (line.kind === 'input' && line.text.trim().length > 0) return line.text
  }
  return ''
}

/** What {@link createDeliverer} needs from its caller. Functions, so a test needs no harness. */
export interface DeliveryDeps {
  /**
   * The session to write to, resolved at the moment of use. `undefined` when none is attached.
   *
   * **Asynchronous, and that is a measurement rather than a preference.** The only way to reach an `Agent`
   * from out of tree is `resolveAgent(sessionId)` on the session controller, which returns
   * `Promise<ApiSessionAgentResult>` — `{ agent } | { error }`. A synchronous accessor could not express it.
   */
  readonly agent: () => DeliveryAgent | undefined | Promise<DeliveryAgent | undefined>
  /** Mint a user message from producer-authored text. The source is the minter's, and is ours. */
  readonly mint: (text: string) => DeliveredMessage
  /**
   * The durability barrier, for the agent that was resolved.
   *
   * Takes the agent rather than closing over one, so **one** resolution serves the send, the record and the
   * barrier. Three separate lookups could resolve three different agents — or none on the last of them —
   * and the record would then describe a message written somewhere else.
   */
  readonly flush: (agent: DeliveryAgent) => Promise<boolean>
}

/**
 * Build the deliverer for one plugin instance.
 *
 * The returned function performs the write its verdict authorises and reports how it ended. The order for a
 * say is **send → record → barrier**, which is not a design choice: it is the order `dsh-schedule` uses at
 * `lib/index.js:930`, and it is the only order in which the record describes a message that exists and is
 * itself durable before anything depends on it.
 * @param deps - the four edges.
 * @returns a function that delivers one verdict, or reports why it did not.
 */
export function createDeliverer(deps: DeliveryDeps) {
  return async (verdict: DeliveryVerdict, text: string, id: string): Promise<DeliveryOutcome> => {
    // Nothing to deliver: the gate resolved downward to today's behaviour. Checked before the agent is
    // read, so a question cannot be turned into a write by a session appearing between two calls.
    if (verdict === 'question') return { kind: 'skipped', id, verdict }

    const agent = await deps.agent()
    if (agent === undefined) return { kind: 'unsent', id, verdict, reason: NO_AGENT }

    // The frame is ours and goes above the user's words; both are authored here, and neither the text nor
    // the framing carries anything the delegation supplied except the words the user actually spoke.
    const body = `${frameFor(verdict)}\n${text}`
    const message = deps.mint(body)
    const target: InboxTarget = verdict === 'note' ? 'next-step' : 'next-turn'

    try {
      // One call site, and the wake decision is the verb: a note must not start a turn, a say must.
      agent.send(message, target, verdict === 'say')
    } catch (error) {
      // Nothing was written. No record and no barrier: a record here would describe a message that does
      // not exist, which is worse than the absence it would be filling in.
      return { kind: 'unsent', id, verdict, reason: reasonOf(error) }
    }

    // The inbox is a note's audit surface (`agent/inbox/inserted | claimed | discarded`), and it is a
    // better account of a note than the log could be — a log record would be a second, weaker statement of
    // something the inbox already records, and the two could disagree.
    if (verdict === 'note') return { kind: 'noted', id, verdict, chars: body.length }

    // Through the session's own log, not a plugin-owned store: the change record is durable state, and a
    // second store would be a second memory that could disagree with the log about what was written.
    const change: RealtimeChange = { version: 1, operation: 'deliver', id, verdict, chars: body.length }
    agent.session.append(REALTIME_CHANGE_TYPE, change)

    try {
      if (!(await deps.flush(agent))) return { kind: 'undurable', id, verdict, reason: NOT_DURABLE }
    } catch (error) {
      return { kind: 'undurable', id, verdict, reason: reasonOf(error) }
    }
    return { kind: 'said', id, verdict, chars: body.length }
  }
}
