/**
 * P6 — reading a recorded session: what it cost, and where the time went.
 *
 * A recording is the seam's own frames with timestamps, which is enough to answer both questions the chamber's
 * metric matrix asks: **cost per call-minute** (billed on connection time) and **turn latency** (measured from
 * the same bytes, so the number and the evidence cannot drift apart).
 *
 * Two deliberate positions:
 *
 * 1. **Cost is arithmetic over connection time, not an estimate of tokens.** Deepgram's Voice Agent API is billed
 *    "calculated based on websocket connection time" and includes STT, LLM and TTS orchestration — so the only
 *    input that matters is how long the socket was open, and adding a TTS line on top would double-count it.
 * 2. **The rate is a parameter, never a constant baked into a claim.** The published tiers differ by a third
 *    ($0.075 → $0.050 per minute), and which one applies depends on the composition. `VOICE_AGENT_RATES` carries
 *    the published figures with their source so a caller picks one and can see what it picked.
 *
 * @module dsh-realtime-deepgram/recording
 */

/** One frame in or out, with the instant it crossed the socket. */
export interface RecordingEntry {
  /** Milliseconds since the epoch. */
  readonly at: number
  /** `in` = provider → us, `out` = us → provider. */
  readonly direction: 'in' | 'out'
  /** Frame type for JSON frames, `audio` for bytes. */
  readonly kind: string
  /** Payload size, when the frame carried bytes. */
  readonly bytes?: number
  /** Utterance text, when the frame carried one. */
  readonly text?: string
}

/** Published Voice Agent rates, Pay As You Go, per minute of connection time. */
export const VOICE_AGENT_RATES = Object.freeze({
  /** Managed LLM and managed TTS — the default composition. */
  standard: 0.075,
  /** Bring your own TTS; Deepgram still orchestrates the LLM. */
  standardByoTts: 0.065,
  /** Bring your own LLM — the A′ topology, where DSH is the only brain. */
  byoLlm: 0.065,
  /** Bring your own LLM and TTS: Deepgram is a socket and a transcriber. */
  byoLlmAndTts: 0.050,
})

/** Which published rate applies to a composition. */
export type VoiceAgentTier = keyof typeof VOICE_AGENT_RATES

/** The source of the rates above, so a number in a report can be traced. */
export const RATES_SOURCE = 'deepgram.com/pricing — Voice Agent API, Pay As You Go, accessed 2026-10-17'

/** What a recording says. */
export interface RecordingSummary {
  /** How long the socket was open: the billed quantity. */
  readonly connectionMs: number
  /** Frames received, and bytes of output audio among them. */
  readonly framesIn: number
  readonly outputAudioBytes: number
  /** Frames sent, and bytes of input audio among them. */
  readonly framesOut: number
  readonly inputAudioBytes: number
  /** Milliseconds from the first entry to the first output audio — the first audible response. */
  readonly firstAudioMs?: number
  /** Every transcript text observed, in arrival order. */
  readonly transcripts: readonly string[]
}

/** Milliseconds of linear16 audio at a known rate. */
export function audioMs(bytes: number, sampleRate: number, channels = 1): number {
  // 16-bit samples: two bytes per sample per channel.
  return (bytes / (sampleRate * channels * 2)) * 1000
}

/**
 * Summarise a recording.
 *
 * `connectionMs` runs from the **first** entry to the **last**, which is the closest a frame log gets to socket
 * lifetime: frames stop when the socket does, and an idle socket bills without producing any.
 */
export function summarise(entries: readonly RecordingEntry[]): RecordingSummary {
  if (entries.length === 0) {
    return { connectionMs: 0, framesIn: 0, outputAudioBytes: 0, framesOut: 0, inputAudioBytes: 0, transcripts: [] }
  }
  const first = Math.min(...entries.map(entry => entry.at))
  const last = Math.max(...entries.map(entry => entry.at))
  const incoming = entries.filter(entry => entry.direction === 'in')
  const outgoing = entries.filter(entry => entry.direction === 'out')
  const firstAudio = incoming.find(entry => entry.kind === 'audio')
  return {
    connectionMs: last - first,
    framesIn: incoming.length,
    outputAudioBytes: incoming.filter(entry => entry.kind === 'audio').reduce((total, entry) => total + (entry.bytes ?? 0), 0),
    framesOut: outgoing.length,
    inputAudioBytes: outgoing.filter(entry => entry.kind === 'audio').reduce((total, entry) => total + (entry.bytes ?? 0), 0),
    ...(firstAudio === undefined ? {} : { firstAudioMs: firstAudio.at - first }),
    // Utterances, from `ConversationText` only. `History` frames echo the same words as durable records, so
    // collecting text from every frame that carries it lists each sentence twice — measured on a real recording
    // before this filter existed, where a two-turn session reported four lines.
    transcripts: incoming
      .filter(entry => entry.kind === 'ConversationText' && entry.text !== undefined)
      .map(entry => entry.text as string),
  }
}

/**
 * What a session cost.
 *
 * `connectionMs` is billed in whole minutes here because that is how the published rate is quoted; a per-second
 * pro-rata would be an assumption about the invoice that the pricing page does not make.
 */
export function cost(summary: RecordingSummary, tier: VoiceAgentTier): number {
  const minutes = summary.connectionMs / 60_000
  return Number((minutes * VOICE_AGENT_RATES[tier]).toFixed(6))
}
