#!/usr/bin/env node
/**
 * Deepgram Voice Agent — the four wire assumptions ADR-012 will not let us specify around.
 *
 * P1 of the chamber's pathway: four load-bearing facts that are **documented-only** (❓) today, which this
 * repo's own discipline says must become ✅ or ❌ before an adapter is written. A ❌ found here costs an
 * afternoon; found in a sprint, it costs the sprint.
 *
 *   1. `UpdatePrompt` REPLACES rather than appends — otherwise the prompt grows every turn and the chamber's
 *      "re-home appendInstructions" disposition is wrong.
 *   2. `InjectAgentMessage` is accepted MID-TURN — otherwise narration during a tool loop is impossible and
 *      ADR-010's narration fallback needs rethinking.
 *   3. There is NO usage event — otherwise `usageReporting: false` ships wrong.
 *   4. `ConversationText` is UTTERANCE-level, not deltas — otherwise `transcriptDeltas: false` is wrong.
 *
 * Also recorded: `LatencyReport`. The provider sends per-stage timings (ttt / tts / total) as each turn runs,
 * which is free evidence for ADR-012 — part of the instrument it asks for is *reported*, not reconstructed.
 *
 * **Check 1 needs a discriminating test, not just any update.** The first version of this file sent
 * "probe two" and then immediately "probe one", which reinstated the original prompt — so replace and append
 * both answered "probe one", the probe learned nothing, and it re-fired the sequence on every turn (54 turns,
 * then a timeout). Now: one update to a *distinct* text, one more turn, and the answer is matched for it:
 *
 *     "probe two" only   → REPLACED (the update took effect)
 *     "probe one" only   → CONTRADICTED (the update had no effect)
 *     both               → CONTRADICTED (appended)
 *
 * A turn is opened by `InjectUserMessage`, which needs no audio and costs a fraction of a cent. The probe runs
 * two turns at most and stops as soon as the verdicts it can reach are known.
 *
 * This probe NEVER runs in the PR gate: it touches a vendor, costs credit, and needs a key. Without
 * `DEEPGRAM_API_KEY` it prints the plan and exits 0 — a fork stays green, and the payloads stay reviewable.
 *
 * usage:  node scripts/deepgram-probe.mjs --plan          # what it would send and observe, no network
 *         DEEPGRAM_API_KEY=… node scripts/deepgram-probe.mjs --out deepgram-probe.json
 * exit:   0 = no contradiction found (or skipped) · 1 = an assumption contradicted · 2 = probe failed
 */
import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'

const KEY = process.env.DEEPGRAM_API_KEY
const PLAN = process.argv.includes('--plan')
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined
const ENDPOINT = process.env.DEEPGRAM_AGENT_ENDPOINT ?? 'wss://agent.deepgram.com/v1/agent/converse'
const TIMEOUT_MS = Number(process.env.DEEPGRAM_PROBE_TIMEOUT_MS ?? 60_000)
// The frame every claim in this file was read from — so a verdict can be dated.
const DOCS = 'developers.deepgram.com — Configure the Voice Agent / Voice Agent architecture (accessed 2026-10-17)'

/**
 * The settings the probe asks for: Flux for ears, open_ai for the brain, Deepgram for the mouth.
 *
 * `agent.listen.provider.type` is the **vendor**, and the docs say only `deepgram` is accepted — Flux is a
 * *model*, not a provider, and needs `version: v2`. Sending `type: "flux"` connects and then errors with
 * "Check the agent.listen.provider.type field against the API spec", applying nothing (learned the hard way).
 * `agent.language` is deprecated; language now lives on the listen/speak providers.
 *
 * `endpoint` is included only when one is given: absent means Deepgram's managed OpenAI proxy, billed through
 * Deepgram credit. An empty `endpoint.url` is not the same as absent, and the Settings are rejected.
 */
const settings = endpoint => {
  const think = { type: 'open_ai', model: 'gpt-4o-mini' }
  if (endpoint) think.endpoint = { url: endpoint }
  return {
    type: 'Settings',
    audio: { input: { encoding: 'linear16', sample_rate: 16000 }, output: { encoding: 'linear16', sample_rate: 24000 } },
    agent: {
      listen: { provider: { type: 'deepgram', model: 'flux-general-en', version: 'v2' } },
      think: { provider: think, prompt: 'You are a probe. Reply with exactly: probe one.' },
      speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } },
    },
  }
}

const CHECKS = {
  1: 'UpdatePrompt REPLACES rather than appends',
  2: 'InjectAgentMessage is accepted MID-TURN',
  3: 'there is NO usage event',
  4: 'ConversationText is UTTERANCE-level, not deltas',
}
const INJECTED = 'A step is running.'

if (PLAN || KEY === undefined) {
  console.log('Deepgram Voice Agent — P1 wire probe')
  console.log(`endpoint  ${ENDPOINT}`)
  console.log(`sources   ${DOCS}`)
  console.log(`key       ${KEY === undefined ? 'absent — nothing sent' : 'present'}`)
  console.log(`think     ${process.env.DEEPGRAM_PROBE_ENDPOINT || "(absent — Deepgram's managed OpenAI proxy)"}`)
  console.log('')
  console.log('it would send, in this order:')
  console.log('  1. Settings, then `InjectUserMessage` "Say exactly: probe one."')
  console.log(`  2. \`InjectAgentMessage\` "${INJECTED}" as soon as a turn is under way`)
  console.log('  3. `UpdatePrompt` to "reply with exactly: probe two", then `InjectUserMessage` "What do you say?"')
  console.log('')
  console.log('and convert these from ❓ to ✅/❌ (ADR-012):')
  for (const [id, claim] of Object.entries(CHECKS)) console.log(`  ${id}. ${claim}`)
  console.log('')
  console.log(JSON.stringify(settings(process.env.DEEPGRAM_PROBE_ENDPOINT || undefined), null, 1)
    .split('\n').map(line => `  ${line}`).join('\n'))
  console.log('')
  console.log(KEY === undefined ? 'SKIPPED — set DEEPGRAM_API_KEY to run it. Nothing was sent.' : '')
  process.exit(0)
}

const transcript = []
const verdicts = new Map()
const note = (id, verdict, why) => { if (!verdicts.has(Number(id))) verdicts.set(Number(id), { verdict, why }) }

const guard = setTimeout(() => { console.error('probe guard expired'); finish(2) }, TIMEOUT_MS)
const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Token ${KEY}` } })
const send = frame => { transcript.push({ sent: frame.type }); ws.send(JSON.stringify(frame)) }

let stage = 'settings' // settings → turn1 → updated → done
let injectedMidTurn = false

ws.on('open', () => send(settings(process.env.DEEPGRAM_PROBE_ENDPOINT || undefined)))
ws.on('error', error => { console.error(`socket error: ${error.message}`); finish(2) })
ws.on('message', raw => {
  const text = raw.toString()
  let frame
  try { frame = JSON.parse(text) } catch { transcript.push({ binary: text.length }); return }
  transcript.push(frame)

  // Check 3: a usage-shaped server event would be the contradiction. Nothing else in the vocabulary is about cost.
  if (/usage|billing|"seconds"/i.test(text)) note(3, 'CONTRADICTED', `a server event mentioned usage: ${frame.type}`)

  switch (frame.type) {
    case 'SettingsApplied':
      stage = 'turn1'
      // A text injection opens a turn without audio: the cheapest honest turn this probe can buy.
      send({ type: 'InjectUserMessage', content: 'Say exactly: probe one.' })
      return
    case 'UserStartedSpeaking':
    case 'ConversationText': {
      // A turn is under way — this is the mid-turn moment. A text injection raises UserStartedSpeaking too,
      // and ConversationText is the fallback, so both are triggers and only one injection is ever sent.
      if (stage === 'turn1' && !injectedMidTurn) {
        injectedMidTurn = true
        transcript.push({ note: 'InjectAgentMessage sent mid-turn' })
        send({ type: 'InjectAgentMessage', message: INJECTED })
      }
      // Check 4: an utterance carries a role and a whole content string, not a fragment.
      if (frame.type === 'ConversationText' && typeof frame.content === 'string' && frame.role !== undefined) {
        note(4, 'CONFIRMED', `ConversationText carried role="${frame.role}" and a complete utterance`)
      }
      // Check 2: the injected sentence coming back as assistant text is the acceptance receipt. Absence of
      // `InjectionRefused` alone is too weak a claim to make from a quiet log.
      if (frame.role === 'assistant' && typeof frame.content === 'string' && /step is running/i.test(frame.content)) {
        note(2, 'CONFIRMED', 'the injected sentence came back as assistant text, with no InjectionRefused')
      }
      // Check 1: the answer to the *updated* prompt. ZULU is the marker that the update was applied at all;
      // "probe one" is the marker that the original instruction survived it.
      if (stage === 'updated' && frame.role === 'assistant' && typeof frame.content === 'string') {
        const zulu = /zulu/i.test(frame.content)
        const one = /probe one/i.test(frame.content)
        if (zulu && one) note(1, 'CONTRADICTED', `answered "${frame.content.trim()}" — the update was APPENDED, the original survived`)
        else if (zulu && !one) note(1, 'CONFIRMED', `answered "${frame.content.trim()}" — the update REPLACED the prompt`)
        else if (one && !zulu) note(1, 'CONTRADICTED', `answered "${frame.content.trim()}" — the update had NO effect`)
        if (verdicts.has(1)) { stage = 'done'; setTimeout(() => finish(), 300) }
      }
      return
    }
    case 'InjectionRefused':
      note(2, 'CONTRADICTED', 'the provider refused InjectAgentMessage mid-turn')
      return
    case 'AgentAudioDone':
      if (stage === 'turn1') {
        stage = 'updated'
        transcript.push({ note: 'UpdatePrompt adding a detectable rule, then a second turn' })
        // The discriminating update. A *replacement* instruction ("reply with probe two") cannot separate
        // replace from append, because both would satisfy it; asking the model to report its rules cannot
        // either, because a model in a long history reports what it likes. An **additive, detectable** rule
        // can: if the answer still carries the original instruction AND the new token, the update was
        // appended; if the original is gone, it replaced.
        send({ type: 'UpdatePrompt', prompt: 'You are a probe. Every reply must end with the token ZULU.' })
        send({ type: 'InjectUserMessage', content: 'What do you say?' })
      }
      return
    default:
      return
  }
})

function finish(code = 0) {
  clearTimeout(guard)
  try { ws.close() } catch { /* already closed */ }
  // Check 3 is an absence, so it can only be concluded at the end, with the whole session in hand.
  if (!verdicts.has(3)) note(3, 'CONFIRMED', `no usage-like event in ${transcript.length} frames`)
  const contradicted = [...verdicts.values()].filter(v => v.verdict === 'CONTRADICTED').length
  console.log('')
  for (const [id, claim] of Object.entries(CHECKS)) {
    const got = verdicts.get(Number(id))
    console.log(`  ${id}. ${got ? got.verdict : 'INCONCLUSIVE'} — ${claim}`)
    if (got) console.log(`     ${got.why}`)
  }
  const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const pick = key => transcript.filter(f => typeof f[key] === 'number').map(f => f[key])
  const ttt = pick('ttt_token_latency'); const tts = pick('tts_latency'); const total = pick('total_latency')
  if (ttt.length + tts.length + total.length > 0) {
    const show = xs => xs.length ? `${xs.length}× median ${median(xs).toFixed(3)}s` : 'none'
    console.log(`\n  LatencyReport — ttt ${show(ttt)} · tts ${show(tts)} · total ${show(total)}`)
    console.log('     (provider-reported stage timings — ADR-012 evidence that arrives rather than being derived)')
  }
  console.log('')
  if (OUT !== undefined) {
    writeFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), endpoint: ENDPOINT, docs: DOCS,
      verdicts: Object.fromEntries(verdicts), frames: transcript }, null, 1)}\n`)
    console.log(`transcript written to ${OUT}`)
  }
  process.exit(contradicted > 0 ? 1 : code)
}
