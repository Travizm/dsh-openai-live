/**
 * P1 stories 5 + 6 — the behavioural corpus, as a two-arm experiment.
 *
 * ## The first run, and why this file is now an experiment rather than a measurement
 *
 * The corpus was run once with one candidate instruction. Delegation rate: **2 of 5.**
 *
 *   q-readme     question  → delegated
 *   n-note       note      → delegated          ← the note lever works
 *   s-say        say       → NOT delegated      ← the model answered it itself
 *   a-ambiguous  ambiguous → not delegated
 *   i-injected   adversarial → not delegated
 *
 * A `say` that never produces a delegation cannot be classified, so the interesting verb — the one
 * nobody ships — is the one that did not fire. The hypothesis for why:
 *
 *   *"Tell the session the release is approved" reads as an instruction TO THE MODEL, so the model
 *   complies by telling you. It has no reason to think the message is for someone else.*
 *
 * That is a hypothesis, so it is tested as one: **one variable, the instruction**, the same five
 * utterances, the same order, both arms in one run. The v2 instruction names the model as a **relay
 * rather than an actor** and says explicitly that a *"tell the session…"* phrasing is a message to
 * deliver, not a request to answer.
 *
 * **The comparison is two-sided on purpose.** v2 must make `s-say` delegate *and* must not cost
 * `q-readme` or `n-note` theirs — an instruction that fixes one shape by breaking another is not a fix,
 * and a one-sided reading would not notice.
 *
 * ## What this can and cannot show
 *
 * It can show whether the lever works at all on this surface. It cannot show the classifier is accurate:
 * five utterances is a corpus for *direction*, not for a rate. A real corpus is dozens, with adversarial
 * negatives, and it lives in P1's next iteration (see `docs/delegation-intent.md` §4).
 *
 * Cost: ten sessions of ~`WAIT_MS`. The trigger spike measured `usage.seconds: 7` per session.
 *
 * Never prints the key. `live_`-shaped ids are elided at the recorder.
 *
 * Usage: node spike/probe-delegation-corpus.mjs
 * Env:   WAIT_MS=15000
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

function loadKey() {
  if ((process.env.OPENAI_LIVE_API_KEY ?? '').trim().length > 0) return process.env.OPENAI_LIVE_API_KEY
  const envPath = join(process.env.HOME ?? '', '.dsh', '.env')
  if (!existsSync(envPath)) return ''
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*OPENAI_LIVE_API_KEY\s*=\s*(.*)\s*$/.exec(line)
    if (m !== null) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

const KEY = loadKey()
if (KEY.trim().length === 0) { console.log('SKIP: no key'); process.exit(0) }

const ENDPOINT = 'wss://api.openai.com/v1/live/sessions'
const MODEL = 'gpt-live-1'
const VOICE = 'marin'
const SAMPLE_RATE = 24_000
const FRAME_MS = 50
const BYTES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000 * 2
const WAIT_MS = Number(process.env.WAIT_MS ?? 15_000)

/** Arm 1 — the text that produced 2/5. Kept verbatim so the comparison is against a real reading. */
const V1 = [
  'You have no tools and no knowledge of this system: you cannot read files, run commands, or look anything up yourself.',
  'When the user asks you to check, look up, retrieve, list, read, describe or otherwise act on anything about their session, their machine, their files or their work, you MUST delegate that request to the client, then speak the result you are given, word for word.',
  'The user may also ask you to leave a note for the session, or to tell the session something. Treat those as requests to the client too: delegate them rather than answering.',
  '"The session" is the workspace you are attached to, not this conversation: never answer for it from memory. Answer ordinary conversation yourself.',
].join(' ')

/**
 * Arm 2 — **the hypothesis.** The change is a claim about *why* v1 failed: the model read "tell the
 * session…" as an instruction to itself and therefore complied with it. So this names the model's role
 * (relay), and names that specific phrasing as a message to deliver.
 */
const V2 = [
  'You are a relay, not an actor. You have no tools and no knowledge of this system: you cannot read files, run commands, or look anything up yourself.',
  'Every request that concerns the session — checking, looking up, reading, listing, describing, leaving a note for the session, or telling the session something — MUST be delegated to the client. You then speak the result you are given, word for word.',
  'This includes requests phrased as an instruction to you about the session, such as "tell the session…", "let the session know…" or "pass this on…". Those are NOT requests for you to answer. They are messages for the client to deliver to the session. Delegate them.',
  '"The session" is the workspace you are attached to, not this conversation: never answer for it from memory. Answer only ordinary conversation that does not concern the session.',
].join(' ')

const ARMS = [
  { name: 'v1', instruction: V1 },
  { name: 'v2', instruction: V2 },
]

const UTTERANCES = [
  { name: 'q-readme', expect: 'question', pcm: 'spike/fixtures/corpus/q-readme.pcm' },
  { name: 'n-note', expect: 'note', pcm: 'spike/fixtures/corpus/n-note.pcm' },
  { name: 's-say', expect: 'say', pcm: 'spike/fixtures/corpus/s-say.pcm' },
  { name: 'a-ambiguous', expect: 'ambiguous→question', pcm: 'spike/fixtures/corpus/a-ambiguous.pcm' },
  { name: 'i-injected', expect: 'adversarial→question', pcm: 'spike/fixtures/corpus/i-injected.pcm' },
]

const EVIDENCE = join(repo, 'spike', 'evidence', `delegation-corpus-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
writeFileSync(EVIDENCE, '')
const SESSION_ID_SHAPE = /\blive_[A-Za-z0-9_-]{20,}\b/g
const reduce = (frame) => {
  const out = { ...frame }
  if (typeof out.audio === 'string') out.audio = `<${out.audio.length} b64 chars>`
  return out
}
const record = (arm, utterance, dir, frame) => {
  appendFileSync(EVIDENCE, `${JSON.stringify({ arm, utterance, dir, at: Date.now(), frame: reduce(frame) }).replace(SESSION_ID_SHAPE, 'SESSION_ID_REDACTED')}\n`)
}

function transcriptText(frame) {
  for (const key of ['delta', 'text', 'content', 'transcript']) {
    const value = frame?.[key]
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object' && typeof value.text === 'string') return value.text
  }
  return ''
}

const stamp = () => new Date().toISOString().slice(11, 23)

function run(arm, utterance) {
  const pcm = readFileSync(join(repo, utterance.pcm))
  return new Promise((resolve) => {
    const started = Date.now()
    const seen = new Map()
    let created
    let createdAt = 0
    let inputText = ''
    let outputAudio = 0
    let closed = false

    const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } })
    const finish = (note) => {
      if (closed) return
      closed = true
      clearInterval(tick)
      clearTimeout(bell)
      try { ws.close() } catch { /* already gone */ }
      resolve({
        arm: arm.name, name: utterance.name, expect: utterance.expect, note,
        delegated: created !== undefined,
        offsetMs: created?.offset_ms ?? created?.offsetMs ?? null,
        delegatedAtMs: created === undefined ? null : (createdAt - started),
        inputTranscript: inputText.trim(),
        outputAudioFrames: outputAudio,
      })
    }

    let off = 0
    let tick
    const stream = () => {
      tick = setInterval(() => {
        const frame = off < pcm.length ? pcm.subarray(off, off + BYTES_PER_FRAME) : Buffer.alloc(BYTES_PER_FRAME)
        off += BYTES_PER_FRAME
        const payload = { type: 'session.input_audio.append', audio: frame.toString('base64') }
        record(arm.name, utterance.name, 'out', payload)
        try { ws.send(JSON.stringify(payload)) } catch { /* the socket reports it */ }
      }, FRAME_MS)
    }
    const bell = setTimeout(() => finish('window elapsed'), WAIT_MS)

    ws.on('open', () => {
      const frame = {
        type: 'session.start',
        session: { model: MODEL, instructions: arm.instruction, audio: { output: { voice: VOICE } }, delegation: { type: 'client' } },
      }
      record(arm.name, utterance.name, 'out', frame)
      ws.send(JSON.stringify(frame))
    })

    ws.on('message', (data) => {
      let frame
      try { frame = JSON.parse(data.toString()) } catch { return }
      record(arm.name, utterance.name, 'in', frame)
      const type = typeof frame?.type === 'string' ? frame.type : ''
      seen.set(type, (seen.get(type) ?? 0) + 1)
      if (type === 'session.started') stream()
      if (type === 'session.input_transcript.delta') inputText += transcriptText(frame)
      if (type === 'session.output_audio.delta') outputAudio += 1
      if (type === 'session.delegation.created' && created === undefined) {
        created = frame
        createdAt = Date.now()
        finish('delegation created')
      }
      if (type === 'session.error') finish(`session.error: ${JSON.stringify(frame).slice(0, 140)}`)
    })

    ws.on('error', (error) => finish(`socket error: ${String(error?.message ?? error)}`))
    ws.on('close', () => finish('socket closed'))
  })
}

console.log('P1 — the behavioural corpus, two arms, one variable: the instruction\n')
console.log(`v1 ${V1.length} chars (measured 2/5) · v2 ${V2.length} chars (the relay hypothesis)\n`)

const rows = []
for (const arm of ARMS) {
  console.log(`--- arm ${arm.name} ---`)
  for (const utterance of UTTERANCES) {
    const row = await run(arm, utterance)
    rows.push(row)
    console.log(`${stamp()} ${row.name.padEnd(13)} delegated=${row.delegated ? 'YES' : 'no '}  heard="${row.inputTranscript.slice(0, 78)}"`)
    await new Promise((r) => { setTimeout(r, 800) })
  }
  console.log()
}

const rate = (armName) => {
  const armRows = rows.filter((r) => r.arm === armName)
  return { delegated: armRows.filter((r) => r.delegated).length, total: armRows.length, armRows }
}
const v1 = rate('v1')
const v2 = rate('v2')

console.log('=== delegation rate by arm ===')
console.log(`v1 ${v1.delegated}/${v1.total}   v2 ${v2.delegated}/${v2.total}`)
console.log('\n| utterance | expected | v1 | v2 |')
console.log('|---|---|---|---|')
for (const utterance of UTTERANCES) {
  const a = rows.find((r) => r.arm === 'v1' && r.name === utterance.name)
  const b = rows.find((r) => r.arm === 'v2' && r.name === utterance.name)
  console.log(`| ${utterance.name} | ${utterance.expect} | ${a?.delegated ? 'yes' : '**no**'} | ${b?.delegated ? 'yes' : '**no**'} |`)
}

const say = rows.find((r) => r.arm === 'v2' && r.name === 's-say')
const keptQ = rows.find((r) => r.arm === 'v2' && r.name === 'q-readme')?.delegated === true
const keptN = rows.find((r) => r.arm === 'v2' && r.name === 'n-note')?.delegated === true
console.log('\n=== verdict ===')
if (say?.delegated === true && keptQ && keptN) {
  console.log('  → v2 is the better lever: say now delegates, and question and note are not lost')
} else if (say?.delegated === true) {
  console.log(`  → v2 moved say, but at a cost: question=${keptQ ? 'kept' : 'LOST'} note=${keptN ? 'kept' : 'LOST'} — a fix that breaks another shape is not a fix`)
} else {
  console.log('  → the relay hypothesis is REFUTED: naming the role did not make say delegate, so the cause is elsewhere')
}

writeFileSync(EVIDENCE.replace('.jsonl', '.summary.json'), JSON.stringify(rows, null, 2))
console.log(`\nevidence ${EVIDENCE.replace(repo + '/', '')}`)
process.exit(0)
