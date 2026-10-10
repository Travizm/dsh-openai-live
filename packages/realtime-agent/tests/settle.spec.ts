import { describe, expect, it } from 'vitest'
import { SETTLE_POLL_MS, settleTranscript, type SettleDeps } from '../src/settle.ts'

/**
 * A transcript that has fragments arriving at stated moments, on a clock the sleeps advance.
 *
 * Deterministic on purpose. The property under test is *how long* the wait goes on, so a test that waited in
 * real time would assert the property through the scheduler and fail on a loaded machine.
 * @param fragmentAt - absolute milliseconds at which fragments arrive; anything at or before the start is
 *   already in the buffer.
 * @param start - when the delegation landed.
 */
function transcriptAt(fragmentAt: readonly number[], start = 1_000): { deps: SettleDeps; slept: number[] } {
  let now = start
  const slept: number[] = []
  const arrived = (): number[] => fragmentAt.filter(at => at <= now)
  return {
    slept,
    deps: {
      quietFor: (at: number): number => {
        const last = arrived().at(-1)
        return last === undefined ? Number.POSITIVE_INFINITY : at - last
      },
      appends: () => arrived().length,
      now: () => now,
      sleep: (ms: number): Promise<void> => {
        slept.push(ms)
        now += ms
        return Promise.resolve()
      },
    },
  }
}

const POLICY = { quietMs: 500, capMs: 1_500 }

describe('settleTranscript', () => {
  it('does not wait when the transcript is already quiet', () => {
    // The common case: somebody stopped speaking, then the model decided to delegate. A wait here would be
    // pure latency on every turn that was never at risk.
    const { deps, slept } = transcriptAt([400], 1_000)
    return expect(settleTranscript(deps, POLICY)).resolves.toEqual({ waitedMs: 0, fragments: 0, capped: false })
      .then(() => { expect(slept).toEqual([]) })
  })

  it('does not wait when nothing has ever arrived', () => {
    // Infinity, not zero: a transcript that has never carried anything cannot become quieter, so there is
    // nothing to wait for. Reachable — a delegation can be raised with nothing heard at all.
    const { deps, slept } = transcriptAt([], 1_000)
    return expect(settleTranscript(deps, POLICY)).resolves.toEqual({ waitedMs: 0, fragments: 0, capped: false })
      .then(() => { expect(slept).toEqual([]) })
  })

  it('waits past the tail of an utterance and reports the fragment it caught', async () => {
    // The measured shape: a fragment is already in the buffer (950), the delegation lands at 1000, and the
    // last fragment of that same utterance arrives at 1150 — 150 ms after the delegation, exactly as the
    // recording showed. The wait runs until that fragment has itself been quiet for the threshold.
    const { deps, slept } = transcriptAt([950, 1_150], 1_000)
    const outcome = await settleTranscript(deps, POLICY)

    expect(outcome).toEqual({ waitedMs: 650, fragments: 1, capped: false })
    expect(slept).toHaveLength(26)
    expect(slept.every(ms => ms === SETTLE_POLL_MS)).toBe(true)
  })

  it('stops at the ceiling when the transcript never goes quiet', async () => {
    // Somebody talking through the whole window. A delegation that never fires is worse than a request with a
    // clipped tail, so the ceiling wins — and the outcome says so rather than looking settled.
    const fragmentAt = Array.from({ length: 40 }, (_, i) => 1_000 + i * 100)
    const { deps } = transcriptAt(fragmentAt, 1_000)
    const outcome = await settleTranscript(deps, POLICY)

    expect(outcome.capped).toBe(true)
    expect(outcome.waitedMs).toBe(1_500)
    expect(outcome.fragments).toBe(15)
  })

  it('never sleeps past the ceiling', async () => {
    // The bound is `capMs`, not `capMs` plus one poll: a caller sizing the turn around this number must be
    // able to trust it.
    const fragmentAt = Array.from({ length: 10 }, (_, i) => 0 + i * 100)
    const { deps, slept } = transcriptAt(fragmentAt, 0)
    const outcome = await settleTranscript(deps, { quietMs: 500, capMs: 30 })

    expect(outcome.waitedMs).toBe(30)
    expect(slept).toEqual([25, 5])
  })
})
