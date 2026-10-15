/**
 * P1 story 2 — does the Live protocol accept a function/tool declaration, and can an intent be
 * structured rather than inferred?
 *
 * Why this is a wire probe and not an adapter call. The production adapter *filters* the payload — it
 * builds `session.start` from three known fields — so driving it can never answer "does the endpoint
 * accept a fourth". The question is about the **schema**, so the probe must send bytes the adapter
 * would never send.
 *
 * Why it carries a deliberately-bogus variant. The whole reading rests on `protocol.md`'s claim that
 * the endpoint **rejects unknown fields**, which makes a rejection a schema answer. That premise is
 * itself untested in the version we run, so one variant declares a field that certainly does not
 * exist. If the bogus field is *accepted*, then acceptance proves nothing and this probe reports the
 * instrument as broken rather than reporting a finding. **A probe that cannot fail is not a probe.**
 *
 * What it does NOT answer. Whether a declaration *changes model behaviour* — that needs audio, and it
 * is the second phase. This phase answers only what the schema takes.
 *
 * Never prints the key: it is read from the environment or from `~/.dsh/.env`, and every string that
 * leaves this process passes through `redact`. `session.id` is elided, because `live_` + 35 base62
 * chars is byte-shape-identical to a GitHub-scanning GoCardless token and has already produced 20 false
 * alerts on the public repo.
 *
 * Usage: node spike/probe-delegation-channel.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { redact } from 'dsh-realtime'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

/** Read the key without ever putting it on a command line or in a log. */
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
  console.log('SKIP: no OPENAI_LIVE_API_KEY (env or ~/.dsh/.env)')
  process.exit(0)
}

const URL = 'wss://api.openai.com/v1/live/sessions'
const ESTABLISH_MS = 12_000

/** The exact shape the production adapter sends, verified at `wire.ts:160`. */
const baseSession = () => ({
  model: 'gpt-live-1',
  instructions: 'You are a probe. Answer nothing.',
  audio: { output: { voice: 'marin' } },
  delegation: { type: 'client' },
})

const FUNCTION_DECL = {
  type: 'function',
  name: 'probe_write',
  description: 'Write one message into the session.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}

/**
 * The variants. `control` must open; `bogus` calibrates the instrument; the rest are the question.
 * Order matters only for readability — each runs on a fresh socket.
 */
const VARIANTS = [
  { name: 'control', expect: 'accept', session: () => baseSession() },
  {
    name: 'bogus-field',
    expect: 'reject',
    note: 'calibration: a field that certainly does not exist',
    session: () => ({ ...baseSession(), __probe_definitely_unknown__: true }),
  },
  {
    name: 'tools-in-session',
    expect: '?',
    session: () => ({ ...baseSession(), tools: [FUNCTION_DECL] }),
  },
  { name: 'tools-top-level', expect: '?', session: () => ({ ...baseSession() }), extra: { tools: [FUNCTION_DECL] } },
  {
    name: 'tools-in-delegation',
    expect: '?',
    session: () => ({ ...baseSession(), delegation: { type: 'client', tools: [FUNCTION_DECL] } }),
  },
  {
    name: 'tool-choice-and-tools',
    expect: '?',
    session: () => ({ ...baseSession(), tools: [FUNCTION_DECL], tool_choice: 'auto' }),
  },
  {
    name: 'delegation-intent-schema',
    expect: '?',
    note: 'structured intent on the delegation, instead of classifying prose',
    session: () => ({
      ...baseSession(),
      delegation: { type: 'client', intent_schema: { enum: ['note', 'say', 'question'] } },
    }),
  },
]

/** One variant, one fresh socket. Resolves with everything observed inside the window. */
async function probe(variant) {
  const frames = []
  return await new Promise((resolve) => {
    const socket = new WebSocket(URL, { headers: { Authorization: `Bearer ${key}` } })
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already gone */ }
      resolve({ ...outcome, frames })
    }
    const timer = setTimeout(() => finish({ outcome: 'timeout' }), ESTABLISH_MS)

    socket.on('open', () => {
      const payload = { type: 'session.start', session: variant.session(), ...(variant.extra ?? {}) }
      socket.send(JSON.stringify(payload))
    })
    socket.on('message', (data) => {
      let frame
      try { frame = JSON.parse(String(data)) } catch { return }
      frames.push(frame)
      const type = typeof frame?.type === 'string' ? frame.type : '(none)'
      if (type === 'session.started') return finish({ outcome: 'accepted' })
      if (type === 'error') return finish({ outcome: 'rejected' })
    })
    socket.on('error', (error) => finish({ outcome: 'socket-error', message: String(error?.message ?? error) }))
    socket.on('close', () => finish({ outcome: 'closed-without-verdict' }))
  })
}

/** Summarise one error frame without letting the key through. */
function describe(frames) {
  const error = frames.find((f) => f?.type === 'error')
  if (error === undefined) return ''
  const parts = []
  for (const field of ['code', 'type', 'message', 'param']) {
    const value = error[field] ?? error?.error?.[field]
    if (value !== undefined && value !== null) parts.push(`${field}=${redact(String(value), [key])}`)
  }
  const text = JSON.stringify(error)
  if (parts.length === 0) parts.push(redact(text, [key]).slice(0, 300))
  return parts.join(' | ')
}

/** Elide the `live_…` session id, which GitHub's scanner reads as a GoCardless token. */
function elide(frame) {
  const copy = JSON.parse(JSON.stringify(frame))
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /^live_[A-Za-z0-9]{20,}$/.test(v)) node[k] = '[elided]'
      else if (/session_?id/i.test(k) && typeof v === 'string') node[k] = '[elided]'
      else walk(v)
    }
  }
  walk(copy)
  return copy
}

console.log('P1 — the delegation channel, probed at the wire\n')
console.log(`endpoint            ${URL}`)
console.log(`key                 present (len ${key.length}), never printed\n`)

const results = []
for (const variant of VARIANTS) {
  const observed = await probe(variant)
  const row = {
    variant: variant.name,
    expected: variant.expect,
    outcome: observed.outcome,
    detail: describe(observed.frames),
    eventTypes: [...new Set(observed.frames.map((f) => f?.type).filter(Boolean))],
    note: variant.note ?? null,
  }
  results.push(row)
  const verdict = observed.outcome === 'accepted' ? 'ACCEPTED' : observed.outcome === 'rejected' ? 'REJECTED' : observed.outcome.toUpperCase()
  console.log(`${variant.name.padEnd(26)} ${verdict.padEnd(16)} ${row.detail.slice(0, 110)}`)
}

// The instrument check — without it, an ACCEPTED reading below is uninterpretable.
const control = results.find((r) => r.variant === 'control')
const bogus = results.find((r) => r.variant === 'bogus-field')
const instrumentSound = control?.outcome === 'accepted' && bogus?.outcome === 'rejected'
console.log(`\ninstrument          ${instrumentSound
  ? 'SOUND — control opened and a bogus field was refused, so a rejection is a schema answer'
  : 'UNSOUND — a rejection CANNOT be read as a schema answer (see the two rows above)'}`)

const outDir = join(repo, 'spike', 'evidence')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `delegation-channel-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n')
console.log(`\nevidence            ${outPath.replace(repo + '/', '')}`)

const accepted = results.filter((r) => r.outcome === 'accepted').map((r) => r.variant)
console.log(`accepted variants   ${accepted.length === 0 ? '(none)' : accepted.join(', ')}`)
process.exit(0)
