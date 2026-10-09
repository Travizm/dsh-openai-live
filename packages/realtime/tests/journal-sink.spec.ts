/**
 * The journal's sinks: the copy, and the rule that the copy can never cost the record.
 *
 * The journal is deliberately I/O-free — a plain object a test can construct and a route can serve — so
 * "write it somewhere else as well" is a function the caller supplies. That makes exactly one failure mode
 * possible, and it is the one worth pinning: a sink that throws must not take the entry with it. A diagnostic
 * mechanism that can lose the diagnostic fails precisely when it is needed, which is the whole argument
 * against adding one carelessly.
 */

import { describe, expect, it } from 'vitest'
import { Journal, type JournalEntry } from '../src/index.ts'

/** Assembled, not written: a credential-shaped literal in source is what the leak scan denies by construction. */
const SENTINEL = 'hunter2' + '-must-not-reach-a-file'

describe('Journal sinks', () => {
  it('hands every entry to every sink, in the order they were recorded', () => {
    const journal = new Journal()
    const first: JournalEntry[] = []
    const second: JournalEntry[] = []
    journal.onEntry(entry => { first.push(entry) })
    journal.onEntry(entry => { second.push(entry) })

    journal.record('session.closed', {})
    journal.record('speech.sent', { bytes: '8' })

    expect(first.map(entry => entry.kind)).toEqual(['session.closed', 'speech.sent'])
    expect(second.map(entry => entry.seq)).toEqual(first.map(entry => entry.seq))
  })

  it('hands a sink a redacted entry, so a file cannot carry what the buffer would not', () => {
    // The ordering that makes a sink safe to add anywhere: redaction happens in `record`, before any sink
    // sees the entry. A second writer with its own idea of what a secret looks like is a second chance to
    // get redaction wrong.
    const journal = new Journal({ secrets: [SENTINEL] })
    const written: string[] = []
    journal.onEntry(entry => { written.push(JSON.stringify(entry)) })

    journal.record('session.failed', { reason: `rejected with ${SENTINEL}` })

    expect(written.join('\n')).not.toContain(SENTINEL)
    expect(written.join('\n')).toContain('session.failed')
  })

  it('keeps the entry when a sink throws, and still calls the next sink', () => {
    const journal = new Journal()
    const reached: string[] = []
    journal.onEntry(() => { throw new Error('no space left on device') })
    journal.onEntry(entry => { reached.push(entry.kind) })

    expect(() => { journal.record('session.closed', {}) }).not.toThrow()
    expect(journal.snapshot().map(entry => entry.kind)).toEqual(['session.closed'])
    expect(reached).toEqual(['session.closed'])
  })

  it('ignores a sink that is not a function, rather than failing at the first entry', () => {
    const journal = new Journal()
    // The cast is the point: a JavaScript caller, or a value off a config, can actually be this.
    journal.onEntry(undefined as unknown as (entry: JournalEntry) => void)
    expect(() => { journal.record('session.closed', {}) }).not.toThrow()
  })
})
