#!/usr/bin/env node
/**
 * Deepgram Voice Agent — the four wire assumptions ADR-012 will not let us specify around.
 *
 * P1 of the chamber's pathway is a one-day probe, and this is it: four load-bearing facts about the second
 * provider that are **documented-only** today (❓), which this repo's own discipline says must become ✅ or ❌
 * before an adapter is written. A ❌ found here costs an afternoon; found in a sprint, it costs the sprint.
 *
 *   1. `UpdatePrompt` REPLACES rather than appends. If it appends, the prompt grows every turn and the
 *      "re-home appendInstructions" disposition in the chamber is wrong.
 *   2. `InjectAgentMessage` is accepted MID-TURN. If it is refused (`InjectionRefused`), narration during a
 *      tool loop is impossible and ADR-010's narration fallback needs rethinking.
 *   3. There is NO usage event. If one exists, `usageReporting: false` in ADR-011 is wrong before it ships.
 *   4. `ConversationText` is UTTERANCE-level, not deltas. If it is incremental, `transcriptDeltas: false` is
 *      wrong and the transcript handling of a second adapter is a different job.
 *
 * Also recorded, because it is free and because ADR-012 wants per-stage latency: `LatencyReport`, if the
 * provider sends one. A provider that reports its own stage timings changes what the journal has to
 * reconstruct.
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

/** The settings the probe asks for: Flux for ears, open_ai for the brain, Cartesia for the mouth. */
const settings = endpoint => ({
  type: 'Settings',
  audio: { input: { encoding: 'linear16', sample_rate: 16000 }, output: { encoding: 'linear16', sample_rate: 24000 } },
  agent: {
    language: 'en',
    listen: { provider: { type: 'flux', model: 'flux-general-en' } },
    think: { provider: { type: 'open_ai', model: 'gpt-4o-mini', endpoint: { url: endpoint } }, prompt: 'You are a probe. Reply with exactly: probe one.' },
    speak: { provider: { type: 'cartesia', model: 'sonic-2', voice_id: 'f786b574-daa5-4673-aa0c-cbe3e8534c02' } },
  },
})

const CHECKS = [
  { id: '1', claim: 'UpdatePrompt REPLACES rather than appends', watch: 'the second turn answers "probe one" (replace) or both prompts (append)' },
  { id: '2', claim: 'InjectAgentMessage is accepted MID-TURN', watch: 'no `InjectionRefused` while a turn is in progress' },
  { id: '3', claim: 'there is NO usage event', watch: 'no server event carrying a usage/seconds field' },
  { id: '4', claim: 'ConversationText is UTTERANCE-level, not deltas', watch: 'each ConversationText carries a whole utterance, not a fragment' },
]

if (PLAN || KEY === undefined) {
  console.log('Deepgram Voice Agent — P1 wire probe')
  console.log(`endpoint  ${ENDPOINT}`)
  console.log(`sources   ${DOCS}`)
  console.log(`key       ${KEY === undefined ? 'absent — nothing sent' : 'present'}`)
  console.log('')
  console.log('assumptions to convert from ❓ to ✅/❌ (ADR-012):')
  for (const check of CHECKS) console.log(`  ${check.id}. ${check.claim}\n     watched by: ${check.watch}`)
  console.log('')
  console.log('it would send:')
  console.log(JSON.stringify(settings(process.env.DEEPGRAM_PROBE_ENDPOINT ?? 'https://example.invalid/v1/chat/completions'), null, 1)
    .split('\n').map(line => `  ${line}`).join('\n'))
  console.log('')
  console.log('then `InjectUserMessage` to open a turn, `InjectAgentMessage` during it, `UpdatePrompt` twice between two')
  console.log('turns, and record every server frame to the output file for the record.')
  console.log('')
  console.log(KEY === undefined ? 'SKIPPED — set DEEPGRAM_API_KEY to run it. Nothing was sent.' : '')
  process.exit(0)
}

const transcript = []
const verdicts = new Map()
const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Token ${KEY}` } })
const guard = setTimeout(() => { console.error('probe timed out'); finish(2) }, TIMEOUT_MS)

const send = frame => ws.send(JSON.stringify(frame))
const note = (id, verdict, why) => { if (!verdicts.has(id)) verdicts.set(id, { verdict, why }) }

ws.on('open', () => send(settings(process.env.DEEPGRAM_PROBE_ENDPOINT ?? '')))
ws.on('error', error => { console.error(`socket error: ${error.message}`); finish(2) })
ws.on('message', raw => {
  const text = raw.toString()
  let frame
  try { frame = JSON.parse(text) } catch { transcript.push({ binary: text.length }); return }
  transcript.push(frame)
  switch (frame.type) {
    case 'SettingsApplied':
      // A text injection opens a turn without audio: the cheapest honest turn this probe can buy.
      send({ type: 'InjectUserMessage', content: 'Say exactly: probe one.' })
      break
    case 'UserStartedSpeaking':
      // Mid-turn injection: the question is whether the provider accepts it or refuses it.
      send({ type: 'InjectAgentMessage', message: 'A step is running.' })
      break
    case 'InjectionRefused':
      note('2', 'CONTRADICTED', 'the provider refused InjectAgentMessage mid-turn')
      break
    case 'ConversationText':
      // Utterance-level would carry a complete `content`; a delta would carry a fragment.
      if (typeof frame.content === 'string' && frame.content.trim().split(/\s+/).length >= 2) {
        note('4', 'CONFIRMED', 'ConversationText carried a whole utterance')
      }
      break
    case 'LatencyReport':
      transcript.push({ latency: frame })
      break
    case 'AgentAudioDone':
      // Between turns: change the prompt twice, and see whether the first survives into the next answer.
      send({ type: 'UpdatePrompt', prompt: 'Reply with exactly: probe two.' })
      send({ type: 'UpdatePrompt', prompt: 'Reply with exactly: probe one.' })
      send({ type: 'InjectUserMessage', content: 'What do you say?' })
      break
    default:
      if (/usage|seconds|billing/i.test(text)) note('3', 'CONTRADICTED', `a server event mentioned usage: ${frame.type}`)
  }
  if (Object.keys(verdicts).length >= 2 && transcript.length > 40) finish()
})

function finish(code = 0) {
  clearTimeout(guard)
  try { ws.close() } catch { /* already closed */ }
  const contradicted = [...verdicts.values()].filter(v => v.verdict === 'CONTRADICTED').length
  console.log('')
  for (const check of CHECKS) {
    const got = verdicts.get(check.id)
    console.log(`  ${check.id}. ${got ? got.verdict : 'INCONCLUSIVE'} — ${check.claim}`)
    if (got) console.log(`     ${got.why}`)
  }
  console.log('')
  if (OUT !== undefined) {
    writeFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), endpoint: ENDPOINT, docs: DOCS,
      verdicts: Object.fromEntries(verdicts), frames: transcript }, null, 1)}\n`)
    console.log(`transcript written to ${OUT}`)
  }
  process.exit(contradicted > 0 ? 1 : code)
}
