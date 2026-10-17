import { describe, expect, it } from 'vitest'
import type { JournalEntry, JournalKind } from '../src/index.ts'
import { TIMING_STAGES, percentile, summariseTimings, turnTimings } from '../src/index.ts'

/** One journal entry, assembled rather than written as a literal — the kind and the detail are the subject. */
const entry = (kind: JournalKind, at: number, detail: Record<string, string> = {}): JournalEntry =>
  ({ runId: 'run-1', seq: at, at, kind, detail })

describe('percentile', () => {
  it('says nothing about an empty sample', () => {
    // Zero is the honest answer: there is no p50 of nothing, and returning NaN would travel silently into a
    // report and be read as a measurement.
    expect(percentile([], 0.5)).toBe(0)
  })

  it('returns the only value there is', () => {
    expect(percentile([42], 0.9)).toBe(42)
  })

  it('uses nearest-rank, so every answer is a value some turn actually took', () => {
    // 1..10: p50 is the 5th, p90 the 9th. An interpolated p90 would invent 9.1 — a latency no turn had.
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9)
  })

  it('sorts before ranking, so input order does not matter', () => {
    expect(percentile([10, 1, 5], 0.5)).toBe(5)
  })

  it('clamps a rank past the end to the largest value, and a rank below one to the smallest', () => {
    expect(percentile([5, 6], 1)).toBe(6)
    expect(percentile([5, 6], 0)).toBe(5)
  })
})

describe('turnTimings', () => {
  it('measures the three stages of a completed turn', () => {
    const turns = turnTimings([
      entry('delegation.seen', 1_000, { id: 'a' }),
      entry('prompt.admitted', 1_400, { id: 'a' }),
      entry('answer.received', 3_400, { id: 'a' }),
    ])
    expect(turns).toEqual([{ id: 'a', admissionMs: 400, answerMs: 2_000, totalMs: 2_400, source: 'derived' }])
  })

  it('uses the responder’s recorded agent duration where the journal carries one', () => {
    // The boundaries `prompt.admitted` and `answer.received` are written together when a turn settles, so on
    // their own they put the whole wait under admission and report the agent as instantaneous. The recorded
    // `ms` is the true admission→answer, so admission becomes the residue.
    const turns = turnTimings([
      entry('delegation.seen', 1_000, { id: 'a' }),
      entry('prompt.admitted', 1_400, { id: 'a' }),
      entry('answer.received', 11_400, { id: 'a', ms: '2000' }),
    ])
    expect(turns[0]).toMatchObject({ admissionMs: 8_400, answerMs: 2_000, totalMs: 10_400, source: 'recorded' })
  })

  it('falls back to the boundaries when the recorded duration is not a number', () => {
    const turns = turnTimings([
      entry('delegation.seen', 1_000, { id: 'a' }),
      entry('prompt.admitted', 1_400, { id: 'a' }),
      entry('answer.received', 3_400, { id: 'a', ms: 'about two seconds' }),
    ])
    expect(turns[0]).toMatchObject({ answerMs: 2_000, source: 'derived' })
  })

  it('keeps the first recorded duration when a turn is answered twice', () => {
    // A retried settlement writes `answer.received` again; the turn is measured to its first answer.
    const turns = turnTimings([
      entry('delegation.seen', 1_000, { id: 'a' }),
      entry('prompt.admitted', 1_400, { id: 'a' }),
      entry('answer.received', 3_400, { id: 'a', ms: '2000' }),
      entry('answer.received', 9_400, { id: 'a', ms: '8000' }),
    ])
    expect(turns[0]).toMatchObject({ answerMs: 2_000, totalMs: 2_400, source: 'recorded' })
  })

  it('never reports an agent stage longer than the turn it sits inside', () => {
    // A clock that stepped back between the two writes would otherwise produce a negative admission stage,
    // which reads as a bug in the metric rather than in the clock.
    const turns = turnTimings([
      entry('delegation.seen', 1_000, { id: 'a' }),
      entry('prompt.admitted', 1_400, { id: 'a' }),
      entry('answer.received', 2_000, { id: 'a', ms: '9000' }),
    ])
    expect(turns[0]).toMatchObject({ answerMs: 1_000, admissionMs: 0, totalMs: 1_000, source: 'recorded' })
  })

  it('excludes a turn that never completed a boundary, rather than timing it as zero', () => {
    // A refused admission writes no `prompt.admitted`. Counting it as an instant answer would pull every
    // percentile down with a turn that never happened.
    const turns = turnTimings([
      entry('delegation.seen', 1_000, { id: 'refused' }),
      entry('delegation.seen', 2_000, { id: 'ok' }),
      entry('prompt.admitted', 2_100, { id: 'ok' }),
      entry('answer.received', 2_600, { id: 'ok' }),
    ])
    expect(turns.map(turn => turn.id)).toEqual(['ok'])
  })

  it('measures by the clock, not by array position', () => {
    // A journal file that concatenates boots is not guaranteed chronological; trusting position would
    // measure a negative interval and blame the wrong thing.
    const turns = turnTimings([
      entry('answer.received', 3_400, { id: 'a' }),
      entry('prompt.admitted', 1_400, { id: 'a' }),
      entry('delegation.seen', 1_000, { id: 'a' }),
    ])
    expect(turns[0]).toMatchObject({ admissionMs: 400, answerMs: 2_000, totalMs: 2_400 })
  })

  it('takes the first occurrence of a repeated boundary', () => {
    // A retried admission writes `prompt.admitted` twice; the wait for the turn is the wait until the first.
    const turns = turnTimings([
      entry('delegation.seen', 1_000, { id: 'a' }),
      entry('prompt.admitted', 1_500, { id: 'a' }),
      entry('prompt.admitted', 9_000, { id: 'a' }),
      entry('answer.received', 3_000, { id: 'a' }),
    ])
    expect(turns[0]!.admissionMs).toBe(500)
  })

  it('ignores entries that carry no delegation id, and kinds that are not boundaries', () => {
    const turns = turnTimings([
      entry('speech.sent', 900, { bytes: '320' }),
      entry('window.elapsed', 950, { id: 'a' }),
      entry('delegation.seen', 1_000, { id: 'a' }),
      entry('prompt.admitted', 1_100, { id: 'a' }),
      entry('answer.received', 1_900, { id: 'a' }),
    ])
    expect(turns).toHaveLength(1)
  })

  it('ignores a boundary entry that carries no id at all', () => {
    // Not every journal on disk was written by today's code, and a boundary row with no id cannot be grouped
    // with anything. Skipping it is the only reading that does not invent a turn.
    const turns = turnTimings([
      entry('delegation.seen', 500, {}),
      entry('delegation.seen', 1_000, { id: 'a' }),
      entry('prompt.admitted', 1_100, { id: 'a' }),
      entry('answer.received', 1_900, { id: 'a' }),
    ])
    expect(turns.map(turn => turn.id)).toEqual(['a'])
  })

  it('says nothing about an empty journal', () => {
    expect(turnTimings([])).toEqual([])
  })

  it('orders the turns by what the speaker waited', () => {
    const turns = turnTimings([
      entry('delegation.seen', 0, { id: 'slow' }),
      entry('prompt.admitted', 10, { id: 'slow' }),
      entry('answer.received', 10_000, { id: 'slow' }),
      entry('delegation.seen', 0, { id: 'fast' }),
      entry('prompt.admitted', 10, { id: 'fast' }),
      entry('answer.received', 400, { id: 'fast' }),
    ])
    expect(turns.map(turn => turn.id)).toEqual(['fast', 'slow'])
  })
})

describe('summariseTimings', () => {
  it('summarises every stage over the turns that completed, and names what fell out', () => {
    const summary = summariseTimings([
      entry('delegation.seen', 0, { id: 'a' }),
      entry('prompt.admitted', 100, { id: 'a' }),
      entry('answer.received', 600, { id: 'a' }),
      entry('delegation.seen', 0, { id: 'b' }),
      entry('prompt.admitted', 200, { id: 'b' }),
      entry('answer.received', 1_200, { id: 'b' }),
      entry('delegation.seen', 0, { id: 'refused' }),
    ])
    expect(summary.measured).toBe(2)
    expect(summary.excluded).toEqual(['refused'])
    expect(summary.stages.admission).toEqual({ n: 2, p50: 100, p90: 200, max: 200 })
    expect(summary.stages.answer).toEqual({ n: 2, p50: 500, p90: 1_000, max: 1_000 })
    expect(summary.stages.total).toEqual({ n: 2, p50: 600, p90: 1_200, max: 1_200 })
  })

  it('reports zero rather than inventing a number when nothing completed', () => {
    const summary = summariseTimings([entry('delegation.seen', 0, { id: 'only' })])
    expect(summary.measured).toBe(0)
    expect(summary.excluded).toEqual(['only'])
    for (const stage of TIMING_STAGES) expect(summary.stages[stage]).toEqual({ n: 0, p50: 0, p90: 0, max: 0 })
  })

  it('covers an empty journal without a turn or an exclusion', () => {
    const summary = summariseTimings([])
    expect(summary.measured).toBe(0)
    expect(summary.excluded).toEqual([])
  })

  it('names stages that cannot be silently extended', () => {
    // A caller asking for a fourth stage gets a compile error, not `undefined` at runtime.
    expect([...TIMING_STAGES]).toEqual(['admission', 'answer', 'total'])
  })
})
