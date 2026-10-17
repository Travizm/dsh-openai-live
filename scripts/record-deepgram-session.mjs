#!/usr/bin/env node
/**
 * Record a fixed workload: a real session, every frame in and out, with timestamps.
 *
 * The recording is the evidence P6 asks for — one fixed workload, measured once, from which both latency and cost
 * are computed by `scripts/deepgram-cost.mjs`. It is recorded from the **socket**, not from inside the adapter, so
 * what is captured is what actually crossed the wire: a fixture built from internal state could disagree with the
 * wire and nobody would know which was right.
 *
 * The workload is deliberately identical to `deepgram-input-smoke.mjs` — the same WAV, the same 20 ms pacing, the
 * same trailing silence — so two runs are comparable and a change in the numbers means a change in the system.
 *
 * usage:  set -a; . ./.env; set +a
 *         node scripts/record-deepgram-session.mjs [out.jsonl] [speech.wav]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { DeepgramAdapter, openWebSocket } from '../packages/realtime-deepgram/lib/index.js'

const OUT = process.argv[2] ?? '.recordings/deepgram-whats-the-weather.jsonl'
const WAV = process.argv[3] ?? new URL('../packages/realtime-deepgram/fixtures/whats-the-weather.wav', import.meta.url).pathname
const KEY = process.env.DEEPGRAM_API_KEY
if (KEY === undefined || KEY.trim().length === 0) {
  console.log('SKIPPED — set DEEPGRAM_API_KEY to record. Nothing was sent.')
  process.exit(0)
}

const entries = []
const record = entry => entries.push(entry)

/** Tee a socket into the recording. Every frame in and out passes through here. */
function recordingFactory(url, headers) {
  const socket = openWebSocket(url, headers)
  return {
    get readyState() { return socket.readyState },
    send(data) {
      const at = Date.now()
      if (typeof data === 'string') {
        try {
          const frame = JSON.parse(data)
          record({ at, direction: 'out', kind: frame.type ?? 'unknown' })
        } catch {
          record({ at, direction: 'out', kind: 'unparseable' })
        }
      } else {
        record({ at, direction: 'out', kind: 'audio', bytes: data.byteLength })
      }
      socket.send(data)
    },
    close() { socket.close() },
    on(event, listener) {
      if (event !== 'message') { socket.on(event, listener); return }
      // The `isBinary` flag has to be forwarded: a text frame arrives as a Buffer, so the flag is the only thing
      // that distinguishes "a frame" from "samples".
      socket.on('message', (data, isBinary) => {
        const at = Date.now()
        if (isBinary === true) {
          record({ at, direction: 'in', kind: 'audio', bytes: data.byteLength })
        } else {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
          try {
            const frame = JSON.parse(text)
            record({
              at,
              direction: 'in',
              kind: frame.type ?? 'unknown',
              ...(typeof frame.content === 'string' ? { text: frame.content } : {}),
            })
          } catch {
            record({ at, direction: 'in', kind: 'unparseable' })
          }
        }
        listener(data, isBinary)
      })
    },
  }
}

/** The PCM payload of a RIFF/WAVE file. */
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
}, recordingFactory)

const session = await adapter.session({ provider: 'deepgram', handlers: {} })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const FRAME_BYTES = (format.sampleRate * format.channels * (format.bits / 8) * 20) / 1000
for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
  session.sendAudio(new Uint8Array(pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length))))
  await sleep(20)
}
const silence = new Uint8Array(FRAME_BYTES)
for (let i = 0; i < 40; i += 1) { session.sendAudio(silence); await sleep(20) }
const deadline = Date.now() + 20_000
while (Date.now() < deadline && !entries.some(entry => entry.direction === 'in' && entry.kind === 'audio')) await sleep(200)
await sleep(800)
await session.close()

writeFileSync(OUT, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
console.log(`recorded ${entries.length} frames → ${OUT}`)
