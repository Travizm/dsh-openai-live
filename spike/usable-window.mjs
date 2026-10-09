#!/usr/bin/env node
/**
 * S3 story 1 — the usable window, measured.
 *
 * Story 2 answered *where* an append lands (into the model's currently generating speech, or nowhere) and
 * left the question story 1 owns: **how long is that window, and what owns its end?** The plan states the
 * experiment — controlled 3-, 45- and 90-second agent turns with `delegationTimeoutMs` below and above
 * completion, a final answer against milestone commentary, an interruption and a late-result case — and
 * lists three hypotheses:
 *
 *   1. completion tracks the local setting   → ownership of the timeout is real
 *   2. provider expiry is independent of it  → we do not own the whole window
 *   3. the window is the model's *generation* and it closes first → the timeout is beside the point
 *
 * One run measures one shape, so a difference is attributable to the one variable that moved:
 *
 *   SHAPE=frontier    a silent (`thinking`) append every PROBE_MS from `session.delegation.created`, held
 *                     long enough to cross the end of the model's turn. The last one acknowledged *is* the
 *                     window, and the audio deltas date its far edge independently of the appends.
 *   SHAPE=final       one `commentary` result at TURN_MS — the plan's slow-answer case, at 3 / 45 / 90 s.
 *   SHAPE=milestone   `commentary` milestones every MILESTONE_MS until TURN_MS, then the result: does a
 *                     spoken narration stream hold the window open, or does the stream die with it?
 *   SHAPE=stall       the same, with instructions that ask the model to keep talking while it waits — the
 *                     lever that would make the window ours if it worked.
 *   SHAPE=interrupt   barge in with a second utterance, then deliver the first delegation's result late
 *                     (invariant 7: interruption is not cancellation).
 *   SHAPE=early       instructions that ask the model to create the delegation before it speaks at all —
 *                     the window is bounded by the generation, so this asks whether it can be moved.
 *
 * `CLIENT_TIMEOUT_MS` below TURN_MS models the plan's "timeout below completion": the client gives up and
 * sends nothing, while the session is deliberately held open to TURN_MS so the provider's own behaviour
 * is observable. Every append stays far under the 500-token cap; the cap itself was measured in story 2.
 *
 * Evidence records every frame in both directions, but an audio payload is reduced to its byte length:
 * the PCM is reproducible from the tracked fixture, and the measurement here is timing. The evidence
 * therefore contains events only and stays reviewable — story 2's shape, minus the bytes.
 *
 * The key is read from the environment and is never logged, written or echoed, including on failure.
 *
 * Usage: node spike/usable-window.mjs
 * Env:   SHAPE=frontier|final|milestone|stall|interrupt|early   TURN_MS=45000   MILESTONE_MS=2000
 *        CLIENT_TIMEOUT_MS=0   PROBE_MS=400   PROBE_UNTIL_MS=12000
 *        LATE_MS=5000   PCM=…   PCM2=…   EVIDENCE=spike/evidence/usable-window.jsonl
 * Exit:  0 = the sequence completed · 2 = no key or no fixture · 1 = a socket failure
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const ENDPOINT = 'wss://api.openai.com/v1/live/sessions'
const KEY = process.env.OPENAI_LIVE_API_KEY || process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY
const PCM_PATH = process.env.PCM || 'spike/fixtures/audio/deleg.pcm'
const PCM2_PATH = process.env.PCM2 || 'spike/fixtures/audio/utt.pcm'
const EVIDENCE = process.env.EVIDENCE || 'spike/evidence/usable-window.jsonl'
const SHAPE = process.env.SHAPE || 'final'
const TURN_MS = Number(process.env.TURN_MS ?? 45_000)
const MILESTONE_MS = Number(process.env.MILESTONE_MS ?? 2_000)
const CLIENT_TIMEOUT_MS = Number(process.env.CLIENT_TIMEOUT_MS ?? 0)
const PROBE_MS = Number(process.env.PROBE_MS ?? 400)
const PROBE_UNTIL_MS = Number(process.env.PROBE_UNTIL_MS ?? 12_000)
/**
 * The vendor documents that *the session timeline advances with its audio*, and that text sent to a session
 * whose microphone is not streaming is **deferred rather than delivered** — so a client with an open mic
 * streams silence when nobody is speaking. This probe's earlier runs stopped the input stream when the
 * utterance ended. `KEEPALIVE=1` streams digital silence afterwards, which is what a real client does, and
 * is the one variable that separates "the turn ended" from "the timeline stopped".
 */
const KEEPALIVE = process.env.KEEPALIVE === '1'
const LATE_MS = Number(process.env.LATE_MS ?? 5_000)
const BARGE_IN_MS = Number(process.env.BARGE_IN_MS ?? 3_000)
const SAMPLE_RATE = 24_000
const FRAME_MS = 50
const BYTES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000 * 2

const SHAPES = new Set(['frontier', 'final', 'milestone', 'stall', 'interrupt', 'early'])
if (!SHAPES.has(SHAPE)) {
  console.error(`unknown SHAPE=${SHAPE} — one of ${[...SHAPES].join(', ')}`)
  process.exit(2)
}
if (!KEY) {
  console.error('no key in env: set OPENAI_LIVE_API_KEY (or VOICE_TOOLS_OPENAI_KEY / OPENAI_API_KEY)')
  process.exit(2)
}

const pcm = readFileSync(PCM_PATH)
const pcm2 = SHAPE === 'interrupt' ? readFileSync(PCM2_PATH) : null

writeFileSync(EVIDENCE, '')
const t0 = Date.now()
const at = () => Date.now() - t0
/**
 * The provider's session id is `live_` + 35 base62 characters — exactly the shape of a GoCardless live
 * access token, which is why GitHub's secret scanner raises it on every evidence file (15 open alerts, on a
 * public repo). It is not a credential and nothing needs rotating, but it is provider-assigned, stable and
 * unnecessary for any claim these files support, so it does not ship. The compliant path is to not record
 * it, which is also why `scripts/leak-scan.mjs` carries the pattern: the class is catchable locally, so the
 * next one never reaches a scanner that will call it a token.
 */
const SESSION_ID_REDACTED = 'redacted-session-id'

const forEvidence = (event) => {
  if (event?.type === 'session.input_audio.append') return { type: event.type, audioBytes: Buffer.from(String(event.audio ?? ''), 'base64').length }
  if (event?.type === 'session.output_audio.delta') return { type: event.type, audioBytes: Buffer.from(String(event.delta ?? ''), 'base64').length }
  if (event?.session !== undefined && typeof event.session === 'object' && event.session !== null) {
    return { ...event, session: { ...event.session, id: SESSION_ID_REDACTED } }
  }
  return event
}
const record = (dir, obj) => appendFileSync(EVIDENCE, `${JSON.stringify({ t: at(), dir, ...obj })}\n`)
const stamp = () => `[${String(at()).padStart(6)}ms]`

const counts = new Map()
const bump = (type) => counts.set(type, (counts.get(type) ?? 0) + 1)
const sent = []
const acks = []
const errors = []
const usage = []
const audio = { deltas: 0, bytes: 0, firstAt: null, lastAt: null }
const delegations = []
let delegationId = null
let delegationAt = null
let phase = 'startup'
let framesSent = 0
let finished = false
let timer = setTimeout(() => finish(1, 'overall time out'), TURN_MS + 90_000)

const BASE_INSTRUCTIONS = [
  'You are a usable-window probe.',
  'When the user asks you to check anything, delegate that request to the client instead of answering.',
  'When you are given commentary, say it aloud exactly as given, and nothing else.',
].join(' ')

const STALL_INSTRUCTIONS = [
  'You are a usable-window probe.',
  'When the user asks you to check anything, delegate that request to the client instead of answering.',
  'While you wait for the client to return the result, keep talking: say a short update about what you are still doing, then another, and do not stop until the result arrives.',
  'When you are given commentary, say it aloud and then keep talking.',
].join(' ')

/**
 * The `early` variant asks the model to delegate *before* it speaks at all. The window is bounded by the
 * model's generation, so where the delegation lands inside that generation is the whole question: if the
 * delegation arrives at the start of the turn rather than 4.5 s into it, a plugin could own the window by
 * shaping the instructions. This run exists to put a number on that, or to close it.
 */
const EARLY_INSTRUCTIONS = [
  'You are a usable-window probe.',
  'The moment the user asks you to check anything, create the client delegation FIRST, before you say a single word.',
  'Then say only "One moment." and stop speaking until the result arrives.',
  'When you are given commentary, say it aloud exactly as given, and nothing else.',
].join(' ')

const instructionsFor = () => {
  if (SHAPE === 'stall') return STALL_INSTRUCTIONS
  if (SHAPE === 'early') return EARLY_INSTRUCTIONS
  return BASE_INSTRUCTIONS
}

console.log(`endpoint:  ${ENDPOINT}`)
console.log(`shape:     ${SHAPE}`)
console.log(`utterance: ${PCM_PATH} — ${(pcm.length / (SAMPLE_RATE * 2)).toFixed(2)}s${pcm2 ? ` · barge-in ${PCM2_PATH} — ${(pcm2.length / (SAMPLE_RATE * 2)).toFixed(2)}s` : ''}`)
console.log(`agent:     turn ${TURN_MS}ms · client timeout ${CLIENT_TIMEOUT_MS === 0 ? 'none' : `${CLIENT_TIMEOUT_MS}ms`} · milestones ${MILESTONE_MS}ms`)
console.log(`keepalive: ${KEEPALIVE ? 'ON — digital silence after the utterance (a real client with an open mic)' : 'off — the input stream stops with the utterance'}`)
console.log(`evidence:  ${EVIDENCE}\n`)

const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } })
const send = (o) => { record('out', { phase, event: forEvidence(o) }); ws.send(JSON.stringify(o)) }

/**
 * One append, tagged so an acknowledgement can be attributed to it.
 * @param kind - `commentary` (spoken) or `thinking` (silent).
 * @param label - the phase-and-index tag this probe is measuring.
 * @param content - the text to append. Kept far under the 500-token cap.
 */
function append(kind, label, content) {
  const entry = { seq: sent.length + 1, kind, label, content, bytes: Buffer.byteLength(content), sentAt: at(), ackAt: null, offsets: null }
  sent.push(entry)
  record('out', { phase, append: { kind, label, bytes: entry.bytes, delegation_id: delegationId } })
  ws.send(JSON.stringify({ type: `session.${kind}.append`, delegation_id: delegationId, content }))
  return entry
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const closeAfter = (ms, why) => { void (async () => { await wait(ms); phase = 'close'; console.log(`${stamp()} phase: session.close (${why})`); send({ type: 'session.close' }) })() }

/** The client gave up before its agent finished — the plan's "timeout below completion". */
const abandons = () => CLIENT_TIMEOUT_MS > 0 && TURN_MS > CLIENT_TIMEOUT_MS

/**
 * `frontier`: the silent probe. Small `thinking` appends on a fixed cadence, long enough to cross the end
 * of the model's own turn. Nothing here makes the model speak, so what ends is the window and not the probe.
 */
async function shapeFrontier() {
  phase = 'frontier'
  console.log(`${stamp()} shape: a ${PROBE_MS}ms-cadence silent probe for ${PROBE_UNTIL_MS}ms`)
  let i = 0
  while (at() - delegationAt < PROBE_UNTIL_MS) {
    i += 1
    append('thinking', `probe-${i}`, `probe ${i}`)
    await wait(PROBE_MS)
  }
  closeAfter(1_500, 'frontier complete')
}

/** `final`: the plan's slow-answer case — one result append at the end of a controlled agent turn. */
async function shapeFinal() {
  phase = 'final'
  console.log(`${stamp()} shape: a ${TURN_MS}ms agent turn, one result append at the end`)
  await wait(TURN_MS)
  if (abandons()) {
    phase = 'client-timeout'
    console.log(`${stamp()} client timeout at ${CLIENT_TIMEOUT_MS}ms fired — the agent never delivers; holding the session open to observe the provider`)
    await wait(2_000)
    closeAfter(0, 'client gave up, nothing sent')
    return
  }
  phase = 'final-result'
  console.log(`${stamp()} shape: the result (sent ${at() - delegationAt}ms after delegation.created)`)
  append('commentary', 'result', 'Done: 3 of 3 replicas healthy, no failed deploys in 24 hours.')
  closeAfter(6_000, 'result sent')
}

/** `milestone`/`stall`: milestones on a cadence until the turn ends, then the result. */
async function shapeMilestone() {
  const label = SHAPE === 'stall' ? 'stall' : 'milestone'
  phase = label
  console.log(`${stamp()} shape: ${label} — a milestone every ${MILESTONE_MS}ms for ${TURN_MS}ms, then the result`)
  let i = 0
  const giveUpAt = abandons() ? delegationAt + CLIENT_TIMEOUT_MS : Infinity
  while (at() - delegationAt < TURN_MS && at() < giveUpAt) {
    i += 1
    append('commentary', `${label}-${i}`, `Progress ${i}: still working on it.`)
    await wait(MILESTONE_MS)
  }
  if (abandons()) {
    phase = 'client-timeout'
    console.log(`${stamp()} client timeout at ${CLIENT_TIMEOUT_MS}ms fired after ${i} milestones — the result is never sent`)
  } else {
    phase = `${label}-result`
    console.log(`${stamp()} shape: the result (sent ${at() - delegationAt}ms after delegation.created)`)
    append('commentary', 'result', 'Done: 3 of 3 replicas healthy, no failed deploys in 24 hours.')
  }
  closeAfter(6_000, 'milestones complete')
}

/** `interrupt`: barge in, then deliver the first delegation's result into the second turn. */
async function shapeInterrupt() {
  phase = 'interrupt'
  console.log(`${stamp()} shape: barge in at ${BARGE_IN_MS}ms, result for the first delegation ${LATE_MS}ms later`)
  await wait(BARGE_IN_MS)
  phase = 'interrupt-barge-in'
  console.log(`${stamp()} barge-in: streaming the second utterance`)
  streamAudio(pcm2)
  await wait(LATE_MS)
  phase = 'interrupt-late-result'
  console.log(`${stamp()} the late result for delegation #1 — sent ${at() - delegationAt}ms after it was created`)
  append('commentary', 'result', 'Done: 3 of 3 replicas healthy, no failed deploys in 24 hours.')
  closeAfter(6_000, 'late result sent')
}

function dispatch() {
  if (SHAPE === 'frontier') return shapeFrontier()
  if (SHAPE === 'final' || SHAPE === 'early') return shapeFinal()
  if (SHAPE === 'interrupt') return shapeInterrupt()
  return shapeMilestone()
}

/** Digital silence, one frame at a time — what an open microphone sends when nobody is speaking. */
const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME, 0)

function startKeepAlive() {
  console.log(`${stamp()} -> keeping the input stream alive with silence (the session timeline advances with audio)`)
  setInterval(() => send({ type: 'session.input_audio.append', audio: SILENCE_FRAME.toString('base64') }), FRAME_MS)
}

function streamAudio(bytes, { keepAliveAfter = false } = {}) {
  let off = 0
  const tick = setInterval(() => {
    if (off >= bytes.length) {
      clearInterval(tick)
      console.log(`${stamp()} -> utterance complete (${framesSent} frames) — waiting for endpointing`)
      if (keepAliveAfter) startKeepAlive()
      return
    }
    framesSent += 1
    send({ type: 'session.input_audio.append', audio: bytes.subarray(off, off + BYTES_PER_FRAME).toString('base64') })
    off += BYTES_PER_FRAME
  }, FRAME_MS)
}

const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

function finish(code, why) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  const placed = sent.filter((e) => e.ackAt !== null)
  const lastPlaced = placed.at(-1) ?? null
  const latencies = placed.map((e) => e.ackAt - e.sentAt)
  const incomplete = errors.filter((e) => (e.error?.code ?? '') === 'context_injection_incomplete')

  console.log(`\n--- summary (${why}) ---`)
  console.log('events:       ', [...counts].map(([k, v]) => `${k}×${v}`).join('  ') || '(none)')
  console.log(`appends:       ${sent.length} sent · ${placed.length} placed · ${sent.length - placed.length} not placed`)
  console.log(`max append:    ${Math.max(0, ...sent.map((e) => e.bytes))} bytes (cap is 500 tokens)`)
  for (const entry of sent) {
    const latency = entry.ackAt === null ? 'no ack' : `${entry.ackAt - entry.sentAt}ms`
    const offsets = entry.offsets ? JSON.stringify(entry.offsets) : ''
    console.log(`  #${String(entry.seq).padStart(3)} ${entry.kind.padEnd(10)} ${entry.label.padEnd(16)} ${String(entry.bytes).padStart(5)}B  sent ${String(entry.sentAt).padStart(6)}ms  ${latency.padStart(8)}  ${offsets}`)
  }
  console.log(`audio out:     ${audio.deltas} deltas, ${(audio.bytes / (SAMPLE_RATE * 2)).toFixed(2)}s, first ${audio.firstAt}ms, last ${audio.lastAt}ms`)
  if (delegations.length > 0) console.log(`delegations:   ${delegations.map((d) => `${d.id}@${d.t}ms`).join(' · ')}`)
  if (acks.length > 0) console.log('ack payloads: ', JSON.stringify(acks.slice(0, 3).map((a) => a.payload)))
  if (errors.length > 0) {
    const seen = new Map()
    for (const error of errors) {
      const key = JSON.stringify(error.error ?? error)
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    console.log(`refusals (${errors.length}):`)
    for (const [key, count] of seen) console.log(`  ×${count} ${key.slice(0, 240)}`)
  }
  if (usage.length > 0) console.log('usage:        ', JSON.stringify(usage))

  console.log('\n--- usable window ---')
  if (delegationAt === null) {
    console.log('no delegation was created — the window is undefined for this run')
  } else {
    const genStart = audio.firstAt === null ? null : audio.firstAt - delegationAt
    const genEnd = audio.lastAt === null ? null : audio.lastAt - delegationAt
    console.log(`delegation.created at t=${delegationAt}ms`)
    console.log(`model generation:  first delta ${genStart === null ? 'n/a' : `${genStart}ms`} → last delta ${genEnd === null ? 'n/a' : `${genEnd}ms`} (relative to delegation.created)`)
    console.log(`last placed append: ${lastPlaced === null ? 'none' : `#${lastPlaced.seq} ${lastPlaced.label} sent +${lastPlaced.sentAt - delegationAt}ms, acked +${lastPlaced.ackAt - delegationAt}ms (${lastPlaced.ackAt - lastPlaced.sentAt}ms)`}`)
    console.log(`placement frontier: +${lastPlaced === null ? 'n/a' : `${lastPlaced.sentAt - delegationAt}ms`} after delegation.created`)
    console.log(`ack latency (median over placed): ${median(latencies) ?? 'n/a'}ms`)
    if (genEnd !== null && latencies.length > 0) console.log(`send-before deadline (lastDelta − median ack latency): +${genEnd - median(latencies)}ms`)
  }
  console.log(`close-time incomplete: ${incomplete.length} (` + `${errors.length - incomplete.length} other error(s))`)

  try { ws.close() } catch { /* already closing */ }
  process.exit(code)
}

ws.on('open', () => {
  console.log(`${stamp()} socket open`)
  send({
    type: 'session.start',
    session: {
      model: 'gpt-live-1',
      instructions: instructionsFor(),
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
  record('in', { phase, event: forEvidence(ev) })

  switch (type) {
    case 'session.started':
      console.log(`${stamp()} <- session.started`)
      streamAudio(pcm, { keepAliveAfter: KEEPALIVE })
      return

    case 'session.delegation.created': {
      const id = ev.delegation?.id ?? null
      delegations.push({ id, t: at(), target: ev.delegation?.target, offsetMs: ev.delegation?.offset_ms ?? null })
      console.log(`${stamp()} <- session.delegation.created id=${id} target=${ev.delegation?.target} offset=${ev.delegation?.offset_ms ?? 'n/a'}ms`)
      if (delegationAt === null && id !== null) {
        delegationId = id
        delegationAt = at()
        void dispatch()
      }
      return
    }

    case 'session.output_audio.delta':
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
        // the unacknowledged of the same kind — the ack names nothing, so which one it was is recorded.
        if (entry.ackAt !== null || entry.kind !== kind) continue
        if (ev.content !== undefined && ev.content !== entry.content) continue
        entry.ackAt = at()
        if (typeof ev.start_ms === 'number') entry.offsets = { start: ev.start_ms, end: ev.end_ms ?? null }
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
