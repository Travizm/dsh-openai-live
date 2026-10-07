/**
 * The wire: client frame builders and a tolerant server-frame reader.
 *
 * Every event name and field here was **observed on a live session** on 2026-10-07; see
 * `docs/protocol.md` in the repository root and `tests/fixtures/live-session.jsonl`, which is the
 * recorded session these builders were exercised against.
 *
 * Two deliberate asymmetries:
 *
 * - **Client frames are built strictly** — a caller cannot send a field the protocol rejects.
 * - **Server frames are parsed loosely and validated where they are consumed.** The endpoint rejects
 *   unknown *client* fields, but a server may add event types, so an unknown type must be ignorable
 *   rather than fatal. The drift canary is what turns "ignored" into "noticed".
 *
 * @module dsh-realtime-openai/wire
 */

/** Every server event type this adapter knows how to read. */
export const KNOWN_SERVER_EVENT_TYPES = [
  'session.started',
  'session.input_transcript.delta',
  'session.output_transcript.delta',
  'session.output_audio.delta',
  'session.delegation.created',
  'session.instructions.appended',
  'session.thinking.appended',
  'session.commentary.appended',
  'session.usage.updated',
  'session.closed',
  'error',
] as const

/** One known server event type. */
export type KnownServerEventType = (typeof KNOWN_SERVER_EVENT_TYPES)[number]

/** The provider's account usage report. Audio-seconds, not tokens. */
export interface WireUsage {
  /** Cumulative audio seconds. */
  seconds?: number
}

/** `session.started` — the configuration the provider accepted. */
export interface WireSessionStarted {
  type: 'session.started'
  session?: {
    model?: string
    audio?: { output?: { voice?: string } }
    delegation?: unknown
  }
}

/** A transcript fragment from either side. */
export interface WireTranscriptDelta {
  type: 'session.input_transcript.delta' | 'session.output_transcript.delta'
  delta?: string
  /** Provider-supplied position on the session timeline, when present. */
  start_ms?: number
  end_ms?: number
}

/** One frame of provider output audio. */
export interface WireOutputAudioDelta {
  type: 'session.output_audio.delta'
  /** Base64 mono 24 kHz signed PCM16, little-endian. */
  delta?: string
}

/** A unit of work the model handed to this application. */
export interface WireDelegationCreated {
  type: 'session.delegation.created'
  offset_ms?: number
  delegation?: { id?: string; type?: string; target?: string }
  event_id?: string
}

/** Acknowledgement that one context append was accepted. */
export interface WireAppended {
  type: 'session.instructions.appended' | 'session.thinking.appended' | 'session.commentary.appended'
  /** Echo of the `event_id` the client sent, when the provider supplies it. */
  client_event_id?: string
}

/** Cumulative usage update. */
export interface WireUsageUpdated {
  type: 'session.usage.updated'
  usage?: WireUsage
}

/** Graceful close. */
export interface WireClosed {
  type: 'session.closed'
  reason?: string
  usage?: WireUsage
}

/** A provider-reported failure. */
export interface WireErrorEvent {
  type: 'error'
  error?: {
    type?: string
    code?: string | null
    message?: string
    param?: string | null
  }
}

/** Any server frame whose `type` is one this adapter reads. */
export type WireServerEvent =
  | WireSessionStarted
  | WireTranscriptDelta
  | WireOutputAudioDelta
  | WireDelegationCreated
  | WireAppended
  | WireUsageUpdated
  | WireClosed
  | WireErrorEvent

/** A parsed frame: `type` is guaranteed, the rest is validated at the point of use. */
export type ParsedServerEvent = { type: string } & Record<string, unknown>

/**
 * Parse one server frame.
 *
 * Returns `null` for anything that is not a JSON object carrying a non-empty string `type`. A frame
 * that parses but whose `type` is unknown is returned as-is: the caller ignores it, and the drift
 * canary is responsible for noticing. Silently dropping an unparseable frame is deliberate —
 * a malformed frame is not a session failure, and throwing here would turn provider noise into an
 * outage.
 * @param frame - one complete text frame.
 * @returns the parsed event, or `null` when it is not usable.
 */
export function parseServerEvent(frame: string): ParsedServerEvent | null {
  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string' || type.length === 0) return null
  return value as ParsedServerEvent
}

/** Narrow one parsed frame to a known event type. */
export function isKnownServerEvent(event: ParsedServerEvent): event is ParsedServerEvent & WireServerEvent {
  return (KNOWN_SERVER_EVENT_TYPES as readonly string[]).includes(event.type)
}

/**
 * The session-opening frame.
 *
 * `audio.output.voice` is omitted rather than sent as `undefined` when the caller wants the provider
 * default — the endpoint rejects unknown fields outright, so an accidental `null` is a failed session.
 * @param model - exact model id.
 * @param instructions - opening instructions, when supplied.
 * @param voice - output voice, when supplied.
 * @returns the serialized `session.start` frame.
 */
export function sessionStart(model: string, instructions?: string, voice?: string): string {
  return JSON.stringify({
    type: 'session.start',
    session: {
      model,
      ...instructions === undefined ? {} : { instructions },
      ...voice === undefined ? {} : { audio: { output: { voice } } },
      // Client delegation: this application is the delegate. The mode is fixed for the session.
      delegation: { type: 'client' },
    },
  })
}

/**
 * Append one frame of microphone audio.
 *
 * There is deliberately no `session.input_audio.commit` builder: that event does not exist, and
 * endpointing belongs to the provider.
 * @param audioBase64 - base64 PCM16 in the session's declared input format.
 * @returns the serialized frame.
 */
export function inputAudioAppend(audioBase64: string): string {
  return JSON.stringify({ type: 'session.input_audio.append', audio: audioBase64 })
}

/** Stop the provider consuming microphone audio without ending the session. */
export function inputAudioMute(): string {
  return JSON.stringify({ type: 'session.input_audio.mute' })
}

/** Resume microphone consumption after {@link inputAudioMute}. */
export function inputAudioUnmute(): string {
  return JSON.stringify({ type: 'session.input_audio.unmute' })
}

/** The three context appends. `null` `delegation_id` means session-wide context. */
export type AppendKind = 'instructions' | 'thinking' | 'commentary'

/**
 * Build one context-append frame.
 * @param kind - which append to send.
 * @param content - plain text, already bounded by the caller.
 * @param delegationId - the delegation this answers, or `null` for session-wide context.
 * @param eventId - client correlation id, echoed back as `client_event_id` on the acknowledgement.
 * @returns the serialized frame.
 */
export function contextAppend(kind: AppendKind, content: string, delegationId: string | null, eventId: string): string {
  return JSON.stringify({
    type: `session.${kind}.append`,
    content,
    delegation_id: delegationId,
    event_id: eventId,
  })
}

/** Ask the provider to end the session gracefully. */
export function sessionClose(): string {
  return JSON.stringify({ type: 'session.close' })
}
