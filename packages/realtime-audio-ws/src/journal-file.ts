/**
 * A journal sink that appends to a file, so the record outlives the process that made it.
 *
 * The journal has always *held* everything worth knowing and has always been unable to hand it over: it is
 * served over a route that wants a per-boot capability token, which means the record can be read by the page
 * that holds the token and by nobody else, and it cannot be read after the fact at all. Every failure this
 * plugin has had was diagnosed by reading somebody else's log — a harness session file off disk, or a
 * `curl` at a route that answered 401. This is the missing half: the same entries, on disk, readable with
 * `cat` by whoever is handed the file.
 *
 * ## Why `appendFileSync`, deliberately
 *
 * The ordering of a diagnostic record is the record. An asynchronous append can interleave two entries or
 * lose one to a process that exits during the write, and the failure this exists to explain is usually the
 * last thing that happened. So each line is written synchronously, as one line, and a reader can trust that
 * the file is ordered and complete up to the last entry it contains.
 *
 * ## Redaction already happened
 *
 * A sink is handed entries *after* `Journal.record` has redacted them, so the file carries exactly what the
 * route would have served and never the values named in `redactSecrets`. That ordering is the whole reason
 * this is a sink and not a second writer with its own copy of the redaction rules — two code paths that must
 * agree about what a secret looks like are two code paths that eventually disagree.
 *
 * @module dsh-realtime-audio-ws/journal-file
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { JournalEntry } from 'dsh-realtime'

/**
 * Build a sink that appends each entry to `path` as one JSON object per line.
 *
 * The parent directory is created here, at construction, rather than on the first write. That is the one
 * failure this can have that is worth being loud about — a path that cannot be written — and at construction
 * it is a startup error a caller can refuse to launch on, instead of a silent nothing that looks exactly
 * like a quiet session. A *later* write that fails is swallowed by `Journal.onEntry`'s guard, by design.
 * @param path - absolute or relative file path; the file is appended to, never truncated.
 * @returns the sink, ready for `Journal.onEntry`.
 */
export function createJournalFileSink(path: string): (entry: JournalEntry) => void {
  mkdirSync(dirname(path), { recursive: true })
  return (entry: JournalEntry): void => {
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
  }
}
