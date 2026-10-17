/**
 * Translation from the Deepgram wire vocabulary to the seam's — pure, one parsed frame in, one seam value out.
 *
 * Every function validates the fields it reads and returns `undefined` when a frame is not usable, so a provider
 * change degrades to an ignored frame rather than a half-built value inside a consumer. That is the same
 * discipline as the OpenAI adapter's translation, and it is what makes this layer verifiable against the
 * recorded session in `docs/p1-wire-probe-results.md` with no key and no network.
 *
 * The three facts from P1 that shape the translations:
 *
 * 1. **`ConversationText` is one whole utterance, not a delta.** So every transcript leaves here `final: true`,
 *    and the seam's `transcriptDeltas: false` declaration is honest rather than aspirational.
 * 2. **`LatencyReport` exists and carries provider-reported stage timings.** Mapping it means ADR-012's
 *    per-stage instrument is partly *reported* on this provider rather than reconstructed from journal entries.
 * 3. **`PromptUpdated` / `ThinkUpdated` mark the moment an update is in force.** A turn started before the ack
 *    runs under the old prompt — so the ack is translated as a first-class signal, not swallowed as noise.
 *
 * @module dsh-realtime-deepgram/events
 */
import type { RealtimeTranscript } from 'dsh-realtime'
import { PROMPT_ACK, THINK_ACK } from './wire.ts'
import type { ConversationTextFrame, LatencyReportFrame, ServerFrame } from './wire.ts'

/** A provider-reported stage timing, in seconds. */
export interface StageLatency {
  /** `total_latency` when the provider sent it. */
  readonly totalMs?: number
  /** Time to first token. */
  readonly firstTokenMs?: number
  /** Text-to-speech synthesis time. */
  readonly speakMs?: number
}

/** Which configuration an acknowledgement applies to. */
export type UpdateAck = 'prompt' | 'think'

function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : undefined
}

/**
 * Translate one utterance.
 *
 * `final` is always `true`: this provider does not stream partial transcripts, so a fragment marked otherwise
 * would invite a consumer to concatenate utterances into one.
 */
export function toTranscript(frame: ServerFrame): RealtimeTranscript | undefined {
  if (frame.type !== 'ConversationText') return undefined
  const { role, content } = frame as ConversationTextFrame
  if (role !== 'user' && role !== 'assistant') return undefined
  if (typeof content !== 'string' || content.trim().length === 0) return undefined
  return { kind: role === 'user' ? 'input' : 'output', text: content, final: true }
}

/**
 * Translate a provider latency report.
 *
 * Returns `undefined` when no stage number is present — a `LatencyReport` carrying only fields this mapping does
 * not know would otherwise become `{}` and be counted as a measurement.
 */
export function toLatency(frame: ServerFrame): StageLatency | undefined {
  if (frame.type !== 'LatencyReport') return undefined
  const report = frame as LatencyReportFrame
  const totalMs = seconds(report.total_latency)
  // `ttt_token_latency` is the first-token figure; `ttt_text_latency` is its sibling at the text boundary. Take
  // the token one first because that is the number a turn's latency is measured against.
  const firstTokenMs = seconds(report.ttt_token_latency) ?? seconds(report.ttt_text_latency)
  const speakMs = seconds(report.tts_latency)
  if (totalMs === undefined && firstTokenMs === undefined && speakMs === undefined) return undefined
  return {
    ...(totalMs === undefined ? {} : { totalMs }),
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    ...(speakMs === undefined ? {} : { speakMs }),
  }
}

/** Which update an acknowledgement settles, or `undefined` if the frame is not one. */
export function toUpdateAck(frame: ServerFrame): UpdateAck | undefined {
  if (frame.type === PROMPT_ACK) return 'prompt'
  if (frame.type === THINK_ACK) return 'think'
  return undefined
}

/** The provider declined an injected line. The text is the provider's own, and is passed through unchanged. */
export function toInjectionRefusal(frame: ServerFrame): string | undefined {
  if (frame.type !== 'InjectionRefused') return undefined
  const message = frame['message']
  return typeof message === 'string' && message.trim().length > 0 ? message : 'the provider refused the injected message'
}

/**
 * A provider error, as the description it sent.
 *
 * The first version of the P1 probe sent `listen.provider.type: 'flux'`, connected successfully, and then
 * received exactly one of these — "Check the agent.listen.provider.type field against the API spec" — which is
 * the only reason the mistake was findable at all. An adapter that dropped `Error` frames would have shown a
 * session that connected and did nothing.
 */
export function toProviderError(frame: ServerFrame): string | undefined {
  if (frame.type !== 'Error') return undefined
  const description = frame['description']
  return typeof description === 'string' && description.trim().length > 0 ? description : 'the provider reported an error'
}
