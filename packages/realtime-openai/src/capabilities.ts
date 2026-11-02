/**
 * GPT-Live-1 (client delegation), declared from the adapter's own behaviour and the measured probe.
 *
 * Every value is traceable to `packages/realtime-openai/src/session.ts` — which is the question a capability
 * matrix answers, per the precedent recorded for `inputMute`: the matrix describes **the seam's method**, not the
 * provider's vocabulary — and to `docs/protocol.md` / the measured tables in
 * `dsh-plugin-development/references/live-protocol-probes.md`.
 *
 * - `appendThinking: true` — the same acked append path as commentary; 25 of 25 silent thinking appends were
 *   placed across 24 s while the model generated nothing.
 * - `appAuthoredSpeech: true` — client delegation is exactly the mode in which the application writes the words
 *   the model speaks (ADR-001). The app is the author here, which is why this is `true` on this provider and
 *   `false` on Deepgram.
 * - `injectLine: true` — a line the application chose is appended as commentary, which this provider then speaks.
 *   The weaker promise is available too, so narration is portable across both routes.
 * - `functionCalls: false` — there is no function channel in client mode, and `response.item.create` is refused
 *   outright: *"requires Responses delegation"*. That family is a separate capability, never switched on here.
 * - `usageReporting: true` — `session.usage.updated` arrives every ~15 s with cumulative audio-seconds (measured
 *   14.95–15.10 s), and the closing frame carries the final total.
 * - `transcriptDeltas: true` — `session.input_transcript.delta` and `session.output_transcript.delta` are
 *   incremental, which is why the seam's `final` flag is meaningful on this provider.
 * - `inputMute: true` — implemented as the provider's own `input_audio.mute` / `.unmute` frames.
 * - `promptUpdate: 'append'` — `session.instructions.append` is append-shaped by vocabulary, and each append is
 *   acknowledged (`session.instructions.appended`). Recorded as vocabulary-and-probe evidence, **not** as a
 *   BYO-endpoint read of the provider's outgoing prompt: that instrument was used for Deepgram (P1c) and has not
 *   been used here.
 */
import type { RealtimeCapabilities } from 'dsh-realtime'

export const OPENAI_CAPABILITIES: RealtimeCapabilities = Object.freeze({
  appendThinking: true,
  appAuthoredSpeech: true,
  injectLine: true,
  functionCalls: false,
  usageReporting: true,
  transcriptDeltas: true,
  inputMute: true,
  promptUpdate: 'append',
})
