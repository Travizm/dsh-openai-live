#!/usr/bin/env node
/**
 * Why the voice model does not tool-call: the instructions lever, measured.
 *
 * The symptom is that the shipped plugin's voice model never produces a tool call. Everything else in the
 * envelope is right — the adapter sends `delegation: { type: 'client' }` (`wire.ts:168`), the same mode the
 * spike uses — so the question is not whether the client *can* be delegated to, it is what makes the model
 * *decide* to delegate at all.
 *
 * The one place in this repo that has ever produced a `session.delegation.created` is `commentary-pacing.mjs`,
 * and it passes instructions whose entire purpose is to make the model delegate:
 *
 *   "When the user asks you to check anything, delegate that request to the client instead of answering."
 *
 * The shipped bundle passes **no instructions at all**: `instructions` is `Schema.string().required(false)`,
 * the bundle's agent row does not set it, and neither does the profile. So the model is left to the
 * provider's default behaviour with a request it could just answer itself.
 *
 * That is a hypothesis about a cause, not the cause, so this measures it. Two arms, one variable:
 *
 *   ARM=bare        `session.start` exactly as `sessionStart(model, undefined, voice)` builds it
 *   ARM=instructed  the same, plus the repo's own reference instruction, verbatim
 *
 * Each arm streams the same fixture utterance — 4.44 s of *"check the deployment status of the staging…"*,
 * a request a delegating model would hand off — holds the microphone open afterwards, the way a real client
 * does, and watches for a delegation until WAIT_MS. What the model *did* instead is `session.output_audio`
 * on the same socket, so "it answered rather than delegating" is observable rather than inferred.
 *
 * Cost: two sessions of about WAIT_MS each. Story 2 measured every run at `usage.seconds: 7`; at $0.05 per
 * voice-minute this is under five cents for both arms.
 *
 * The key is read from the environment and is never logged, written or echoed, including on failure.
 *
 * Usage: node spike/delegation-trigger.mjs [pcm16-24k-mono]
 * Env:   WAIT_MS=12000 · PCM=… · EVIDENCE=spike/evidence/delegation-trigger.jsonl
 * Exit:  0 = both arms completed · 2 = no key or no fixture · 1 = a socket failure
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const ENDPOINT = 'wss://api.openai.com/v1/live/sessions'
const KEY = process.env.OPENAI_LIVE_API_KEY || process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY
const PCM_PATH = process.argv[2] || process.env.PCM || 'spike/fixtures/audio/deleg.pcm'
const EVIDENCE = process.env.EVIDENCE || 'spike/evidence/delegation-trigger.jsonl'
const WAIT_MS = Number(process.env.WAIT_MS ?? 12_000)
const MODEL = 'gpt-live-1'
const VOICE = 'marin'
const SAMPLE_RATE = 24_000
const FRAME_MS = 50
const BYTES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000 * 2

/** The reference instruction, verbatim from `spike/commentary-pacing.mjs`. Not a suggestion, a quotation. */
const DELEGATING_INSTRUCTION =
  'When the user asks you to check anything, delegate that request to the client instead of answering.'

const ARMS = [
  { name: 'bare', instructions: undefined },
  { name: 'instructed', instructions: DELEGATING_INSTRUCTION },
]

if (KEY === undefined || KEY.length === 0) {
  console.error('no key: set OPENAI_LIVE_API_KEY')
  process.exit(2)
}
const pcm = readFileSync(PCM_PATH)
writeFileSync(EVIDENCE, '')

/** An outbound frame is recorded by shape: an audio payload becomes its length, never its bytes. */
const reduce = (frame) => {
  const out = { ...frame }
  if (typeof out.audio === 'string') out.audio = `<${out.audio.length} b64 chars>`
  return out
}

/**
 * The provider's session id is not a credential, but the leak scan reads its shape as one — a bare `live_`
 * plus 35 base62 characters — and the scan is right to: it cannot tell this apart from a partner key, and a
 * scanner that tried would be one nobody could rely on. So it is elided at the recorder, which is the only
 * place that can guarantee no run ever commits one.
 */
const SESSION_ID_SHAPE = /\blive_[A-Za-z0-9_-]{20,}\b/g

const record = (arm, dir, frame) => {
  const entry = { arm, dir, at: Date.now(), frame: reduce(frame) }
  appendFileSync(EVIDENCE, `${JSON.stringify(entry).replace(SESSION_ID_SHAPE, 'SESSION_ID_REDACTED')}\n`)
}

const stamp = () => new Date().toISOString().slice(11, 23)

/** One arm: connect, start, stream, and watch. Resolves with what happened, not with a judgement. */
function run(arm) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const seen = []
    let created
    let audioDeltas = 0
    let closed = false

    const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } })
    const finish = (note) => {
      if (closed) return
      closed = true
      clearInterval(tick)
      clearTimeout(bell)
      try { ws.close() } catch { /* already gone */ }
      resolve({ arm: arm.name, created, createdAtMs: created === undefined ? undefined : created - started, audioDeltas, note, seen })
    }

    let off = 0
    let tick
    const stream = () => {
      tick = setInterval(() => {
        // Past the utterance, keep streaming digital silence, because the timeline advances with the audio.
        const frame = off < pcm.length ? pcm.subarray(off, off + BYTES_PER_FRAME) : Buffer.alloc(BYTES_PER_FRAME)
        off += BYTES_PER_FRAME
        const payload = { type: 'session.input_audio.append', audio: frame.toString('base64') }
        record(arm.name, 'out', payload)
        try { ws.send(JSON.stringify(payload)) } catch { /* the socket will report it */ }
      }, FRAME_MS)
    }

    const bell = setTimeout(() => { finish('window elapsed') }, WAIT_MS)

    ws.on('open', () => {
      const session = {
        model: MODEL,
        ...arm.instructions === undefined ? {} : { instructions: arm.instructions },
        audio: { output: { voice: VOICE } },
        delegation: { type: 'client' },
      }
      const frame = { type: 'session.start', session }
      record(arm.name, 'out', frame)
      ws.send(JSON.stringify(frame))
    })

    ws.on('message', (data) => {
      let frame
      try { frame = JSON.parse(data.toString()) } catch { return }
      record(arm.name, 'in', frame)
      seen.push(frame.type)
      if (frame.type === 'session.started') stream()
      if (frame.type === 'session.output_audio.delta' || frame.type === 'session.output_audio.done') audioDeltas += 1
      if (frame.type === 'session.delegation.created' && created === undefined) {
        created = Date.now()
        // The answer to this run: the model delegated. Stop as soon as the lever is shown to work.
        finish('delegation created')
      }
      if (frame.type === 'session.error') finish(`session.error: ${JSON.stringify(frame).slice(0, 120)}`)
    })

    ws.on('error', (error) => { if (!closed) { closed = true; clearInterval(tick); clearTimeout(bell); reject(error) } })
    ws.on('close', () => { finish('socket closed') })
  })
}

const rows = []
for (const arm of ARMS) {
  console.log(`\n${stamp()} -> arm ${arm.name}${arm.instructions === undefined ? ' (no instructions — what the bundle ships)' : ' (the reference instruction)'}`)
  const result = await run(arm)
  rows.push(result)
  console.log(`${stamp()} <- ${arm.name}: delegation=${result.created === undefined ? 'NO' : `yes at +${result.createdAtMs} ms`} · output-audio frames=${result.audioDeltas} · ${result.note}`)

  const kinds = new Map()
  for (const type of result.seen) kinds.set(type, (kinds.get(type) ?? 0) + 1)
  console.log(`   inbound: ${[...kinds].map(([k, n]) => `${k}×${n}`).join(' · ')}`)

  // A short gap, so the two arms are plainly two sessions rather than one held-open socket.
  await new Promise(resolve => { setTimeout(resolve, 1_000) })
}

console.log('\n=== verdict ===')
for (const row of rows) {
  console.log(`  ${row.arm.padEnd(12)} delegation=${row.created === undefined ? 'NO' : 'yes'}  output-audio frames=${row.audioDeltas}`)
}
const bare = rows.find(row => row.arm === 'bare')
const instructed = rows.find(row => row.arm === 'instructed')
if (bare?.created === undefined && instructed?.created !== undefined) {
  console.log('  → the instruction is the lever: without it the model answers instead of delegating')
} else if (bare?.created !== undefined) {
  console.log('  → REFUTED: the model delegated with no instructions at all, so the cause is elsewhere')
} else {
  console.log('  → inconclusive: neither arm delegated, so this lever is not the (only) cause')
}
console.log(`\nevidence: ${EVIDENCE}`)
