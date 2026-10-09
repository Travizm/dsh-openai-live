#!/usr/bin/env node
/**
 * S3 story 2 — what pacing does the append path actually support?
 *
 * The narration design has one hard dependency that is a vendor fact rather than our choice: when the
 * agent has something new to say mid-turn, how often may it say it? "Spoken for milestones, silent for
 * chatter" is unfalsifiable until the append path is measured on the channel it will actually use.
 *
 * This probe measures it, on one real session, with a real delegation to answer:
 *
 *   1. **Burst** — appends back to back against the live delegation: acknowledged? in what order? how fast?
 *   2. **Spaced** — the same number a second apart: does acknowledgement latency change with the gap?
 *   3. **Silent channel** — the same burst on `session.thinking.append`, which narration wants for chatter.
 *   4. **Speaking** — commentary appended while the model is already speaking: queued, or a barge-in?
 *   5. **Cap** — one append above the documented 500-token limit: the refusal, verbatim.
 *   6. **Close** — what `session.close` and `session.closed` actually do.
 *
 * `SCOPE=session` runs the same appends with `delegation_id: null`, which is the one experiment that made
 * this probe worth writing twice: the session-wide form is accepted and then *never acknowledged*, and the
 * refusal only arrives when the session closes. Recorded, not described.
 *
 * The key is read from the environment and is never logged, written or echoed, including on failure.
 *
 * Usage: node spike/commentary-pacing.mjs [pcm16-24k-mono] [evidence.jsonl]
 * Env:   SCOPE=delegation|session (default delegation) · BURST=n · SPACED=n · GAP_MS=n
 * Exit:  0 = the sequence completed · 2 = no key or no fixture · 1 = a socket failure
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const ENDPOINT = 'wss://api.openai.com/v1/live/sessions'
const KEY = process.env.OPENAI_LIVE_API_KEY || process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY
const PCM_PATH = process.argv[2] || 'spike/fixtures/audio/deleg.pcm'
const EVIDENCE = process.argv[3] || 'spike/evidence/commentary-pacing.jsonl'
const SCOPE = process.env.SCOPE === 'session' ? 'session' : 'delegation'
const MODE = process.env.MODE === 'narration' ? 'narration' : 'phases'
const CADENCE_MS = Number(process.env.CADENCE_MS ?? 500)
const CADENCE_COUNT = Number(process.env.CADENCE_COUNT ?? 12)
const BURST = Number(process.env.BURST ?? 5)
const SPACED = Number(process.env.SPACED ?? 5)
const GAP_MS = Number(process.env.GAP_MS ?? 1000)
const SAMPLE_RATE = 24_000
const FRAME_MS = 50
const BYTES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000 * 2

if (!KEY) {
  console.error('no key in env: set OPENAI_LIVE_API_KEY (or VOICE_TOOLS_OPENAI_KEY / OPENAI_API_KEY)')
  process.exit(2)
}
const pcm = readFileSync(PCM_PATH)

writeFileSync(EVIDENCE, '')
const t0 = Date.now()
const at = () => Date.now() - t0
const record = (dir, obj) => appendFileSync(EVIDENCE, `${JSON.stringify({ t: at(), dir, ...obj })}\n`)
const stamp = () => `[${String(at()).padStart(6)}ms]`

const counts = new Map()
const bump = (type) => counts.set(type, (counts.get(type) ?? 0) + 1)
const sent = []
const acks = []
const errors = []
const usage = []
const audio = { deltas: 0, bytes: 0, firstAt: null, lastAt: null }
let speaking = false
let phase = 'startup'
let delegationId = null
let framesSent = 0
let timer = setTimeout(() => finish(1, 'overall time out'), 120_000)

const INSTRUCTIONS = [
  'You are a pacing probe.',
  'When the user asks you to check anything, delegate that request to the client instead of answering.',
  'When you are given commentary, say it aloud exactly as given, and nothing else.',
].join(' ')

console.log(`endpoint:  ${ENDPOINT}`)
console.log(`utterance: ${PCM_PATH} — ${(pcm.length / (SAMPLE_RATE * 2)).toFixed(2)}s`)
console.log(`scope:     ${SCOPE}`)
console.log(`evidence:  ${EVIDENCE}`)
console.log(`phases:    burst=${BURST} · spaced=${SPACED} at ${GAP_MS}ms · thinking · speaking · cap · close\n`)

const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } })
const send = (o) => { record('out', { phase, event: o }); ws.send(JSON.stringify(o)) }

/**
 * One append, tagged so an acknowledgement can be attributed to it.
 * @param kind - `commentary` (spoken) or `thinking` (silent).
 * @param label - the phase-and-index tag this probe is measuring.
 * @param content - the text to append.
 */
function append(kind, label, content) {
  const entry = { seq: sent.length + 1, kind, label, content, bytes: Buffer.byteLength(content), sentAt: at(), ackAt: null }
  sent.push(entry)
  record('out', { phase, append: { kind, label, bytes: entry.bytes, delegation_id: SCOPE === 'session' ? null : delegationId } })
  ws.send(JSON.stringify({
    type: `session.${kind}.append`,
    delegation_id: SCOPE === 'session' ? null : delegationId,
    content,
  }))
  return entry
}

const filler = (label, chars = 40) => `${label}: ${'x'.repeat(chars)}`

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function phases() {
  phase = 'burst'
  console.log(`${stamp()} phase: ${BURST} commentary appends back to back`)
  for (let i = 1; i <= BURST; i += 1) append('commentary', `burst-${i}`, filler(`burst-${i}`))

  await wait(2500)
  phase = 'spaced'
  console.log(`${stamp()} phase: ${SPACED} commentary appends ${GAP_MS}ms apart`)
  for (let i = 1; i <= SPACED; i += 1) {
    append('commentary', `spaced-${i}`, filler(`spaced-${i}`))
    await wait(GAP_MS)
  }

  await wait(1500)
  phase = 'thinking'
  console.log(`${stamp()} phase: ${BURST} thinking appends back to back (the silent channel)`)
  for (let i = 1; i <= BURST; i += 1) append('thinking', `thinking-${i}`, filler(`thinking-${i}`))

  await wait(1500)
  phase = 'speaking'
  console.log(`${stamp()} phase: commentary while audio is ${speaking ? 'flowing' : 'NOT flowing'} (${audio.deltas} deltas so far)`)
  append('commentary', 'while-speaking', filler('while-speaking'))

  await wait(2500)
  phase = 'cap'
  const long = Array.from({ length: 900 }, (_unused, i) => `word${i}`).join(' ')
  console.log(`${stamp()} phase: one append of ${Buffer.byteLength(long)} bytes (~900 tokens)`)
  append('commentary', 'cap-over-limit', long)

  await wait(3000)
  phase = 'close'
  console.log(`${stamp()} phase: session.close`)
  send({ type: 'session.close' })
}

/**
 * The narration shape: progress on a fixed cadence while the delegation is in flight, then the result.
 *
 * This is the case the design actually cares about — the model is waiting, so nothing is being spoken and
 * no audio timeline is advancing — and it is deliberately separate from `phases()`, which measures the
 * append path's limits rather than one plausible use of it.
 */
async function narrationPhases() {
  phase = 'narration'
  console.log(`${stamp()} phase: ${CADENCE_COUNT} progress appends every ${CADENCE_MS}ms while the delegation is in flight`)
  for (let i = 1; i <= CADENCE_COUNT; i += 1) {
    append('commentary', `progress-${i}`, `Progress ${i} of ${CADENCE_COUNT}: still working.`)
    await wait(CADENCE_MS)
  }
  phase = 'narration-result'
  console.log(`${stamp()} phase: the result`)
  append('commentary', 'result', 'Done: 3 of 3 replicas healthy, no failed deploys in 24 hours.')
  await wait(6000)
  phase = 'narration-think'
  console.log(`${stamp()} phase: one thinking append after the result (silent chatter)`)
  append('thinking', 'after-result', 'Checked the deploy log and the replica count.')
  await wait(3000)
  phase = 'close'
  console.log(`${stamp()} phase: session.close`)
  send({ type: 'session.close' })
}

function finish(code, why) {
  clearTimeout(timer)
  console.log(`\n--- summary (${why}) ---`)
  console.log('events:      ', [...counts].map(([k, v]) => `${k}×${v}`).join('  ') || '(none)')
  console.log(`appends sent: ${sent.length} · acknowledged: ${sent.filter(e => e.ackAt !== null).length}`)
  for (const entry of sent) {
    const latency = entry.ackAt === null ? 'no ack' : `${entry.ackAt - entry.sentAt}ms`
    console.log(`  #${String(entry.seq).padStart(2)} ${entry.kind.padEnd(10)} ${entry.label.padEnd(16)} ${String(entry.bytes).padStart(6)}B  sent ${String(entry.sentAt).padStart(6)}ms  ${latency}`)
  }
  console.log(`audio out:    ${audio.deltas} deltas, ${(audio.bytes / (SAMPLE_RATE * 2)).toFixed(2)}s, first ${audio.firstAt}ms, last ${audio.lastAt}ms`)
  if (acks.length > 0) console.log('ack payloads:', JSON.stringify(acks.slice(0, 3)))
  if (errors.length > 0) {
    console.log(`refusals (${errors.length}):`)
    const seen = new Map()
    for (const error of errors) {
      const key = JSON.stringify(error.error)
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (const [key, count] of seen) console.log(`  ×${count} ${key.slice(0, 220)}`)
  }
  if (usage.length > 0) console.log('usage:', JSON.stringify(usage))
  try { ws.close() } catch { /* already closing */ }
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

function streamAudio() {
  let off = 0
  const tick = setInterval(() => {
    if (off >= pcm.length) {
      clearInterval(tick)
      console.log(`${stamp()} -> utterance complete (${framesSent} frames) — waiting for endpointing`)
      return
    }
    framesSent += 1
    send({ type: 'session.input_audio.append', audio: pcm.subarray(off, off + BYTES_PER_FRAME).toString('base64') })
    off += BYTES_PER_FRAME
  }, FRAME_MS)
}

ws.on('message', (buf) => {
  let ev
  try { ev = JSON.parse(buf.toString()) } catch { return }
  const type = ev.type || '(untyped)'
  bump(type)
  record('in', { phase, event: ev })

  switch (type) {
    case 'session.started':
      console.log(`${stamp()} <- session.started`)
      streamAudio()
      if (SCOPE === 'session') {
        // No delegation is ever created for this scope, so the schedule starts from the handshake.
        setTimeout(() => { void phases() }, 2000)
      }
      return

    case 'session.delegation.created':
      delegationId = ev.delegation?.id ?? null
      console.log(`${stamp()} <- session.delegation.created id=${delegationId} target=${ev.delegation?.target}`)
      if (SCOPE === 'delegation' && delegationId !== null) {
        void (MODE === 'narration' ? narrationPhases() : phases())
      }
      return

    case 'session.output_audio.delta':
      speaking = true
      audio.deltas += 1
      audio.bytes += Buffer.from(String(ev.delta ?? ''), 'base64').length
      audio.firstAt ??= at()
      audio.lastAt = at()
      return

    case 'session.output_transcript.delta':
      console.log(`${stamp()} <- out: ${JSON.stringify(ev.delta ?? '')}`)
      return

    case 'session.commentary.appended':
    case 'session.thinking.appended':
    case 'session.instructions.appended': {
      acks.push({ t: at(), type, payload: ev })
      const kind = type.split('.')[1]
      for (const entry of sent) {
        // Attribute by payload identity when the server echoes the content, else by arrival order among
        // the unacknowledged of the same kind — recorded either way, so the finding can state which one
        // it was rather than implying the ack named anything.
        if (entry.ackAt !== null || entry.kind !== kind) continue
        if (ev.content !== undefined && ev.content !== entry.content) continue
        entry.ackAt = at()
        break
      }
      console.log(`${stamp()} <- ${type}  ${JSON.stringify(ev).slice(0, 160)}`)
      return
    }

    case 'session.usage.updated':
      usage.push({ t: at(), usage: ev.usage ?? null })
      return

    case 'session.closed':
      console.log(`${stamp()} <- session.closed reason=${ev.reason ?? 'n/a'} usage=${JSON.stringify(ev.usage ?? null)}`)
      finish(0, 'server closed')
      return

    case 'error':
      errors.push({ t: at(), phase, error: ev.error ?? ev })
      console.error(`${stamp()} <- ERROR ${JSON.stringify(ev.error ?? ev).slice(0, 300)}`)
      return

    default:
      console.log(`${stamp()} <- ${type}  ${JSON.stringify(ev).slice(0, 200)}`)
  }
})

ws.on('error', (err) => { console.error(`${stamp()} socket error: ${err.message}`); finish(1, 'socket error') })
