#!/usr/bin/env node
/**
 * W1 milestone 2 (v4) — the delegation envelope, closed.
 *
 * v3 established that `response.item.create` / `response.create` require **Responses** delegation
 * ("response.item.create requires Responses delegation."). DSH is an external agent, so this plugin
 * uses **client** delegation, where the documented reply path is:
 *
 *   session.thinking.append    — silent context the model may use (progress, facts)
 *   session.commentary.append  — a result the model should say aloud (<= 500 tokens)
 *   session.instructions.append— steer the live conversation's behaviour
 *
 * each carrying `delegation_id` (= `event.delegation.id`, or null for session-wide context) and
 * acknowledged by a matching `session.*.appended`. This run exercises all three and records the acks.
 */
import WebSocket from 'ws'
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'

const ENDPOINT = 'wss://api.openai.com/v1/live/sessions'
const KEY = process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY
const PCM_PATH = process.argv[2]
const EVIDENCE = process.argv[3] || 'spike/evidence/w1-m4-events.jsonl'
const SAMPLE_RATE = 24_000
const FRAME_MS = 50
const BYTES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000 * 2
const TAIL_MS = 30_000

const COMMENTARY = 'Staging is healthy: 3 of 3 replicas running, no failed deploys in the last 24 hours.'

if (!KEY) { console.error('no key in env'); process.exit(2) }
if (!PCM_PATH) { console.error('usage: node spike/live-session.mjs <pcm16-24k-mono> [evidence.jsonl]'); process.exit(2) }

const pcm = readFileSync(PCM_PATH)
writeFileSync(EVIDENCE, '')
const t0 = Date.now()
const record = (dir, obj) => appendFileSync(EVIDENCE, JSON.stringify({ t: Date.now() - t0, dir, ...obj }) + '\n')
const stamp = () => `[${String(Date.now() - t0).padStart(6)}ms]`

const counts = new Map()
const transcripts = { input: '', output: '' }
let framesSent = 0, outBytes = 0, delegations = 0
const acks = {}

const INSTRUCTIONS = [
  'You are a voice connectivity probe.',
  'You have no tools and no knowledge of this system. You cannot look anything up yourself.',
  'When the user asks you to check, look up, or retrieve anything, you MUST delegate that',
  'request to the client, then speak the result you are given, word for word.',
].join(' ')

console.log(`utterance: ${PCM_PATH} — ${(pcm.length / (SAMPLE_RATE * 2)).toFixed(2)}s`)
console.log(`evidence:  ${EVIDENCE}\n`)

const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } })
const send = (o) => { record('out', { event: o }); ws.send(JSON.stringify(o)) }
const bump = (t) => counts.set(t, (counts.get(t) ?? 0) + 1)
let timer = setTimeout(() => finish(1, 'TIME OUT'), TAIL_MS + 20_000)

function finish(code, why) {
  clearTimeout(timer)
  console.log(`\n--- summary (${why}) ---`)
  console.log('events:        ', [...counts].map(([k, v]) => `${k}×${v}`).join('  ') || '(none)')
  console.log(`audio sent/recv: ${(framesSent * FRAME_MS / 1000).toFixed(2)}s / ${(outBytes / (SAMPLE_RATE * 2)).toFixed(2)}s`)
  console.log(`delegations:    ${delegations}`)
  console.log('acks observed:  ', JSON.stringify(acks))
  console.log('in  transcript: ', JSON.stringify(transcripts.input))
  console.log('out transcript: ', JSON.stringify(transcripts.output))
  try { ws.close() } catch {}
  process.exit(code)
}

ws.on('open', () => {
  console.log(`${stamp()} socket open`)
  send({
    type: 'session.start',
    session: {
      model: 'gpt-live-1',
      instructions: INSTRUCTIONS,
      audio: { output: { voice: 'marin' } },
      delegation: { type: 'client' },
    },
  })
})

ws.on('message', (buf) => {
  let ev
  try { ev = JSON.parse(buf.toString()) } catch { return }
  const type = ev.type || '(untyped)'
  bump(type)
  record('in', { event: ev })

  switch (type) {
    case 'session.started':
      console.log(`${stamp()} <- session.started — streaming ${(pcm.length / (SAMPLE_RATE * 2)).toFixed(2)}s`)
      if (framesSent === 0) {
        streamAudio()
        // session-wide context (delegation_id: null) — steers behaviour, says nothing aloud
        send({ type: 'session.instructions.append', delegation_id: null, content: 'Keep replies to one short sentence.' })
      }
      return

    case 'session.output_audio.delta':
      outBytes += Buffer.from(String(ev.delta ?? ''), 'base64').length
      return

    case 'session.input_transcript.delta':
      transcripts.input += ev.delta ?? ''
      return

    case 'session.output_transcript.delta':
      transcripts.output += ev.delta ?? ''
      console.log(`${stamp()} <- out: ${JSON.stringify(ev.delta ?? '')}`)
      return

    case 'session.delegation.created': {
      delegations++
      const id = ev.delegation?.id
      console.log(`${stamp()} <- session.delegation.created id=${id} target=${ev.delegation?.target} offset=${ev.offset_ms}ms`)
      // CLIENT delegation: answer on this path, not the response.* path.
      send({ type: 'session.thinking.append', delegation_id: id, content: 'Looking up staging deployment status.' })
      console.log(`${stamp()} -> session.thinking.append (silent progress)`)
      send({ type: 'session.commentary.append', delegation_id: id, content: COMMENTARY })
      console.log(`${stamp()} -> session.commentary.append (result, spoken aloud)`)
      return
    }

    case 'session.instructions.appended':
    case 'session.thinking.appended':
    case 'session.commentary.appended':
      acks[type] = (acks[type] ?? 0) + 1
      console.log(`${stamp()} <- ${type} (injection confirmed)`)
      return

    case 'session.usage.updated':
      console.log(`${stamp()} <- usage: ${JSON.stringify(ev.usage ?? ev).slice(0, 120)}`)
      return

    case 'session.closed':
      console.log(`${stamp()} <- session.closed  reason=${ev.reason ?? 'n/a'} usage=${JSON.stringify(ev.usage ?? null)}`)
      finish(outBytes > 0 ? 0 : 1, 'server closed')
      return

    case 'error':
      console.error(`${stamp()} <- ERROR ${JSON.stringify(ev.error ?? ev).slice(0, 400)}`)
      return

    default:
      console.log(`${stamp()} <- ${type}  ${JSON.stringify(ev).slice(0, 240)}`)
  }
})

function streamAudio() {
  let off = 0
  const tick = setInterval(() => {
    if (off >= pcm.length) {
      clearInterval(tick)
      console.log(`${stamp()} -> utterance complete (${framesSent} frames) — waiting for endpointing`)
      clearTimeout(timer)
      timer = setTimeout(() => finish(outBytes > 0 ? 0 : 1, 'drain complete'), TAIL_MS)
      return
    }
    const frame = pcm.subarray(off, off + BYTES_PER_FRAME)
    off += BYTES_PER_FRAME
    framesSent++
    send({ type: 'session.input_audio.append', audio: frame.toString('base64') })
  }, FRAME_MS)
}

ws.on('error', (err) => { console.error(`${stamp()} socket error: ${err.message}`); finish(1, 'socket error') })
