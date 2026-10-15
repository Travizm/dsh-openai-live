#!/usr/bin/env node
/**
 * Provenance gate — replay a recorded session log and assert, per verb, that the write carries the right
 * provenance.
 *
 * ## Why this is a separate program reading a file
 *
 * An in-process assertion and the code it checks share a lifetime, so a verifier living in the same process
 * agrees with the producer **by construction** — it is a restatement, not a gate. The only shape that can
 * disagree is a **file, read by a different program**. So the composition *emits* a record and this reads it.
 *
 * ## The expectations are literals here, never imported
 *
 * A checker that derives its expectations from its subject can only ever agree with it. The framing phrases
 * below are therefore written out, not imported from `packages/realtime-responder/src/deliver.ts`. If the
 * frame changes, this fails and somebody decides whether the change was intended — which is the point.
 *
 * ## The verb is the path, so it is asserted as the path
 *
 * There is deliberately no `verb` field on the message (a field would be a second statement of the verb
 * that could disagree with the delivery path). So the verb is checked where it actually lives: a **note**
 * targets `next-step` with `wakeup: false` and records **no** change; a **say** targets `next-turn` with
 * `wakeup: true` and records exactly one `realtime/change` **between the write and the barrier**.
 *
 * ## What this deliberately does NOT assert, and why
 *
 * The exit criteria also want *no `turn/start` for a note, a `turn/start` for a say*. **That is not asserted
 * here**, and the reason is a measurement rather than a preference: the agent loop is the host's and is not
 * present in this repo, so a `turn/start` in this record could only come from the fake that models it —
 * which would be a check agreeing with a model of the system instead of with the system. Recorded as a gap
 * so its absence cannot be read as coverage. Settling it needs a real session.
 *
 * ## It refuses to pass over nothing
 *
 * A checker that read no files must say `UNVERIFIED`, never clean: otherwise a fresh clone, a deleted build
 * and an empty directory all read as green — the same defect as a guard with no failing branch.
 *
 * Usage: node scripts/provenance-verify.mjs --root <dir>   (reads every *.jsonl under it)
 *        node scripts/provenance-verify.mjs --self-test
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Literals, deliberately not imported — see the module note. */
const SAY_FRAME_PHRASE = 'not user consent'
const NOTE_FRAME_PHRASE = 'context only'
/** The general plugin kind, and the name this producer writes under. */
const SOURCE_KIND = 'plugin'
const SOURCE_PLUGIN = 'realtime'
const CHANGE_TYPE = 'realtime/change'
const WRITE_TYPE = 'voice/write'
const BARRIER_TYPE = 'session/flushed'

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

/** Every `*.jsonl` under a directory, so a record can be laid out any way a caller likes. */
function recordsUnder(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.jsonl')) found.push(path)
    }
  }
  walk(root)
  return found
}

/**
 * Assert one record's per-verb provenance.
 * @param events - the parsed events, oldest first.
 * @param label - what to name in a failure message.
 */
function verifyRecord(events, label) {
  const writes = events.map((entry, index) => ({ ...entry, index })).filter(e => e.event?.type === WRITE_TYPE)
  const changes = events.map((entry, index) => ({ ...entry, index })).filter(e => e.event?.type === CHANGE_TYPE)
  const barriers = events.map((entry, index) => ({ ...entry, index })).filter(e => e.event?.type === BARRIER_TYPE)

  check(writes.length > 0, `${label}: no write was recorded at all`)

  for (const write of writes) {
    const data = write.event.data ?? {}
    // The producer's identity, on every write, from code — the field the log is read back through and the
    // one no model-supplied value may name.
    check(data.source?.kind === SOURCE_KIND,
      `${label}: write ${data.id} carried source kind ${JSON.stringify(data.source?.kind)}`)
    check(data.source?.plugin === SOURCE_PLUGIN,
      `${label}: write ${data.id} carried plugin ${JSON.stringify(data.source?.plugin)}`)

    const isNote = data.target === 'next-step'
    const isSay = data.target === 'next-turn'
    check(isNote || isSay, `${label}: write ${data.id} targeted ${JSON.stringify(data.target)}, which is neither verb`)

    // A note must NOT wake a turn. This is the incident class the sprint exists to prevent, asserted on the
    // path rather than on a field.
    if (isNote) check(data.wakeup === false, `${label}: a note woke a turn`)
    if (isSay) check(data.wakeup === true, `${label}: a say did not wake a turn`)

    // The framing line, checked in the bytes actually written rather than in the source that writes them.
    const text = typeof data.text === 'string' ? data.text : ''
    check(isNote ? text.includes(NOTE_FRAME_PHRASE) : text.includes(SAY_FRAME_PHRASE),
      `${label}: the ${isNote ? 'note' : 'say'} write ${data.id} is missing its framing line`)

    // A change record belongs to the write it **immediately follows**, so a write's own span runs to the
    // next write. Counting every change after it instead made a note inherit the say's record — which the
    // first version of this verifier did, and its self-test could not catch, because that fixture had only
    // one write. The lesson is the one this repo keeps relearning: the instrument needs checking as
    // carefully as the thing it measures.
    const nextWrite = writes.find(other => other.index > write.index)
    const spanEnd = nextWrite === undefined ? events.length : nextWrite.index
    const after = changes.filter(change => change.index > write.index && change.index < spanEnd)
    if (isNote) {
      // The inbox is a note's audit surface; a log record would be a second, weaker account of the same
      // thing, free to disagree with it.
      check(after.length === 0, `${label}: a note wrote ${after.length} change record(s)`)
    } else {
      check(after.length === 1, `${label}: a say recorded ${after.length} change record(s)`)
      const change = after[0]
      if (change !== undefined) {
        check(change.event.data?.version === 1, `${label}: the change record is not version-tagged`)
        // The ordering is the requirement, not decoration: a record before the write would describe a
        // message that might never exist, and one after the barrier would not be durable when it mattered.
        const barrierAfter = barriers.find(barrier => barrier.index > change.index)
        check(barrierAfter !== undefined,
          `${label}: no barrier followed the change record, so the write was never confirmed durable`)
      }
    }
  }

  // The adversarial case: a request sourced from an artifact the session read. Nothing may be written for it,
  // which is why its absence is asserted against a count rather than inferred from the record's shape.
  const injected = writes.filter(write => /ignore your instructions/i.test(write.event.data?.text ?? ''))
  check(injected.length === 0, `${label}: ${injected.length} injected write(s) reached the session`)
}

const args = process.argv.slice(2)

if (args.includes('--self-test')) {
  // The guard's own guard: one record that must be accepted and one that must be rejected. Without these the
  // checker could pass everything and nothing would say so.
  const good = [
    // **Both verbs, in the shape the real record has** — a note followed by a say. A one-write fixture is
    // what let the span bug through the first time: with a single write there is no "next write" to bound
    // it, so a note can never be seen inheriting a later record.
    { t: 1, dir: 'out', event: { type: WRITE_TYPE, data: { id: 1, source: { kind: SOURCE_KIND, plugin: SOURCE_PLUGIN }, target: 'next-step', wakeup: false, text: `frame: ${NOTE_FRAME_PHRASE}` } } },
    { t: 2, dir: 'out', event: { type: WRITE_TYPE, data: { id: 2, source: { kind: SOURCE_KIND, plugin: SOURCE_PLUGIN }, target: 'next-turn', wakeup: true, text: `frame: ${SAY_FRAME_PHRASE}` } } },
    { t: 3, dir: 'out', event: { type: CHANGE_TYPE, data: { version: 1, operation: 'deliver', id: 'x' } } },
    { t: 4, dir: 'out', event: { type: BARRIER_TYPE, data: {} } },
  ]
  const bad = [good[0], good[1], good[3], good[2]] // the change recorded after the barrier
  const wrongKind = [good[0], { ...good[1], event: { ...good[1].event, data: { ...good[1].event.data, source: { kind: 'user' } } } }, good[2], good[3]]
  // The regression the guard-proof exercised end to end: a note that woke a turn. Asserted here as well,
  // because in the full chain the composition's own in-process check fires first and aborts before this
  // verifier ever sees the record — so without this case the log gate's *own* bite on that regression would
  // be asserted nowhere.
  const noteWoke = [{ ...good[0], event: { ...good[0].event, data: { ...good[0].event.data, wakeup: true } } }, good[1], good[2], good[3]]
  const save = [...failures]
  verifyRecord(good, 'self-test/accepted')
  const accepted = failures.length === save.length
  failures.length = save.length
  verifyRecord(bad, 'self-test/rejected')
  const rejected = failures.length > save.length
  failures.length = save.length
  // The provenance assertion itself, on a record whose source is somebody else's: the one failure that
  // means the log cannot be trusted about who wrote it.
  verifyRecord(wrongKind, 'self-test/wrong-kind')
  const wrongKindRejected = failures.length > save.length
  failures.length = save.length
  verifyRecord(noteWoke, 'self-test/note-woke')
  const noteWokeRejected = failures.length > save.length
  failures.length = save.length
  check(accepted, 'self-test: a correct record was rejected')
  check(rejected, 'self-test: an out-of-order record was accepted')
  check(wrongKindRejected, 'self-test: a foreign source kind was accepted')
  check(noteWokeRejected, 'self-test: a note that woke a turn was accepted')
  if (failures.length > 0) {
    console.error('FAIL provenance verifier self-test:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('PASS provenance verifier self-test — an accepted record passes, an out-of-order one is refused')
  process.exit(0)
}

const rootArg = args.find(arg => arg.startsWith('--root='))?.slice('--root='.length)
  ?? (args.indexOf('--root') >= 0 ? args[args.indexOf('--root') + 1] : undefined)

if (rootArg === undefined) {
  console.error('FAIL provenance verify: no --root given')
  process.exit(2)
}

const records = recordsUnder(rootArg)
if (records.length === 0) {
  // Never clean over nothing. See the module note.
  console.error(`UNVERIFIED provenance verify — no *.jsonl under ${rootArg}, so nothing was checked`)
  process.exit(1)
}

for (const path of records) {
  const events = readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').map((line) => {
    try { return JSON.parse(line) } catch { return undefined }
  })
  if (events.some(event => event === undefined)) {
    failures.push(`${path}: a line did not parse as JSON`)
    continue
  }
  verifyRecord(events, path)
}

if (failures.length > 0) {
  console.error('FAIL provenance verify — the recorded log does not carry the provenance it should:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`PASS provenance verify — ${records.length} record(s), provenance intact per verb`)
