/**
 * P1 story 2, second phase — ask the server what its client vocabulary actually is.
 *
 * `protocol.md` records that when an unknown client **event** was sent, "the server enumerated its own
 * vocabulary". That is a rare gift: an authoritative list of what this endpoint accepts, rather than a
 * list of spellings we guessed and saw refused. It also settles four cells `protocol.md` currently
 * marks ❓ — the responses route, `session.update`, `input_audio.mute`/`.unmute`, and `session.close` —
 * which is a P1 exit criterion.
 *
 * **Two bugs in the first run, both fixed here, and both worth stating because they are the reason the
 * first reading was unusable:**
 *  1. `session.close` was sent as the *first* event, so it hit the first-event rule instead of being
 *     tested. Every step is now non-fresh: `session.start` first, `session.started` awaited, then the
 *     frame under test.
 *  2. An unknown **type** cannot be tested as a first event either — the first-event check fires before
 *     type validation, so it returns "The first Live event must be session.start" and tells us nothing
 *     about type handling. The bogus type is therefore sent *after* `session.start`.
 *
 * Never prints the key; every emitted string passes through `redact`.
 *
 * Usage: node spike/probe-client-vocabulary.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { redact } from 'dsh-realtime'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

function loadKey() {
  if ((process.env.OPENAI_LIVE_API_KEY ?? '').trim().length > 0) return process.env.OPENAI_LIVE_API_KEY
  const envPath = join(process.env.HOME ?? '', '.dsh', '.env')
  if (!existsSync(envPath)) return ''
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*OPENAI_LIVE_API_KEY\s*=\s*(.*)\s*$/.exec(line)
    if (match !== null) return match[1].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

const key = loadKey()
if (key.trim().length === 0) {
  console.log('SKIP: no OPENAI_LIVE_API_KEY')
  process.exit(0)
}

const URL = 'wss://api.openai.com/v1/live/sessions'

/** `ack` names the event that proves acceptance, so a clean acceptance resolves without waiting. */
const STEPS = [
  { name: 'baseline session.start', test: null, ack: 'session.started' },
  { name: 'session.update', test: { type: 'session.update', session: {} }, ack: 'session.updated' },
  { name: 'input_audio.mute', test: { type: 'session.input_audio.mute' }, ack: 'session.input_audio.muted' },
  { name: 'input_audio.unmute', test: { type: 'session.input_audio.unmute' }, ack: 'session.input_audio.unmuted' },
  { name: 'session.close', test: { type: 'session.close' }, ack: 'session.closed' },
  { name: 'unknown event type', test: { type: '__probe_unknown_event__' } },
  { name: 'responses route', test: { type: 'response.create', response: { model: 'gpt-live-1' } } },
  { name: 'input_audio.commit', test: { type: 'session.input_audio.commit' } },
]

const QUERY_MS = 6_000

async function run(step) {
  return await new Promise((resolve) => {
    const frames = []
    const socket = new WebSocket(URL, { headers: { Authorization: `Bearer ${key}` } })
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already gone */ }
      resolve({ outcome, frames })
    }
    const timer = setTimeout(() => finish('no-verdict-in-window'), QUERY_MS * 2)

    const started = 'session.start'
    socket.on('open', () => {
      socket.send(JSON.stringify(
        step.test === null
          ? { type: 'session.start', session: { model: 'gpt-live-1', delegation: { type: 'client' } } }
          : { type: 'session.start', session: { model: 'gpt-live-1', delegation: { type: 'client' } } },
      ))
      void started
    })

    socket.on('message', (data) => {
      let frame
      try { frame = JSON.parse(String(data)) } catch { return }
      frames.push(frame)
      const type = typeof frame?.type === 'string' ? frame.type : '(none)'

      // Ask the question only once the session is live.
      if (type === 'session.started' && step.test !== null && !sentTest) {
        sentTest = true
        socket.send(JSON.stringify(step.test))
        return
      }
      if (step.test !== null && step.ack !== undefined && type === step.ack) return finish('accepted')
      if (type === 'error') return finish('error')
      if (type === 'session.closed') return finish('closed')
    })
    let sentTest = false
    socket.on('error', (error) => finish(`socket-error: ${String(error?.message ?? error)}`))
    socket.on('close', () => finish('closed-without-verdict'))
  })
}

console.log('P1 — the client event vocabulary, asked directly\n')

const collected = []
for (const step of STEPS) {
  const observed = await run(step)
  const error = observed.frames.find((f) => f?.type === 'error')
  const reached = observed.frames.map((f) => f?.type).filter(Boolean).join(', ')
  const row = {
    step: step.name,
    outcome: observed.outcome,
    code: error?.code ?? error?.error?.code ?? null,
    message: error === undefined ? null : redact(String(error.message ?? error.error?.message ?? JSON.stringify(error)), [key]).slice(0, 700),
    frames: observed.frames.map((f) => f?.type).filter(Boolean),
  }
  collected.push(row)
  const verdict = observed.outcome === 'accepted' ? 'EXISTS' : observed.outcome === 'error' ? 'refused' : observed.outcome
  console.log(`${step.name.padEnd(24)} ${String(verdict).padEnd(22)} ${String(row.code ?? '').padEnd(18)} ${(row.message ?? reached).slice(0, 150)}`)
}

const outDir = join(repo, 'spike', 'evidence')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `client-vocabulary-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
writeFileSync(outPath, collected.map((r) => JSON.stringify(r)).join('\n') + '\n')
console.log(`\nevidence ${outPath.replace(repo + '/', '')}`)
process.exit(0)
