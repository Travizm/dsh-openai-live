/**
 * Types for the realtime voice seam. This module contains **no runtime code** — a
 * DeepSeek Harness convention that keeps type-only imports erasable.
 *
 * @module dsh-realtime/types
 */

/** A model route a realtime adapter can serve. */
export interface RealtimeProviderInfo {
  /** Route id a caller passes as `RealtimeSessionOptions.provider`. Must equal the registered route. */
  id: string
  /** Human-readable label for diagnostics and surfaces. */
  name: string
  /** Optional one-line description of what this route speaks. */
  description?: string
}

/** One voice model advertised by an adapter. Catalog membership is advisory: it never gates a session. */
export interface RealtimeModelInfo {
  /** Exact model id passed as `RealtimeSessionOptions.model`. */
  id: string
  /** Human-readable label. */
  name: string
  /** What the model can take in, e.g. `audio`, `text`, `image`. */
  inputModalities?: readonly RealtimeModality[]
  /** What the model puts out, e.g. `audio`, `text`. */
  outputModalities?: readonly RealtimeModality[]
}

/** A modality a realtime model accepts or emits. */
export type RealtimeModality = 'audio' | 'text' | 'image'

/** Raw audio encoding expected on the wire. */
export interface RealtimeAudioFormat {
  /** Sample rate in Hz. `24000` for GPT-Live-1. */
  sampleRate: number
  /** Channel count. `1` (mono) for GPT-Live-1. */
  channels: number
  /** Sample encoding. `pcm16` is signed little-endian 16-bit. */
  encoding: 'pcm16'
}

/** What a caller asks an adapter to open. */
export interface RealtimeSessionOptions {
  /** Registered route to use. Selects the adapter. */
  provider: string
  /** Exact model id. */
  model: string
  /**
   * Opening system instructions.
   *
   * Advisory at the seam: the protocol may treat these as immutable once a session starts, in which
   * case an adapter must surface a coded error rather than silently dropping the request. Extending
   * live instructions is `RealtimeSession.appendInstructions`, not a new session.
   */
  instructions?: string
  /** Output voice id. Provider-specific; `undefined` leaves the provider default. */
  voice?: string
  /** Cancellation for session establishment. Implementations must settle promptly after it aborts. */
  signal?: AbortSignal
  /** Handler callbacks for the life of the session. */
  handlers?: RealtimeSessionHandlers
}

/** A delegated unit of work handed to the application by the voice model. */
export interface RealtimeDelegation {
  /** Opaque correlation id. Preserve it unchanged on every update about this delegation. */
  id: string
  /** Who is expected to do the work. `client` means this application. */
  target: 'client' | 'responses'
  /**
   * Position on the session timeline, in milliseconds.
   *
   * Note there is deliberately **no task text** here: the protocol sends metadata only, so a
   * consumer reconstructs intent from transcripts plus its own application state.
   */
  offsetMs: number
}

/** A transcript fragment from either side of the conversation. */
export interface RealtimeTranscript {
  /** Which side spoke. */
  kind: 'input' | 'output'
  /** The fragment text. Deltas concatenate in arrival order. */
  text: string
  /** Whether this fragment closes the utterance. */
  final: boolean
}

/** Cumulative session usage. The protocol reports this in audio-seconds, not tokens. */
export interface RealtimeUsage {
  /** Cumulative audio seconds billed for this session. */
  seconds: number
}

/** Callbacks an adapter invokes for session lifetime events. */
export interface RealtimeSessionHandlers {
  /** The session is established and can accept audio. */
  onReady?(info: RealtimeSessionStarted): void
  /** A transcript fragment arrived. */
  onTranscript?(transcript: RealtimeTranscript): void
  /** The model delegated work to this application. */
  onDelegation?(delegation: RealtimeDelegation): void
  /** Cumulative usage was updated. */
  onUsage?(usage: RealtimeUsage): void
  /** Raw output audio, already decoded from the wire encoding. */
  onAudio?(pcm16: Uint8Array): void
  /** The session ended. `reason` is provider-supplied when available. */
  onClosed?(reason?: string): void
  /**
   * A session-scoped failure the adapter contained rather than throwing.
   *
   * Adapters report here for failures that occur *after* the session opened; failures that prevent
   * the session opening are thrown from `session()`.
   */
  onError?(error: Error): void
}

/** Facts about an established session. */
export interface RealtimeSessionStarted {
  /** The route that opened it. */
  provider: string
  /** The model the provider accepted — which may differ from the requested id if the provider aliases. */
  model: string
  /** The output voice the provider accepted. */
  voice?: string
  /** Audio encoding the session expects for input. */
  inputAudio: RealtimeAudioFormat
  /** Audio encoding the session emits. */
  outputAudio: RealtimeAudioFormat
}

/**
 * A live voice session.
 *
 * Implementations own the transport. Callers own the conversation: they push audio in, receive
 * callbacks, and answer delegations through the append methods.
 */
export interface RealtimeSession {
  /** Provider-assigned session identifier, for correlation in logs. */
  readonly id: string
  /** Facts the provider accepted at startup. */
  readonly started: RealtimeSessionStarted

  /**
   * Append one frame of microphone audio.
   *
   * There is deliberately **no end-of-utterance call**: endpointing belongs to the provider, and a
   * client-side detector would be a second, competing turn boundary. Frames are the only input.
   * @param pcm16 - raw samples in the session's `inputAudio` format.
   */
  sendAudio(pcm16: Uint8Array): void

  /** Stop the provider consuming microphone audio, without ending the session. */
  muteInput(): void

  /** Resume microphone consumption after {@link muteInput}. */
  unmuteInput(): void

  /**
   * Return a delegated result for the model to **speak aloud**.
   *
   * Resolves on the provider's **acknowledgement** when it answers a delegation. With no
   * `delegationId` there is no acknowledgement to wait for: the provider accepts a session-wide append
   * in silence, because it does not begin applying context at a bare `session.start`. That form
   * therefore resolves on the write and is **best-effort** — it is applied once audio has flowed, and
   * this seam cannot say when. It is not a way to speak unprompted.
   * @param content - plain text, non-empty and within {@link MAX_APPEND_CHARS}.
   * @param delegationId - the delegation this answers, or `undefined` for best-effort session context.
   */
  appendCommentary(content: string, delegationId?: string): Promise<void>

  /**
   * Add context the model may use **without speaking it** — progress, facts, intermediate state.
   *
   * With no `delegationId` this resolves on the write and is best-effort, for the reason recorded on
   * {@link appendCommentary}: the provider does not acknowledge a session-wide append.
   * @param content - plain text, non-empty and within {@link MAX_APPEND_CHARS}.
   * @param delegationId - the delegation this relates to, or `undefined` for best-effort session context.
   */
  appendThinking(content: string, delegationId?: string): Promise<void>

  /**
   * Steer the live conversation's behaviour (tone, brevity, policy) without speaking anything.
   *
   * With no `delegationId` this resolves on the write and is best-effort, for the reason recorded on
   * {@link appendCommentary}.
   * @param content - plain text, non-empty and within {@link MAX_APPEND_CHARS}.
   * @param delegationId - `undefined` for best-effort session-wide steering.
   */
  appendInstructions(content: string, delegationId?: string): Promise<void>

  /**
   * End the session and release the transport. Idempotent.
   * @returns a promise settling once the transport is released.
   */
  close(): Promise<void>
}

/**
 * Upper bound, in characters, on one context append.
 *
 * The provider's real limit is **500 tokens**, which this seam cannot count without binding to a
 * tokenizer it does not own. The character ceiling is therefore a deliberate conservative proxy:
 * it is enforced here so that an over-long append fails locally with a coded error rather than
 * halfway through a live conversation. Exact token accounting belongs to the adapter.
 */
export const MAX_APPEND_CHARS = 2000

/**
 * How one delegated turn ended, when the answer was not an answer.
 *
 * Carried so a refusal can be *described* rather than only counted. The four cases are the four
 * different things a person would do about it — nothing was asked, the controller refused (and said
 * why), or it was admitted and nothing came back in time — and collapsing them into one `undefined`
 * is what made the plugin's failures indistinguishable from outside it.
 */
export type RealtimeDelegationOutcome = 'answered' | 'declined' | 'refused' | 'timeout'

/**
 * One delegated turn, settled, reported for diagnostics.
 *
 * `reason` is present only on `refused`, and is **redacted** before it is emitted: this is the first
 * surface on which text the plugin did not author reaches a human, so it is safe by construction
 * rather than by a later pass.
 */
export interface RealtimeDelegationSettlement {
  /** The delegation this settles. Correlates with the ask, the answer and the journal. */
  readonly id: string
  /** The session that raised it. */
  readonly sessionId: string
  /** How it ended. */
  readonly outcome: RealtimeDelegationOutcome
  /** The controller's own reason, redacted, when the outcome is `refused`. */
  readonly reason?: string
}

/**
 * One progress step of a delegated turn, on its way to an ear or to the model's own context.
 *
 * The vocabulary of a **narration**, not of the protocol: the provider's append is the transport, and this
 * is what a plugin says through it. `channel` reuses the distinction the seam already carries on an answer
 * — `commentary` is spoken aloud, `thinking` is context the model may use without saying it — because
 * "spoken for milestones, silent for chatter" is a choice about that one field.
 *
 * Deliberately carries **no tool arguments, ever**. A step is derived from the tool's own *name* against a
 * configured phrase table; a tool's raw arguments are model-authored text, and the only model-authored text
 * that may reach a user's ear is the answer, which is redacted on the way out.
 *
 * How long the window lasts, and why a step is placed at all, is measured in
 * [`usable-window.md`](https://github.com/Travizm/dsh-openai-live/blob/main/docs/usable-window.md): a step
 * is placed while the session's timeline advances, which is while the client's microphone is streaming.
 */
export interface RealtimeDelegationProgress {
  /** The delegation this step belongs to. A step for an id nobody is waiting on is dropped. */
  readonly id: string
  /** `commentary` is spoken; `thinking` is context the model may keep to itself. */
  readonly channel: 'commentary' | 'thinking'
  /** The words — authored by configuration, never by the model. */
  readonly text: string
}
