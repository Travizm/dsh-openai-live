#!/usr/bin/env node
/**
 * Delegation-mode probe — which `session.start` delegation config accepts `response.item.create`?
 *
 * v3 finding: `response.item.create` is rejected with "response.item.create requires Responses
 * delegation." under `delegation: {type:"client"}`. So the session must declare a *different*
 * delegation kind. This probe starts a session with a candidate config and sends exactly one
 * `response.item.create`, reporting accepted vs the verbatim rejection.
 *
 * Usage: node spike/probe-delegation.mjs '<json|none>'
 */
import WebSocket from 'ws'

const ENDPOINT = 'wss://api.openai.com/v1/live/sessions'
const KEY = process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY
const ARG = process.argv[2]
if (!KEY) { console.error('no key in env'); process.exit(2) }

const delegation = ARG === 'none' || ARG === undefined ? undefined : JSON.parse(ARG)
const label = delegation === undefined ? '(no delegation field)' : JSON.stringify(delegation)

const t0 = Date.now()
const stamp = () => `[${String(Date.now() - t0).padStart(5)}ms]`
let verdict = 'NO RESPONSE'
let settled = false

const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } })
const send = (o) => ws.send(JSON.stringify(o))

const hardStop = setTimeout(() => done(), 12_000)

function done() {
  if (settled) return
  settled = true
  clearTimeout(hardStop)
  console.log(`  ${label}
      -> ${verdict}`)
  try { ws.close() } catch {}
  process.exit(verdict.startsWith('ACCEPTED') ? 0 : 1)
}

ws.on('open', () => {
  const session = {
    model: 'gpt-live-1',
    instructions: 'Connectivity probe.',
    audio: { output: { voice: 'marin' } },
  }
  if (delegation !== undefined) session.delegation = delegation
  send({ type: 'session.start', session })
})

ws.on('message', (buf) => {
  let ev; try { ev = JSON.parse(buf.toString()) } catch { return }
  const type = ev.type || '(untyped)'

  if (type === 'session.started') {
    console.log(`  ${label}`)
    console.log(`${stamp()}     session.started (delegation accepted: ${JSON.stringify(ev.session?.delegation ?? null)})`)
    setTimeout(() => {
      send({ type: 'response.item.create', item: { type: 'agent_message', author: 'client', content: 'probe' } })
    }, 400)
    return
  }
  if (type === 'error') {
    const e = ev.error ?? ev
    verdict = `REJECTED  ${e.message ?? JSON.stringify(e)}`
    done()
    return
  }
  if (type === 'response.item.created' || type === 'response.created') {
    verdict = 'ACCEPTED'
    done()
  }
})

ws.on('error', (e) => { verdict = `SOCKET ERROR ${e.message}`; done() })
