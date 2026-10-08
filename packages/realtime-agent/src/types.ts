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
