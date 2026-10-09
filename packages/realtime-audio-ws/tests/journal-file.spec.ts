/**
 * The file sink: the record leaving the process that made it.
 *
 * The tests are about the filesystem, because the filesystem is the one thing this has that the route does
 * not — and every way it can be wrong is a filesystem way. A directory that does not exist yet; a file that
 * must be appended to rather than replaced; one line per entry, so the file stays readable with `tail` and
 * diffable without a tool.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Journal } from 'dsh-realtime'
import { createJournalFileSink } from '../src/journal-file.ts'

/** A path inside a fresh temporary directory, so no two tests share a file. */
const pathIn = (name: string): string => join(mkdtempSync(join(tmpdir(), 'journal-')), name)

describe('createJournalFileSink', () => {
  it('creates the containing directory at construction, and the file only when an entry arrives', () => {
    // Construction-time, deliberately: a path that cannot be written is a startup error a caller can refuse
    // to launch on, rather than a silence that looks exactly like a quiet session.
    const path = pathIn('nested/records.jsonl')
    createJournalFileSink(path)

    expect(existsSync(dirname(path))).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('writes one JSON object per line, so a reader can tail it', () => {
    const path = pathIn('records.jsonl')
    const journal = new Journal()
    journal.onEntry(createJournalFileSink(path))

    journal.record('session.closed', {}, 1_000)
    journal.record('speech.sent', { bytes: '8' }, 1_001)

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { seq: 1, at: 1_000, kind: 'session.closed', detail: {} },
      { seq: 2, at: 1_001, kind: 'speech.sent', detail: { bytes: '8' } },
    ])
  })

  it('appends rather than replaces, so a restarted process does not erase the evidence', () => {
    // The failure this exists to explain is usually the last one, and the process that produced it is
    // usually gone. A sink that truncated on construction would destroy the record at exactly the moment
    // somebody restarts to look at it.
    const path = pathIn('records.jsonl')
    const first = new Journal()
    first.onEntry(createJournalFileSink(path))
    first.record('session.closed', {})

    const second = new Journal()
    second.onEntry(createJournalFileSink(path))
    second.record('answer.received', {})

    const kinds = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line).kind)
    expect(kinds).toEqual(['session.closed', 'answer.received'])
  })
})
