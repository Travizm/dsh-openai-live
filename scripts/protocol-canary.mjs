#!/usr/bin/env node
/**
 * Protocol drift canary.
 *
 * A scheduled, shape-only assertion against the live provider. Without one, the first signal that a
 * vendor changed its protocol is a user bug report; with one, it is a red build.
 *
 * The cheap trick it is built around: when the endpoint rejects an unknown *client* event, it
 * **enumerates its supported client events in the error**. So a single handshake — no audio, no
 * conversation — can verify that every event this project sends is still in the provider's
 * vocabulary, and that the event we rely on the *absence* of is still absent.
 *
 * Deliberately NOT part of the PR gate: it touches the network and depends on a provider. It runs on
 * a schedule, behind `OPENAI_LIVE_API_KEY`, and self-skips without one so a fork stays green.
 *
 * What it does not cover: the provider's own server→client vocabulary beyond the two events a
 * handshake and one append elicit. A full check of that would need an audio turn, which costs credit
 * and makes the run non-deterministic. Recorded fixtures cover our translation of what we have seen.
 *
 * Usage: OPENAI_LIVE_API_KEY=… node scripts/protocol-canary.mjs
 * Exit:  0 = no drift (or skipped) · 1 = drift detected
 */
import WebSocket from 'ws'

const KEY = process.env.OPENAI_LIVE_API_KEY
const MODEL = process.env.OPENAI_LIVE_MODEL ?? 'gpt-live-1'
const ENDPOINT = process.env.OPENAI_LIVE_ENDPOINT ?? 'wss://api.openai.com/v1/live/sessions'
const MODELS_URL = process.env.OPENAI_LIVE_MODELS_URL ?? 'https://api.openai.com/v1/models'
const TIMEOUT_MS = Number(process.env.CANARY_TIMEOUT_MS ?? 20_000)

/**
 * Every client event this project sends, and the one we rely on NOT existing.
 *
 * Kept as a literal rather than imported from the built adapter on purpose: a canary that derives its
 * expectations from the code under test can only ever agree with it.
 */
const CLIENT_EVENTS = [
  'session.start',
  'session.input_audio.append',
  'session.input_audio.mute',
  'session.input_audio.unmute',
  'session.instructions.append',
  'session.thinking.append',
  'session.commentary.append',
  'session.close',
]

/** The event we depend on being absent: endpointing belongs to the provider. */
const MUST_NOT_EXIST = 'session.input_audio.commit'

/**
 * Not asserted here: the `session.*.appended` acknowledgements.
 *
 * Eliciting one needs audio in flight — a bare handshake never reaches the point where the provider
 * applies context, which is how this canary learned the difference — and a canary that needs audio
 * costs credit and stops being deterministic. That path is covered by the recorded fixtures and by
 * the W1 evidence in `docs/` instead.
 */

if (KEY === undefined || KEY.length === 0) {
  console.log('SKIP protocol canary: OPENAI_LIVE_API_KEY is not set (this run needs a live provider)')
  process.exit(0)
}

const drift = []
const note = (message) => drift.push(message)

// ── 1. Model availability. Free, and catches a retired or unreleased model id. ────────────────────
const modelsResponse = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${KEY}` } })
if (!modelsResponse.ok) {
  note(`models endpoint returned ${modelsResponse.status}`)
} else {
  const body = await modelsResponse.json()
  const entry = (body.data ?? []).find(model => model.id === MODEL)
  if (entry === undefined) {
    note(`model "${MODEL}" is not in the account's model list`)
  } else if (entry.shutdown_date != null) {
    note(`model "${MODEL}" now carries shutdown_date ${entry.shutdown_date} — it is being retired`)
  }
}

// ── 2-4. One session, three assertions. ──────────────────────────────────────────────────────────
const events = []
const vocabulary = new Set()

const session = await new Promise((resolve, reject) => {
  const socket = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${KEY}` } })
  const timer = setTimeout(() => {
    socket.close()
    reject(new Error(`no usable response within ${TIMEOUT_MS}ms; events seen: ${events.join(', ') || '(none)'}`))
  }, TIMEOUT_MS)

  const finish = (value) => {
    clearTimeout(timer)
    resolve(value)
  }

  socket.on('open', () => {
    socket.send(JSON.stringify({
      type: 'session.start',
      session: {
        model: MODEL,
        instructions: 'Connectivity canary. Do not speak.',
        audio: { output: { voice: 'marin' } },
        delegation: { type: 'client' },
      },
    }))
  })

  socket.on('message', (data) => {
    let event
    try {
      event = JSON.parse(data.toString())
    } catch {
      return
    }
    events.push(event.type)

    if (event.type === 'session.started') {
      const accepted = event.session ?? {}
      if (accepted.model !== MODEL) {
        note(`the provider accepted model "${accepted.model}", not "${MODEL}"`)
      }
      if (accepted.audio?.output?.voice !== 'marin') {
        note(`the provider accepted voice "${accepted.audio?.output?.voice}", not "marin"`)
      }
      if (accepted.delegation?.type !== 'client') {
        note(`the provider accepted delegation ${JSON.stringify(accepted.delegation)}, not {type:"client"}`)
      }
      // The deliberate invalid frame. Its rejection enumerates the supported client vocabulary, which
      // is the whole trick — no audio, no conversation, and still a complete check of what we send.
      socket.send(JSON.stringify({ type: MUST_NOT_EXIST }))
      return
    }

    if (event.type === 'error') {
      const message = String(event.error?.message ?? '')
      for (const token of message.matchAll(/'([^']+)'/g)) {
        const candidate = token[1]
        if (candidate !== undefined && /^[a-z_]+(\.[a-z_]+)+$/.test(candidate)) vocabulary.add(candidate)
      }
      socket.send(JSON.stringify({ type: 'session.close' }))
      finish(undefined)
      return
    }

    if (event.type === 'session.closed') finish(undefined)
  })

  socket.on('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
}).catch((error) => {
  note(`could not complete a handshake: ${error.message}`)
  return undefined
})

if (vocabulary.size > 0) {
  for (const sent of CLIENT_EVENTS) {
    if (!vocabulary.has(sent)) note(`the provider no longer lists the client event "${sent}" — we send it`)
  }
  if (vocabulary.has(MUST_NOT_EXIST)) {
    note(`the provider now supports "${MUST_NOT_EXIST}" — we rely on its absence for endpointing`)
  }
} else if (events.includes('session.started')) {
  // Only complain when the enumeration was reachable and still produced nothing.
  note('the provider accepted an invalid frame without enumerating its supported client events')
}

if (drift.length > 0) {
  console.error(`DRIFT DETECTED against ${ENDPOINT} (model ${MODEL}):`)
  for (const item of drift) console.error(`  - ${item}`)
  console.error(`  events observed: ${events.join(', ') || '(none)'}`)
  console.error(`  client vocabulary reported: ${vocabulary.size === 0 ? '(none)' : [...vocabulary].sort().join(', ')}`)
  process.exit(1)
}

console.log(`PASS protocol canary — no drift. model=${MODEL}`
  + ` events=${events.join(',')} clientEvents=${vocabulary.size}`)
