/**
 * Types for the realtime agent consumer. This module contains **no runtime code** — a
 * DeepSeek Harness convention that keeps type-only imports erasable.
 *
 * @module dsh-realtime-agent/types
 */

/** One line of the conversation reconstructed from transcripts, oldest first. */
export interface AgentTranscriptLine {
  /** Which side spoke. */
  kind: 'input' | 'output'
  /** The line's text, already coalesced from the fragments it arrived in. */
  text: string
}

/**
 * What a responder is asked when the voice model delegates.
 *
 * The protocol sends **metadata only** — a delegation carries no task text — so the request carries the
 * conversation instead. Reconstructing intent is deliberately left to the responder: the consumer
 * knows the conversation, and only the application knows its own state.
 */
export interface DelegationRequest {
  /** The delegation id. Preserve it — it is what correlates an answer with the ask. */
  id: string
  /** Position on the session timeline, in milliseconds. */
  offsetMs: number
  /** The conversation so far, oldest first. Empty when nothing has been transcribed yet. */
  transcript: readonly AgentTranscriptLine[]
  /** The session that raised it, for correlation in logs. */
  sessionId: string
}

/**
 * A responder's answer.
 *
 * Return `undefined` — or an empty `text` — to decline. Declining is always available and never
 * silent: the consumer then tells the model, out loud, that the request could not be handled.
 */
export interface DelegationAnswer {
  /** Plain text to deliver. Empty or whitespace-only is a decline. */
  text: string
  /**
   * How to deliver it.
   *
   * `spoken` sends it as commentary, which the model says aloud — use it when the person in the
   * conversation is the one waiting. `silent` sends it as thinking, which the model may use without
   * announcing it; use it for state worth knowing but not saying. Defaults to `silent`.
   */
  mode?: 'spoken' | 'silent'
}

/**
 * Validated plugin configuration.
 *
 * A session is opened only when `autoStart` is set: mounting this plugin should not, on its own,
 * spend credit or open a socket.
 */
export interface RealtimeAgentConfig {
  /** Registered realtime route to open a session on. */
  provider: string
  /** Voice model to request. */
  model: string
  /** Output voice; omitted leaves the provider default. */
  voice?: string
  /** Opening instructions for the live session. */
  instructions?: string
  /** Open a session as soon as the plugin mounts. */
  autoStart: boolean
  /** Bound, in milliseconds, on waiting for a responder before telling the model it cannot be handled. */
  delegationTimeoutMs: number
  /** Character budget for the transcript carried on a delegation request. */
  maxTranscriptChars: number
}

/**
 * The voice session's state, as the plugin that owns it is the only one able to report it.
 *
 * A **query's** answer rather than an event's payload: nothing emits this, and a caller that needs it
 * asks through `realtime-agent/status` — which is also what makes "is voice live" answerable without
 * opening anything to find out.
 */
export interface RealtimeVoiceStatus {
  /** Whether a provider session is open now. */
  readonly open: boolean
  /**
   * The registered route the session is on — or, when none is open, the one a start *would* use.
   *
   * Read from the session the provider actually accepted when there is one, because a provider may
   * alias what was asked for.
   */
  readonly provider: string
  /** The model the provider accepted, or the one configured when nothing is open. */
  readonly model: string
  /** The output voice, when one has been settled. */
  readonly voice?: string
  /** The provider's own session id. Present only while a session is open. */
  readonly sessionId?: string
}

/**
 * Why a session request did not succeed, in the shape a caller can act on.
 *
 * **Never the failure's message**, and that is a deliberate limitation rather than an oversight: the
 * plugin that holds the credential is the adapter, and this one holds none to redact against — which is
 * the same rule its journal follows, where a session failure is recorded as its *class*. What it can
 * carry instead is more useful than the message: the seam's own machine code, and the `remedy` written
 * to be relayed verbatim, both of which name a *setting* rather than its value.
 */
export interface RealtimeSessionRefusal {
  /** The seam's machine code, when the failure was one of its classified ones (`NOT_CONFIGURED`, `RATE_LIMITED`, …). */
  readonly code?: string
  /** What to do about it, written to be relayed verbatim to whoever is trying to use the feature. */
  readonly remedy?: string
  /**
   * Where the remedy is carried out, when the provider publishes a page for it.
   *
   * The remedy says *what* to do and this says *where*: a UI that shows one without the other tells a user to
   * add credit and leaves them to find the billing page themselves.
   */
  readonly link?: string
  /** The failing class, when there was no code to carry. A class, never an instance's message. */
  readonly class?: string
}

/**
 * What a request to open or close the voice session produced.
 *
 * The **outcome**, not an acknowledgement, because the two are the difference between "asked" and "it
 * worked" — and collapsing them is the failure this project has already paid for once: a `start` that
 * replied *requested* while the open silently failed teaches a user that the plugin is broken.
 */
export interface RealtimeSessionRequestOutcome {
  /** Whether the request achieved what it asked for. */
  readonly ok: boolean
  /** The state **after** the attempt. */
  readonly voice: RealtimeVoiceStatus
  /** Present exactly when `ok` is false. */
  readonly refusal?: RealtimeSessionRefusal
}
