import { describe, expect, it } from 'vitest'
import { DEFAULT_JOURNAL_CAPACITY, Journal, REDACTED } from '../src/index.ts'

/**
 * Assembled and derived, never written as a literal. A credential-shaped string in source fails the
 * build twice over: the repo's own leak scan denies `sk-…` by construction, and a pipeline running
 * gitleaks fails on the entropy of a realistic token even though it carries no prefix at all. The
 * same bytes exercise the same paths with nothing in the file.
 */
const API_KEY = ['sk', 'fixture', 'k'.padEnd(20, '0')].join('-')
const ROUTE_TOKEN = Buffer.from(Uint8Array.from({ length: 32 }, (_unused, index) => (index * 7 + 3) % 256)).toString('base64url')

describe('Journal', () => {
  it('retains a default capacity and evicts the oldest once full', () => {
    const journal = new Journal()
    for (let index = 0; index < DEFAULT_JOURNAL_CAPACITY + 1; index += 1) {
      journal.record('delegation.seen', { id: String(index) }, index)
    }

    expect(journal.size).toBe(DEFAULT_JOURNAL_CAPACITY)
    // A gap between the first retained seq and 1 is how a reader tells eviction from silence.
    expect(journal.oldestSeq).toBe(2)
    expect(journal.snapshot()[0]?.detail.id).toBe('1')
  })

  it('rejects a capacity that could retain nothing', () => {
    // A journal that keeps nothing is a failure that looks exactly like success.
    expect(() => new Journal({ capacity: 0 })).toThrow(RangeError)
    expect(() => new Journal({ capacity: -1 })).toThrow(RangeError)
    expect(() => new Journal({ capacity: 1.5 })).toThrow(RangeError)
  })

  it('redacts by shape before retaining, so no unredacted copy exists', () => {
    const journal = new Journal()
    journal.record('prompt.refused', { reason: `invalid api key ${API_KEY} for model gpt-live-1` })

    expect(journal.snapshot()[0]?.detail.reason).toBe(`invalid api key ${REDACTED} for model gpt-live-1`)
    expect(JSON.stringify(journal.snapshot())).not.toContain(API_KEY)
  })

  it('redacts a value the caller holds, which no pattern can catch', () => {
    // The route token has no prefix and no structure: 32 random bytes in base64url.
    const journal = new Journal({ secrets: [ROUTE_TOKEN] })
    journal.record('socket.rejected', { verdict: '401', url: `/dsh-realtime/audio?token=${ROUTE_TOKEN}` })

    expect(journal.snapshot()[0]?.detail.url).toBe(`/dsh-realtime/audio?token=${REDACTED}`)
    expect(JSON.stringify(journal.snapshot())).not.toContain(ROUTE_TOKEN)
  })

  it('redacts every field, leaving the clean ones readable', () => {
    const journal = new Journal({ secrets: [ROUTE_TOKEN] })
    journal.record('socket.rejected', {
      verdict: '403',
      url: `/dsh-realtime/audio?token=${ROUTE_TOKEN}`,
      peer: '127.0.0.1',
    })

    const entry = journal.snapshot()[0]
    expect(entry?.detail.verdict).toBe('403')
    expect(entry?.detail.peer).toBe('127.0.0.1')
    expect(entry?.detail.url).toBe(`/dsh-realtime/audio?token=${REDACTED}`)
  })

  it('stamps a monotonic sequence and an injectable time', () => {
    const journal = new Journal()
    const first = journal.record('session.opened', { provider: 'openai-live' }, 1_700_000_000_000)
    const second = journal.record('session.closed', {}, 1_700_000_001_000)

    expect([first.seq, second.seq]).toEqual([1, 2])
    expect([first.at, second.at]).toEqual([1_700_000_000_000, 1_700_000_001_000])
    // Defaulted time and detail: both optional, both real.
    const third = journal.record('window.elapsed')
    expect(third.detail).toEqual({})
    expect(Math.abs(third.at - Date.now())).toBeLessThan(5_000)
  })

  it('keeps an acknowledgement and a handover separate (invariant 6)', () => {
    const journal = new Journal()
    journal.record('append.acknowledged', { eventId: 'event_1' })
    journal.record('speech.sent', { eventId: 'event_1' })

    // Two entries, two kinds, and neither one claims delivery. The acknowledgement says a provider took
    // the append; the sent entry says the host handed audio to the transport. Whether a speaker rendered
    // it is known only to the page, so merging these into one "delivered" line is what the invariant
    // forbids — and naming the second one `played` would be the same mistake with better manners.
    expect(journal.size).toBe(2)
    expect(journal.snapshot().map(entry => entry.kind)).toEqual(['append.acknowledged', 'speech.sent'])
  })

  it('hands out a detached snapshot that cannot tamper with the record', () => {
    const journal = new Journal()
    const retained = journal.record('answer.received', { text: 'the README says so' })

    expect(Object.isFrozen(retained.detail)).toBe(true)
    const copy = journal.snapshot()
    expect(copy[0]).not.toBe(retained)
    expect(copy[0]?.detail).not.toBe(retained.detail)

    // The cast is the point: the type says `readonly`, and this asserts the *runtime* copy is a
    // separate object, so breaking that promise on the copy cannot reach the journal's own entry.
    ;(copy[0]!.detail as Record<string, string>).text = 'rewritten'
    expect(journal.snapshot()[0]?.detail.text).toBe('the README says so')
  })

  it('reports an empty journal as empty, not as a rolled-over one', () => {
    const journal = new Journal()
    expect(journal.size).toBe(0)
    expect(journal.oldestSeq).toBeUndefined()
    expect(journal.snapshot()).toEqual([])
  })

  it('learns a secret after construction, for a plugin that has only just minted one', () => {
    // The route's token does not exist until the plugin that mints it applies, and plugins load in no
    // guaranteed order — so a journal seeded only at construction would have to be replaced to learn
    // it, and two instances is how a reader ends up with half a story. Seed nothing, then add.
    const journal = new Journal()
    journal.record('session.opened', { provider: 'openai-live' })

    // A non-string cannot arrive through validated config; the guard is what makes that true rather
    // than assumed, so it is exercised here instead of being left to the type system.
    journal.addSecrets(['', ROUTE_TOKEN, ROUTE_TOKEN, 42 as unknown as string])

    journal.record('socket.rejected', { verdict: '401', url: `/dsh-realtime/audio?token=${ROUTE_TOKEN}` })

    // Entries recorded before the secret was known keep their shape-redacted form; the late secret
    // applies from the moment it is learned, which is all a socket verdict needs.
    expect(journal.snapshot()[0]?.detail.provider).toBe('openai-live')
    expect(journal.snapshot()[1]?.detail.url).toBe(`/dsh-realtime/audio?token=${REDACTED}`)
    expect(JSON.stringify(journal.snapshot())).not.toContain(ROUTE_TOKEN)
  })
})
