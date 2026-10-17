#!/usr/bin/env node
/**
 * Measure a recorded session: latency where it is felt, cost where it is billed.
 *
 * Reads a JSONL recording written by `scripts/record-deepgram-session.mjs`, summarises it with the pure functions
 * in `dsh-realtime-deepgram` (which are tested), and prints the numbers a planning conversation needs.
 *
 * The cost line names its tier and its source, because the published rates differ by a third between compositions
 * and a figure with no tier attached is a figure nobody can check.
 *
 * usage:  node scripts/deepgram-cost.mjs <recording.jsonl> [--tier standard|byoLlm|byoLlmAndTts|standardByoTts]
 */
import { readFileSync } from 'node:fs'
import { RATES_SOURCE, VOICE_AGENT_RATES, audioMs, cost, summarise } from '../packages/realtime-deepgram/lib/index.js'

const path = process.argv[2]
if (path === undefined) {
  console.error('usage: node scripts/deepgram-cost.mjs <recording.jsonl> [--tier <tier>]')
  process.exit(2)
}
const tierIndex = process.argv.indexOf('--tier')
const tier = tierIndex >= 0 ? process.argv[tierIndex + 1] : 'standard'
if (!(tier in VOICE_AGENT_RATES)) {
  console.error(`unknown tier ${tier}; one of ${Object.keys(VOICE_AGENT_RATES).join(', ')}`)
  process.exit(2)
}

const entries = readFileSync(path, 'utf8')
  .split('\n')
  .filter(line => line.trim().startsWith('{'))
  .map(line => JSON.parse(line))
const summary = summarise(entries)

const secs = ms => `${(ms / 1000).toFixed(2)}s`
const usd = value => `$${value.toFixed(6)}`

console.log(`recording    ${path} · ${entries.length} frames`)
console.log(`connection   ${secs(summary.connectionMs)}  (the billed quantity)`)
console.log('')
console.log('latency')
console.log(`  first sound   ${summary.firstAudioMs === undefined ? 'never' : secs(summary.firstAudioMs)}  from the first frame`)
console.log(`  audio out     ${secs(audioMs(summary.outputAudioBytes, 24_000))} across ${summary.outputAudioBytes} bytes`)
console.log(`  audio in      ${secs(audioMs(summary.inputAudioBytes, 16_000))} across ${summary.inputAudioBytes} bytes`)
console.log(`  frames        ${summary.framesOut} out · ${summary.framesIn} in`)
if (summary.transcripts.length > 0) {
  console.log('')
  console.log('transcripts')
  for (const text of summary.transcripts) console.log(`  · ${text}`)
}
console.log('')
console.log(`cost         ${usd(cost(summary, tier))} at ${tier} ($${VOICE_AGENT_RATES[tier].toFixed(3)}/min)`)
console.log(`             ${RATES_SOURCE}`)
console.log('')
console.log(`per call-minute, extended: ${usd(VOICE_AGENT_RATES[tier])}/min → ` +
  `${usd(VOICE_AGENT_RATES[tier] * 60)}/hour of connected voice`)
