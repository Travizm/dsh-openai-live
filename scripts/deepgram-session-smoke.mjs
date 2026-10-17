#!/usr/bin/env node
/**
 * The live end-to-end smoke: the real adapter, the real socket factory, the real provider.
 *
 * What it proves, in order:
 *
 *   1. the credential works and the `Settings` frame is **accepted** (the adapter's establishment gate returns,
 *      rather than failing on a provider `Error` frame — which is what the first P1 run did);
 *   2. the transport routes text frames to the seam and binary frames to the audio handler;
 *   3. speaking works end to end: `appendCommentary` injects a line, the agent says it, and audio bytes arrive.
 *
 * What it does not prove: microphone input (there is no capture device here), and anything about prompt updates.
 * Those need a human at a microphone, and saying so is the difference between a smoke test and a claim.
 *
 * It never runs in the gate — it needs a key and spends credit — and self-skips without `DEEPGRAM_API_KEY`,
 * exiting 0 so a fork stays green.
 *
 * usage:  set -a; . ./.env; set +a; node scripts/deepgram-session-smoke.mjs
 * exit:   0 = established and audio arrived · 1 = audio never arrived · 2 = the session failed to establish
 */
import { DeepgramAdapter, openWebSocket } from '../packages/realtime-deepgram/lib/index.js'

const KEY = process.env.DEEPGRAM_API_KEY
if (KEY === undefined || KEY.trim().length === 0) {
  console.log('SKIPPED — set DEEPGRAM_API_KEY to run the live smoke. Nothing was sent.')
  process.exit(0)
}

const frames = new Map()
let audioBytes = 0
let audioFrames = 0
const transcripts = []
const errors = []

const adapter = new DeepgramAdapter(
  {
    apiKey: KEY,
    think: { model: 'gpt-4o-mini', prompt: 'You are a probe. Reply with exactly: probe one.' },
    listen: { model: 'flux-general-en' },
    speak: { model: 'aura-2-thalia-en' },
    establishTimeoutMs: 20_000,
  },
  openWebSocket,
)

const started = Date.now()
let session
try {
  session = await adapter.session({
    provider: 'deepgram',
    handlers: {
      onAudio: bytes => { audioBytes += bytes.byteLength; audioFrames += 1 },
      onTranscript: transcript => { transcripts.push(`${transcript.kind}: ${transcript.text}`) },
      onError: error => { errors.push(error.message) },
    },
  })
} catch (error) {
  console.log(`FAILED to establish: ${error.message}`)
  process.exit(2)
}
const establishedMs = Date.now() - started

// The seam's `appendCommentary` is this provider's `InjectAgentMessage`: it makes the agent say something. If
// audio comes back, listen → think → speak all worked through the adapter.
await session.appendCommentary('Say exactly: probe one.')

const deadline = Date.now() + 15_000
while (Date.now() < deadline && audioBytes === 0) await new Promise(resolve => setTimeout(resolve, 100))
await new Promise(resolve => setTimeout(resolve, 500))
await session.close()

console.log('')
console.log(`established  ${establishedMs} ms · provider=${session.started.provider} model=${session.started.model} voice=${session.started.voice}`)
console.log(`audio        ${audioFrames} frame(s), ${audioBytes} bytes`)
console.log(`transcripts  ${transcripts.length === 0 ? 'none' : transcripts.join(' · ')}`)
if (errors.length > 0) console.log(`errors       ${errors.join(' · ')}`)
console.log('')
if (audioBytes === 0) {
  console.log('FAILED — the session established but no audio arrived')
  process.exit(1)
}
console.log('PASS — settings accepted, injected line spoken, audio returned through the adapter')
