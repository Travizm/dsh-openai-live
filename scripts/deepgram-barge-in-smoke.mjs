#!/usr/bin/env node
/**
 * Barge-in: speech arriving while the agent is speaking.
 *
 * Nothing so far has tested the one interaction a person actually has with a voice agent — interrupting it. This
 * asks the agent to speak a long line, waits until it is audibly mid-sentence, then streams the user's speech into
 * the socket while the agent is still talking, and reports what the provider did:
 *
 *   1. did `UserStartedSpeaking` arrive **while agent audio was still coming**? (barge-in detected)
 *   2. did the agent's audio stop, or did it talk over the interruption?
 *   3. did the interruption become a turn — a new `ConversationText` after it?
 *
 * It is recorded from the socket (the same tee as `record-deepgram-session.mjs`) because the interesting events —
 * `UserStartedSpeaking`, `EndOfTurn`, `AgentAudioDone` — are ones the seam's handler surface does not expose. A
 * report built only from `onTranscript` would say "a transcript arrived" and prove nothing about interruption.
 *
 * What it does not cover: a real capture device. Frames are paced like one, but device resampling and mic latency
 * need hardware.
 *
 * usage:  set -a; . ./.env; set +a
 *         node scripts/deepgram-barge-in-smoke.mjs [speech.wav]
 * exit:   0 = barge-in detected · 1 = no interruption observed · 2 = the session failed to establish
 */
import { readFileSync } from 'node:fs'
import { DeepgramAdapter, openWebSocket } from '../packages/realtime-deepgram/lib/index.js'

const WAV = process.argv[2] ?? new URL('../packages/realtime-deepgram/fixtures/whats-the-weather.wav', import.meta.url).pathname
const KEY = process.env.DEEPGRAM_API_KEY
if (KEY === undefined || KEY.trim().length === 0) {
  console.log('SKIPPED — set DEEPGRAM_API_KEY to run the barge-in smoke. Nothing was sent.')
  process.exit(0)
}

const events = []
const at = () => Date.now()
let outputAudioBytes = 0
/** The instant the interruption began, so "audio after it" is a measurement rather than an impression. */
let bargedAt

function teeFactory(url, headers) {
  const socket = openWebSocket(url, headers)
  return {
    send(data) {
      if (typeof data !== 'string') { socket.send(data); return }
      try { events.push({ at: at(), dir: 'out', type: JSON.parse(data).type ?? 'unknown' }) } catch { /* ignore */ }
      socket.send(data)
    },
    close() { socket.close() },
    on(event, listener) {
      if (event !== 'message') { socket.on(event, listener); return }
      socket.on('message', (data, isBinary) => {
        if (isBinary === true) {
          outputAudioBytes += data.byteLength
          events.push({ at: at(), dir: 'in', type: 'audio', bytes: data.byteLength })
          return
        }
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
        try {
          const frame = JSON.parse(text)
          events.push({ at: at(), dir: 'in', type: frame.type, ...(frame.content ? { content: frame.content } : {}) })
        } catch { /* ignore */ }
        listener(data, isBinary)
      })
    },
  }
}

function readWav(path) {
  const buffer = readFileSync(path)
  let offset = 12
  let format
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') format = { channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) }
    if (id === 'data') return { format, pcm: buffer.subarray(body, body + size) }
    offset = body + size + (size % 2)
  }
  throw new Error(`${path} has no data chunk`)
}

const { format, pcm } = readWav(WAV)
const adapter = new DeepgramAdapter({
  apiKey: KEY,
  think: { model: 'gpt-4o-mini', prompt: 'You are a terse voice assistant. Answer in one short sentence.' },
  listen: { model: 'flux-general-en' },
  speak: { model: 'aura-2-thalia-en' },
  establishTimeoutMs: 20_000,
}, teeFactory)

let session
try {
  session = await adapter.session({ provider: 'deepgram', handlers: {} })
} catch (error) {
  console.log(`FAILED to establish: ${error.message}`)
  process.exit(2)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A long line, so the agent is still speaking when the interruption arrives.
await session.appendCommentary('Please count slowly from one to twenty, one number per second, with a short pause between each.')

// Wait until the agent is audibly mid-line: some audio, but not all of it.
for (let i = 0; i < 100 && outputAudioBytes < 30_000; i += 1) await sleep(100)
const audioBeforeBarge = outputAudioBytes

bargedAt = at()
const FRAME_BYTES = (format.sampleRate * format.channels * (format.bits / 8) * 20) / 1000
for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
  session.sendAudio(new Uint8Array(pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length))))
  await sleep(20)
}
const silence = new Uint8Array(FRAME_BYTES)
for (let i = 0; i < 40; i += 1) { session.sendAudio(silence); await sleep(20) }
const audioAfterBargeStart = outputAudioBytes

// Give the provider a moment to act on the interruption.
await sleep(4_000)
const audioAfterBargeEnd = outputAudioBytes
await session.close()

const during = events.filter(event => event.at >= bargedAt)
// Truncation is a question about a window, not a total: how much audio arrived in the 600 ms after the provider
// registered the interruption, against the 600 ms before it. A total conflates "stopped" with "finished the
// sentence and then answered the new question", which are different behaviours.
const detectedAt = during.find(event => event.type === 'UserStartedSpeaking')?.at
const windowBytes = (from, to) => events
  .filter(event => event.type === 'audio' && event.at >= from && event.at < to)
  .reduce((total, event) => total + (event.bytes ?? 0), 0)
const before = detectedAt === undefined ? 0 : windowBytes(detectedAt - 600, detectedAt)
const after = detectedAt === undefined ? 0 : windowBytes(detectedAt, detectedAt + 600)
const spokeDuring = during.filter(event => event.type === 'UserStartedSpeaking')
const transcriptAfter = during.filter(event => event.type === 'ConversationText' && typeof event.content === 'string')
const audioAfter = audioAfterBargeEnd - audioAfterBargeStart

console.log('')
console.log(`agent audio   ${audioBeforeBarge} bytes before the interruption · ${audioAfter} more after it`)
console.log(`interruption  ${spokeDuring.length} UserStartedSpeaking event(s) during the barge-in`)
console.log(`turns         ${transcriptAfter.length === 0 ? 'none' : transcriptAfter.map(e => `"${e.content}"`).join(' · ')}`)
const latency = spokeDuring.length > 0 ? spokeDuring[0].at - bargedAt : undefined
console.log(`detected      ${latency === undefined ? 'no' : `${latency} ms after the first frame of user speech`}`)
console.log('')
if (spokeDuring.length === 0) {
  console.log('FAILED — the provider did not register speech during the agent’s turn')
  process.exit(1)
}
console.log(`window        600 ms before detection: ${before} bytes · 600 ms after: ${after} bytes`)
console.log('')
if (after <= before * 0.25) {
  console.log('PASS — the agent yielded the floor: audio fell away once the interruption was registered')
} else {
  console.log('PARTIAL — the interruption was registered and became a turn, but the agent kept speaking over it')
}
