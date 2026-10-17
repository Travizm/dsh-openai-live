#!/usr/bin/env node
/**
 * The microphone half of the live proof: real speech in, a real answer out.
 *
 * `deepgram-session-smoke.mjs` proved the outbound path (settings, injection, TTS). This proves the **inbound**
 * one — `sendAudio` — which no test and no previous run had exercised against the provider:
 *
 *   a WAV of speech → 20 ms frames → session.sendAudio → provider STT → turn → answer → transcripts + audio
 *
 * Why 20 ms frames: it is the pacing a capture device produces, and it is what the seam's "frames are the only
 * input" rule assumes. Sending the file in one burst would test a path no real microphone ever takes.
 *
 * Why trailing silence: end-of-turn detection belongs to the provider (Flux EOT). Without silence after the
 * speech there is no endpoint, so there is no turn — and a run that reported "no transcript" would be reporting
 * its own missing silence rather than a broken adapter.
 *
 * usage:  set -a; . ./.env; set +a
 *         node scripts/deepgram-input-smoke.mjs [path/to/speech.wav]
 * exit:   0 = an answer came back · 1 = established but no answer · 2 = the session failed to establish
 */
import { readFileSync } from 'node:fs'
import { DeepgramAdapter, openWebSocket } from '../packages/realtime-deepgram/lib/index.js'

const WAV = process.argv[2] ?? new URL('../packages/realtime-deepgram/fixtures/whats-the-weather.wav', import.meta.url).pathname
const KEY = process.env.DEEPGRAM_API_KEY
if (KEY === undefined || KEY.trim().length === 0) {
  console.log('SKIPPED — set DEEPGRAM_API_KEY to run the input smoke. Nothing was sent.')
  process.exit(0)
}

/** Read the PCM payload out of a RIFF/WAVE file. Returns the samples and the format. */
function readWav(path) {
  const buffer = readFileSync(path)
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`)
  }
  let offset = 12
  let format
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      }
    }
    if (id === 'data') return { format, pcm: buffer.subarray(body, body + size) }
    offset = body + size + (size % 2)
  }
  throw new Error(`${path} has no data chunk`)
}

const { format, pcm } = readWav(WAV)
if (format.sampleRate !== 16_000 || format.channels !== 1 || format.bits !== 16) {
  // The Settings declare 16 kHz mono linear16; sending anything else is a session that hears noise.
  console.log(`FAILED — ${WAV} is ${format.sampleRate} Hz / ${format.channels} ch / ${format.bits}-bit; need 16000/1/16`)
  process.exit(2)
}

const transcripts = []
const errors = []
let audioBytes = 0
const adapter = new DeepgramAdapter(
  {
    apiKey: KEY,
    think: { model: 'gpt-4o-mini', prompt: 'You are a terse voice assistant. Answer in one short sentence.' },
    listen: { model: 'flux-general-en' },
    speak: { model: 'aura-2-thalia-en' },
    establishTimeoutMs: 20_000,
  },
  openWebSocket,
)

let session
try {
  session = await adapter.session({
    provider: 'deepgram',
    handlers: {
      onAudio: bytes => { audioBytes += bytes.byteLength },
      onTranscript: transcript => { transcripts.push(`${transcript.kind}: ${transcript.text}`) },
      onError: error => { errors.push(error.message) },
    },
  })
} catch (error) {
  console.log(`FAILED to establish: ${error.message}`)
  process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const FRAME_MS = 20
const FRAME_BYTES = (format.sampleRate * format.channels * (format.bits / 8) * FRAME_MS) / 1000 // 640 bytes

// Speech, paced as a capture device would deliver it.
for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
  session.sendAudio(new Uint8Array(pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length))))
  await sleep(FRAME_MS)
}
// Trailing silence, so the provider's end-of-turn detector has something to detect.
const silence = new Uint8Array(FRAME_BYTES)
for (let i = 0; i < 40; i += 1) { session.sendAudio(silence); await sleep(FRAME_MS) }

const deadline = Date.now() + 25_000
while (Date.now() < deadline && !transcripts.some(t => t.startsWith('output:'))) await sleep(200)
await sleep(500)
await session.close()

console.log('')
console.log(`heard        ${transcripts.filter(t => t.startsWith('input:')).join(' · ') || 'nothing'}`)
console.log(`answered     ${transcripts.filter(t => t.startsWith('output:')).join(' · ') || 'nothing'}`)
console.log(`audio        ${audioBytes} bytes back`)
if (errors.length > 0) console.log(`errors       ${errors.join(' · ')}`)
console.log('')
const answered = transcripts.some(t => t.startsWith('output:'))
if (!answered) {
  console.log('FAILED — the speech was sent but no answer came back')
  process.exit(1)
}
console.log('PASS — speech in through sendAudio, transcript out, answer spoken back')
