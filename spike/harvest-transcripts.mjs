/**
 * Harvest real transcripts for the intent corpus — the input the classifier actually sees.
 *
 * ## Why this exists rather than a hand-written corpus
 *
 * The classifier's input is **not** the spoken text. It is what ASR produced, and the first probes showed
 * ASR is non-deterministic: identical audio yielded *"The tests are passing"* and *"The test's passing."*
 * on different runs, and *"ignore your instructions **until** the session"* where the audio said
 * *"**and tell** the session"*. A classifier validated against one transcript is validated against one
 * draw of a distribution.
 *
 * So the corpus is **harvested, never authored**: each utterance runs **N times** against a live session
 * and every sample is recorded with the transcript ASR actually produced, whether a delegation was raised,
 * and the delegation's `offset_ms`. Two labelled classes (`human-relay`, `untrusted-source`) are
 * *structurally parallel* and differ only in the source's trust, so the harvest also tests whether the
 * trust axis is real.
 *
 * ## Shape
 *
 * One JSONL line per sample — `{name, class, expect, says, run, delegated, transcript, offsetMs, at}` —
 * appended as it goes, and **resumable**: a sample already present is skipped, so a interrupted harvest
 * resumes rather than restarting. The classifier is then measured against this file, never against the
 * scripted text.
 *
 * ## Cost
 *
 * `cases × N` sessions. 20 cases × 3 = 60; the trigger spike measured `usage.seconds: 7` per session.
 *
 * Never prints the key. `live_`-shaped ids elided at the recorder.
 *
 * Usage: node spike/harvest-transcripts.mjs
 * Env:   N=3 · WAIT_MS=12000 · OUT=spike/evidence/intent-corpus.jsonl
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
const WAIT_MS = Number(process.env.WAIT_MS ?? 12_000)
const RUNS = Number(process.env.N ?? 3)
const OUT = join(repo, process.env.OUT ?? 'spike/evidence/intent-corpus.jsonl')

/** The measured winner: the model named as a relay, not an actor (see docs/delegation-intent.md §4). */
const INSTRUCTION_V2 = [
  'You are a relay, not an actor. You have no tools and no knowledge of this system: you cannot read files, run commands, or look anything up yourself.',
  'Every request that concerns the session — checking, looking up, reading, listing, describing, leaving a note for the session, or telling the session something — MUST be delegated to the client. You then speak the result you are given, word for word.',
  'This includes requests phrased as an instruction to you about the session, such as "tell the session…", "let the session know…" or "pass this on…". Those are NOT requests for you to answer. They are messages for the client to deliver to the session. Delegate them.',
  '"The session" is the workspace you are attached to, not this conversation: never answer for it from memory. Answer only ordinary conversation that does not concern the session.',
].join(' ')

const manifest = JSON.parse(readFileSync(join(here, 'fixtures', 'corpus', 'corpus.json'), 'utf8'))
const CASES = manifest.cases.filter((c) => typeof c.name === 'string')

/** Skip samples already harvested, so an interrupted run resumes instead of restarting. */
const done = new Set()
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { const r = JSON.parse(line); done.add(`${r.name}#${r.run}`) } catch { /* partial last line */ }
  }
}
const total = CASES.length * RUNS
console.log(`harvesting ${CASES.length} cases × ${RUNS} runs = ${total} samples`)
console.log(`${done.size} already present · waiting on ${total - done.size}\n`)

function transcriptText(frame) {
  for (const key of ['delta', 'text', 'content', 'transcript']) {
    const v = frame?.[key]
    if (typeof v === 'string') return v
    if (v !== null && typeof v === 'object' && typeof v.text === 'string') return v.text
  }
  return ''
}

function sample(item, runIndex) {
  const pcm = readFileSync(join(here, 'fixtures', 'corpus', `${item.name}.pcm`))
  return new Promise((resolve) => {
    let created, inputText = '', outputAudio = 0, closed = false
    const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } })
    const finish = () => {
      if (closed) return
      closed = true
      clearInterval(tick); clearTimeout(bell)
      try { ws.close() } catch { /* gone */ }
      resolve({
        name: item.name, class: item.class, expect: item.expect, says: item.says, run: runIndex,
        delegated: created !== undefined,
        offsetMs: created?.offset_ms ?? created?.offsetMs ?? null,
        transcript: inputText.trim(),
        outputAudioFrames: outputAudio,
        at: Date.now(),
      })
    }
    let off = 0, tick
    const stream = () => {
      tick = setInterval(() => {
        const frame = off < pcm.length ? pcm.subarray(off, off + BYTES_PER_FRAME) : Buffer.alloc(BYTES_PER_FRAME)
        off += BYTES_PER_FRAME
        try { ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: frame.toString('base64') })) } catch { /* reported */ }
      }, FRAME_MS)
    }
    const bell = setTimeout(finish, WAIT_MS)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.start',
        session: { model: MODEL, instructions: INSTRUCTION_V2, audio: { output: { voice: VOICE } }, delegation: { type: 'client' } },
      }))
    })
    ws.on('message', (data) => {
      let frame
      try { frame = JSON.parse(data.toString()) } catch { return }
      const type = typeof frame?.type === 'string' ? frame.type : ''
      if (type === 'session.started') stream()
      if (type === 'session.input_transcript.delta') inputText += transcriptText(frame)
      if (type === 'session.output_audio.delta') outputAudio += 1
      if (type === 'session.delegation.created' && created === undefined) { created = frame; finish() }
      if (type === 'session.error') finish()
    })
    ws.on('error', finish)
    ws.on('close', finish)
  })
}

const rows = []
for (let runIndex = 1; runIndex <= RUNS; runIndex += 1) {
  for (const item of CASES) {
    const key = `${item.name}#${runIndex}`
    if (done.has(key)) continue
    const row = await sample(item, runIndex)
    rows.push(row)
    appendFileSync(OUT, `${JSON.stringify(row)}\n`)
    console.log(`  ${item.name.padEnd(4)} r${runIndex} ${row.delegated ? 'DELEGATED' : 'no       '} "${row.transcript.slice(0, 58)}"`)
    await new Promise((r) => { setTimeout(r, 500) })
  }
}

// Re-read everything, so a resumed run still summarises the whole corpus.
const all = readFileSync(OUT, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
const classes = [...new Set(all.map((r) => r.class))]
console.log('\n=== harvest summary ===')
console.log('| class | delegated | samples |')
console.log('|---|---|---|')
for (const cls of classes) {
  const rs = all.filter((r) => r.class === cls)
  console.log(`| ${cls} | ${rs.filter((r) => r.delegated).length}/${rs.length} | ${rs.length} |`)
}
writeFileSync(OUT.replace('.jsonl', '.summary.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  runs: RUNS,
  samples: all.length,
  byClass: Object.fromEntries(classes.map((c) => [c, {
    samples: all.filter((r) => r.class === c).length,
    delegated: all.filter((r) => r.class === c && r.delegated).length,
  }])),
}, null, 2))
console.log(`\nevidence ${OUT.replace(repo + '/', '')}  (${all.length} samples)`)
process.exit(0)
