/**
 * Waiting for a transcript to settle before a request is built from it.
 *
 * **Why this exists, measured.** The provider raises `session.delegation.created` while the transcription
 * of the utterance it is acting on is still arriving. On a running app the delegation landed at
 * `07:16:55.301` and the next fragment of that same utterance at `07:16:55.463` — 162 ms later, six
 * characters — so the relayed request was assembled from a prefix and read
 * `Delegate this task to a client: "In a recent session, which animal comes up`, with no closing quote.
 * Across the eight measurable delegations in that journal the first fragment to follow arrived between
 * **125 ms and 506 ms** later.
 *
 * Nothing on the wire marks the end of an utterance: twenty recorded live sessions contain deltas and no
 * boundary event of any kind, and the adapter says so in its own words — "the provider signals the end of
 * an utterance by simply stopping". So the boundary is ours to derive, and the honest derivation is a
 * *wait*: the transcript is settled when it has been quiet long enough, not when a frame says so.
 *
 * The window is two numbers, and both are configuration rather than taste. `quietMs` is the length of the
 * measured tail; `capMs` is what bounds the wait when somebody simply keeps talking, because a delegation
 * that never fires is worse than a request with a clipped tail. Neither is a latency budget anybody will
 * notice: the admission of the turn that follows takes seconds to tens of seconds.
 *
 * @module dsh-realtime-agent/settle
 */

/**
 * Milliseconds between two readings of the transcript while waiting.
 *
 * Not a tunable. Nothing about a deployment changes the right granularity for asking "has anything
 * arrived since the last time I asked", and the response to a full window is 20 to 60 readings — cheap
 * enough that an event-driven version would be more machinery than it saves.
 */
export const SETTLE_POLL_MS = 25

/** How long the transcript must be quiet, and the longest a delegation waits for that. */
export interface SettlePolicy {
  /** Quiet required before the transcript is treated as settled. */
  readonly quietMs: number
  /** Ceiling on the wait, after which the transcript is used as it stands. */
  readonly capMs: number
}

/** What waiting produced. */
export interface SettleOutcome {
  /** Milliseconds spent waiting. Zero when the transcript was already quiet. */
  readonly waitedMs: number
  /**
   * Fragments that arrived **while** waiting.
   *
   * The count that says whether the fix does anything: a request built from a settled transcript recorded
   * zero here because the utterance was already over, and one that caught a tail records the fragments it
   * would otherwise have dropped.
   */
  readonly fragments: number
  /** Whether the cap ended the wait, in which case the transcript was still arriving when it was read. */
  readonly capped: boolean
}

/**
 * The transcript, the clock and the sleep.
 *
 * Injected rather than reached for, for the same reason {@link TranscriptBuffer} takes its budget as an
 * accessor: this module must be exercisable without a session, a timer or a provider, and a test that can
 * only run in real time is a test that eventually fails on a loaded machine.
 */
export interface SettleDeps {
  /** Milliseconds since the last fragment arrived, as of `now`; `Infinity` when none ever has. */
  readonly quietFor: (now: number) => number
  /** Fragments appended since the session began, so the wait can report what it caught. */
  readonly appends: () => number
  /** The clock, in milliseconds. */
  readonly now: () => number
  /** Wait, without keeping the process alive. */
  readonly sleep: (ms: number) => Promise<void>
}

/**
 * Wait until the transcript has been quiet for `quietMs`, or until `capMs` has passed.
 *
 * Checked before waiting, so the common case — a delegation raised after the person stopped speaking — costs
 * no time at all. The cap is checked before the sleep as well as after it, and the sleep never runs past it,
 * so the wait is bounded by `capMs` rather than by `capMs` plus one poll.
 * @param deps - the transcript, the clock and the sleep.
 * @param policy - the quiet required, and the ceiling on waiting for it.
 * @returns what the wait cost, and whether the ceiling ended it.
 */
export async function settleTranscript(deps: SettleDeps, policy: SettlePolicy): Promise<SettleOutcome> {
  const startedAt = deps.now()
  const before = deps.appends()
  for (;;) {
    // One reading of the clock per pass, so the quiet and the wait it is compared against cannot disagree.
    const now = deps.now()
    const waitedMs = now - startedAt
    if (deps.quietFor(now) >= policy.quietMs) {
      return { waitedMs, fragments: deps.appends() - before, capped: false }
    }
    if (waitedMs >= policy.capMs) {
      return { waitedMs, fragments: deps.appends() - before, capped: true }
    }
    await deps.sleep(Math.min(SETTLE_POLL_MS, policy.capMs - waitedMs))
  }
}
