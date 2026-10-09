/**
 * The journal: a bounded, redaction-safe record of what the plugin did.
 *
 * S1 story 2, and the substrate for the rest of the sprint — the diagnostics route serves it, the
 * spoken failures narrate from it, and the fault-injection matrix asserts against it. It exists
 * because every failure this project has spent hours on was *unobservable* rather than wrong: the
 * delegation that produced nothing, the append nobody heard, the socket the host refused. A journal
 * turns each of those into a line.
 *
 * Three properties are load-bearing, and each is a test rather than a promise:
 *
 * - **Redaction happens on write, not on read.** A journal that stores the raw text and redacts when
 *   serving it has already leaked: the secret is in memory, in a crash dump, and in whatever later
 *   edit forgets the second step. Every string is passed through {@link redact} *before* it is
 *   retained, so there is no unredacted copy to forget about. (That is design.md invariant 3 —
 *   credentials proven safe by a test that fails on a planted string.)
 * - **Bounded, with eviction visible.** The buffer keeps the last `capacity` entries. Every entry
 *   carries a monotonic {@link JournalEntry.seq}, so a reader can tell that earlier entries were
 *   dropped rather than never recorded — a ring buffer that silently truncates is how "the log is
 *   empty" becomes indistinguishable from "nothing happened".
 * - **Ack is not delivery.** Invariant 6: an acknowledgement proves injection, not that anyone heard
 *   it. `append.acknowledged` and `speech.played` are separate kinds with separate entries, and
 *   nothing here merges them into one "sent" line.
 *
 * @module dsh-realtime/journal
 */

import { redact } from './redact.ts'

/** Entries retained when a caller does not say otherwise. */
export const DEFAULT_JOURNAL_CAPACITY = 200

/**
 * What a journal entry can describe.
 *
 * The list is deliberately small and closed: an entry kind is a contract with whatever reads the
 * journal later, so adding one is a considered act rather than a free-form log line.
 */
export type JournalKind =
  /** A voice session opened, or was asked to and could not. */
  | 'session.opened' | 'session.closed' | 'session.failed'
  /** The audio route accepted a socket, or refused one and said why. */
  | 'socket.accepted' | 'socket.rejected'
  /** The model raised a delegation, and the id it will be correlated by. */
  | 'delegation.seen'
  /** A delegated turn was admitted to the session, refused, declined, or ran out of window. */
  | 'prompt.admitted' | 'prompt.refused' | 'prompt.declined' | 'window.elapsed'
  /** A turn produced an answer. */
  | 'answer.received'
  /** A context append was acknowledged on the wire. Not delivery — see invariant 6. */
  | 'append.acknowledged'
  /** Audio was actually handed to the output path. Not an acknowledgement. */
  | 'speech.played'
  /** The configuration as resolved, so a journal can be read without the profile beside it. */
  | 'config.resolved'

/** One retained entry. */
export interface JournalEntry {
  /**
   * Monotonic sequence number, never reused and never reset within one journal instance.
   *
   * A gap between the oldest retained `seq` and the newest means entries were evicted, which is the
   * difference between "nothing happened" and "the buffer rolled over".
   */
  readonly seq: number
  /** Milliseconds since the epoch, as the injecting caller saw it. */
  readonly at: number
  /** What happened. */
  readonly kind: JournalKind
  /** Redacted detail fields; keys are the caller's, values are already safe to serve. */
  readonly detail: Readonly<Record<string, string>>
}

/** How a journal is constructed. */
export interface JournalOptions {
  /** Entries retained before the oldest is evicted. */
  capacity?: number
  /**
   * Values that must never appear in an entry, however they are spelled.
   *
   * The route's capability token is 32 random bytes of base64url: it has no prefix and no structure,
   * so no pattern can catch it and only a caller holding it can name it. The provider key is
   * normally caught by shape, but pass it here too — a seam that relies on shape alone fails the
   * moment a vendor changes its prefix.
   */
  secrets?: readonly string[]
}

/**
 * A bounded, redaction-safe journal of plugin activity.
 *
 * Not a service: it is a plain object so it can be constructed in a test, handed to a route, and
 * read without a Cordis context. The seam owns one instance and lends it to the plugins that write
 * to it.
 */
export class Journal {
  private readonly capacity: number
  private readonly secrets: string[]
  private readonly entries: JournalEntry[] = []
  private nextSeq = 1

  /**
   * @param options - capacity and the values that must never be retained.
   * @throws RangeError when `capacity` is not a positive integer — a journal that retains nothing
   *   is a failure that looks like silence, which is the defect this module exists to remove.
   */
  constructor(options: JournalOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_JOURNAL_CAPACITY
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`journal capacity must be a positive integer, received ${String(capacity)}`)
    }
    this.capacity = capacity
    this.secrets = [...options.secrets ?? []]
  }

  /**
   * Add values that must never be retained, from a plugin that has only just learned them.
   *
   * Additive rather than a constructor argument because secrets arrive with the plugins that hold
   * them, and plugins load in no guaranteed order: the route's capability token does not exist until
   * the plugin that mints it applies, and a provider key arrives with whichever plugin reads the
   * environment. A journal that could only be seeded at construction would have to be replaced to
   * learn either — which is how a sink ends up with two instances and a reader with half a story.
   * @param values - secrets to add; empty and duplicate values are ignored.
   */
  addSecrets(values: readonly string[]): void {
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0) continue
      if (!this.secrets.includes(value)) this.secrets.push(value)
    }
  }

  /**
   * Redact and retain one entry, evicting the oldest when the buffer is full.
   * @param kind - what happened.
   * @param detail - string fields to retain; every value is redacted before it is stored.
   * @param at - epoch milliseconds; defaults to now, and is injectable so a test can pin a time.
   * @returns the entry exactly as it was retained, so a caller can correlate on `seq`.
   */
  record(kind: JournalKind, detail: Readonly<Record<string, string>> = {}, at: number = Date.now()): JournalEntry {
    const safe: Record<string, string> = {}
    for (const [key, value] of Object.entries(detail)) {
      safe[key] = redact(value, this.secrets)
    }
    const entry: JournalEntry = Object.freeze({
      seq: this.nextSeq++,
      at,
      kind,
      detail: Object.freeze(safe),
    })
    this.entries.push(entry)
    // `shift()` on a bounded array: the buffer is capped, so this stays O(capacity) at worst and
    // the memory ceiling is a property of the type rather than of the caller's discipline.
    while (this.entries.length > this.capacity) this.entries.shift()
    return entry
  }

  /**
   * Every retained entry, oldest first.
   *
   * Detached: mutating the result cannot reach the journal, so a route serving this cannot be used
   * to tamper with the record it is reporting.
   * @returns a detached, chronologically ordered copy.
   */
  snapshot(): JournalEntry[] {
    return this.entries.map(entry => ({ ...entry, detail: { ...entry.detail } }))
  }

  /** Entries currently retained. */
  get size(): number {
    return this.entries.length
  }

  /** Sequence number of the oldest retained entry, or `undefined` when empty. */
  get oldestSeq(): number | undefined {
    return this.entries[0]?.seq
  }
}
