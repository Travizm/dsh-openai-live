#!/usr/bin/env node
/**
 * W1 milestone 1 — prove the gpt-live-1 session handshake.
 *
 * Connects to /v1/live/sessions over WebSocket, sends `session.start`, and asserts that
 * `session.started` comes back with the configuration it accepted.
 *
 * Deliberately prints event names, timings and the accepted config ONLY. The key is read
 * from the environment and is never logged, written, or echoed — including on failure.
 *
 * Evidence this produces: whether the account is entitled to gpt-live-1, and the exact
 * accepted session-config shape (the endpoint rejects unknown fields, so a rejection is
 * itself the answer to what it expects).
 */
import WebSocket from 'ws'

const ENDPOINT = 'wss://api.openai.com/v1/live/sessions'
const KEY = process.env.VOICE_TOOLS_OPENAI_KEY || process.env.OPENAI_API_KEY

if (!KEY) {
  console.error('no key in env: set VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY')
  process.exit(2)
}

const t0 = Date.now()
const stamp = () => `[${String(Date.now() - t0).padStart(5)}ms]`
const seen = []
let settled = false

const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } })

const timeout = setTimeout(() => {
  if (settled) return
  settled = true
  console.error(`${stamp()} TIMEOUT (20s). Events seen: ${seen.join(', ') || '(none)'}`)
  try { ws.close() } catch {}
  process.exit(1)
}, 20_000)

ws.on('open', () => {
  console.log(`${stamp()} socket open -> ${ENDPOINT}`)
  ws.send(JSON.stringify({
    type: 'session.start',
    session: {
      model: 'gpt-live-1',
      instructions: 'You are a connectivity probe. Reply with one short sentence.',
      audio: { output: { voice: 'marin' } },
      delegation: { type: 'client' },
    },
  }))
  console.log(`${stamp()} -> session.start (model=gpt-live-1, voice=marin, delegation=client)`)
})

ws.on('message', (buf) => {
  let ev
  try { ev = JSON.parse(buf.toString()) } catch { return }
  const type = ev.type || ev.event?.type || '(untyped)'
  seen.push(type)
  console.log(`${stamp()} <- ${type}`)

  if (type === 'session.started') {
    settled = true
    clearTimeout(timeout)
    const s = ev.session || ev
    console.log(`${stamp()}    accepted model: ${s.model ?? '(unspecified)'}`)
    console.log(`${stamp()}    accepted voice: ${s.audio?.output?.voice ?? '(unspecified)'}`)
    console.log(`${stamp()}    delegation:     ${JSON.stringify(s.delegation ?? '(unspecified)')}`)
    console.log('PROBE PASS — gpt-live-1 entitlement confirmed on this key')
    ws.close()
    process.exit(0)
  }

  if (type === 'error') {
    settled = true
    clearTimeout(timeout)
    console.error(`${stamp()}    error: ${JSON.stringify(ev.error ?? ev)}`)
    console.error('PROBE FAIL — endpoint rejected the session (shape above is the diagnostic)')
    ws.close()
    process.exit(1)
  }
})

ws.on('error', (err) => {
  if (settled) return
  settled = true
  clearTimeout(timeout)
  console.error(`${stamp()} socket error: ${err.message}`)
  process.exit(1)
})

ws.on('close', (code) => {
  if (!settled) console.log(`${stamp()} closed early (code ${code})`)
})
