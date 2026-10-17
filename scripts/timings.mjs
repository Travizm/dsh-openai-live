#!/usr/bin/env node
/**
 * Turn timings from a journal file — the readout ADR-012 asks for before a second provider is built.
 *
 * The measurement itself lives in `packages/realtime/src/metrics.ts`, where it has tests and 100% coverage.
 * This file only reads a file and prints, so the number a person acts on is the number the suite checks.
 *
 * usage: node scripts/timings.mjs [journal.jsonl] [--run <runId>]
 *        pnpm timings [journal.jsonl]
 *
 * Milestones are printed in seconds, because a turn that takes 2400 ms is a turn that takes 2.4 s — the unit
 * a person at a microphone experiences, and the unit a budget gets set in.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const runIndex = args.indexOf('--run')
const runFilter = runIndex >= 0 ? args[runIndex + 1] : undefined
const path = resolve(args.find((a, i) => !a.startsWith('--') && (runIndex < 0 || i !== runIndex + 1))
  ?? join(homedir(), '.dsh/realtime-journal.jsonl'))

const { summariseTimings } = await import(join(root, 'packages/realtime/lib/index.js'))

let lines
try { lines = readFileSync(path, 'utf8').split('\n') } catch (error) {
  console.error(`cannot read ${path}: ${error.message}`)
  process.exit(1)
}
const entries = []
for (const line of lines) {
  const text = line.trim()
  if (!text.startsWith('{')) continue
  try {
    const entry = JSON.parse(text)
    if (runFilter === undefined || entry.runId === runFilter) entries.push(entry)
  } catch { /* a truncated last line is the normal case for a journal being appended to */ }
}
if (entries.length === 0) {
  console.error(`no journal entries in ${path}${runFilter ? ` for run ${runFilter}` : ''}`)
  process.exit(1)
}

const runIds = [...new Set(entries.map(e => e.runId))]
const summary = summariseTimings(entries)
const secs = ms => `${(ms / 1000).toFixed(2)}s`
const span = entries.length ? `${new Date(Math.min(...entries.map(e => e.at))).toISOString().slice(0, 16)} → ${new Date(Math.max(...entries.map(e => e.at))).toISOString().slice(0, 16)}` : ''

console.log(`journal  ${path}`)
console.log(`entries  ${entries.length} · runs ${runIds.length}${runFilter ? ' (filtered)' : ''}${span ? ` · ${span}` : ''}`)
console.log(`turns    ${summary.measured} measured · ${summary.excluded.length} never completed`)
console.log(`reading  ${summary.recorded} with the responder's own agent duration · ${summary.derived} derived from boundaries only`)
if (summary.derived > 0 && summary.recorded === 0) {
  console.log('         (boundary-only turns cannot separate admission from answer: both entries are written at')
  console.log('          settlement, so the agent stage reads as a residue — recorded turns do not have this limit)')
}
console.log()
console.log('stage        turns      p50      p90      max')
for (const stage of ['admission', 'answer', 'total']) {
  const s = summary.stages[stage]
  console.log(`${stage.padEnd(12)} ${String(s.n).padStart(5)}  ${secs(s.p50).padStart(8)} ${secs(s.p90).padStart(8)} ${secs(s.max).padStart(8)}`)
}
if (summary.excluded.length) {
  console.log()
  console.log(`never completed: ${summary.excluded.join(', ')}`)
}
console.log()
console.log('admission = delegation.seen → prompt.admitted · answer = prompt.admitted → answer.received')
console.log('total     = delegation.seen → answer.received · percentiles are nearest-rank')
