/**
 * Per-turn timings, derived from a journal.
 *
 * ADR-012 puts the instrument before the second provider, and the chamber's metric matrix names the number
 * this file exists to produce: **turn latency p50/p90, per stage, present for every turn**. The journal has
 * always recorded *when* things happened; nothing computed the intervals, so a reader could subtract two
 * `at` values by hand for one turn and still had no way to say whether forty-five seconds was normal.
 *
 * **Derived, not stamped.** Every entry carries `at`, and the delegation path already puts a shared
 * `detail.id` on `delegation.seen`, `prompt.admitted` and `answer.received`. A duration added at emission
 * time would be a second copy of the same fact; the two would disagree the first time one code path changed,
 * and a record that can contradict itself is worth less than no record. Derivation also means this works on
 * journals already on disk, which is the only way to answer "has this always been slow?".
 *
 * Three stages, each measured between the entries that bound it:
 *
 *   admission  delegation.seen → prompt.admitted   the prompt queued behind the session's own work
 *   answer     prompt.admitted → answer.received   the agent working
 *   total      delegation.seen → answer.received   what a person at the microphone experiences
 *
 * **Except that the first two boundaries share an instant.** `prompt.admitted` and `answer.received` are both
 * written when a turn settles, so a reading built only from `at` puts the entire wait under "admission" and
 * reports the agent as taking zero milliseconds — measured on a real journal: answer 0.00s for all fifteen
 * turns, admission p90 39.86s. The responder already journals the true agent duration as
 * `answer.received.detail.ms` (admission → answer, from the instant the admission resolved), so that number
 * wins where it exists and the stage split is reconstructed as `total − ms`. Where it does not — entries
 * written before that field — the split is the boundaries, and the turn is counted as `derived` so a reader
 * can see which turns are the weaker reading rather than averaging the two together.
 *
 * A turn missing a boundary is **excluded, not measured as zero**. A refused admission never writes
 * `prompt.admitted`; counting it as an instant answer would drag every percentile down with a turn that
 * never happened, and the fix for a slow system would look like a regression.
 *
 * Percentiles are nearest-rank: the value at position ⌈p·N⌉ in the ordered sample, no interpolation. With a
 * handful of turns per session, an interpolated p90 invents a number that no turn took.
 */
import type { JournalEntry } from './journal.js'

/** One turn's stages, in milliseconds. */
export interface TurnTimings {
  /** The delegation id the three entries share. */
  readonly id: string
  /** `delegation.seen` → `prompt.admitted`. */
  readonly admissionMs: number
  /** `prompt.admitted` → `answer.received`. */
  readonly answerMs: number
  /** `delegation.seen` → `answer.received`. */
  readonly totalMs: number
  /**
   * Which reading this turn got. `recorded` means the journal carried the true agent duration and the split
   * is exact; `derived` means the two boundaries share an instant and the agent stage reads as a residue.
   */
  readonly source: 'recorded' | 'derived'
}

/** The stages this file measures. Named so a caller cannot silently ask for a fourth. */
export const TIMING_STAGES = ['admission', 'answer', 'total'] as const

/** One of the measured stages. */
export type TimingStage = (typeof TIMING_STAGES)[number]

/** A stage's distribution over the turns that completed it. */
export interface StageSummary {
  /** How many turns contributed. Zero means nothing to say — the other fields are then 0 by construction. */
  readonly n: number
  readonly p50: number
  readonly p90: number
  /** The worst single turn. A p90 hides a lone 40 s turn in a sample of five; this does not. */
  readonly max: number
}

/** The whole reading. */
export interface TimingSummary {
  /** Turns with all three boundaries — what the stages are computed over. */
  readonly measured: number
  /**
   * How many of those carried the responder's own agent duration. The rest are `derived`: their agent stage is
   * a residue of two boundaries written at the same instant, and they should not be read as equal evidence.
   */
  readonly recorded: number
  readonly derived: number
  /** Delegations seen that never completed a boundary, by id. */
  readonly excluded: readonly string[]
  readonly stages: Readonly<Record<TimingStage, StageSummary>>
}

/** The boundary kinds, in the order a turn should meet them. */
const BOUNDARIES = ['delegation.seen', 'prompt.admitted', 'answer.received'] as const

/** Nearest-rank percentile: the smallest value with at least `p` of the sample at or below it. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(p * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!
}

/** The stage summary for one sample. */
function summarise(values: readonly number[]): StageSummary {
  if (values.length === 0) return { n: 0, p50: 0, p90: 0, max: 0 }
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: Math.max(...values),
  }
}

/**
 * Every completed turn in the entries, oldest boundary first per id.
 *
 * Entries are ordered by `at` rather than by their position in the array: a journal file that concatenates
 * boots is not guaranteed to be chronological, and taking "the first one we saw" would then measure a
 * negative interval that looks like a bug in the timings rather than in the reading.
 */
export function turnTimings(entries: readonly JournalEntry[]): TurnTimings[] {
  const byId = new Map<string, { seen?: number; admitted?: number; answered?: number; answerMs?: number }>()
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    if (!(BOUNDARIES as readonly string[]).includes(entry.kind)) continue
    const id = entry.detail['id']
    if (id === undefined) continue
    let marks = byId.get(id)
    if (marks === undefined) { marks = {}; byId.set(id, marks) }
    // The first occurrence of each boundary wins: a retried admission writes `prompt.admitted` again, and the
    // wait for the turn is the wait until the first one.
    if (entry.kind === 'delegation.seen' && marks.seen === undefined) marks.seen = entry.at
    if (entry.kind === 'prompt.admitted' && marks.admitted === undefined) marks.admitted = entry.at
    if (entry.kind === 'answer.received') {
      if (marks.answered === undefined) marks.answered = entry.at
      const recorded = Number(entry.detail['ms'])
      if (marks.answerMs === undefined && entry.detail['ms'] !== undefined && Number.isFinite(recorded)) {
        marks.answerMs = recorded
      }
    }
  }
  const turns: TurnTimings[] = []
  for (const [id, marks] of byId) {
    const { seen, admitted, answered } = marks
    if (seen === undefined || admitted === undefined || answered === undefined) continue
    const totalMs = answered - seen
    // A recorded agent duration is the exact one, and the admission stage is what is left of the wait. Without
    // it the two boundaries can share an instant, which makes the agent stage a zero and the wait a residue of
    // the whole turn — the weaker reading, and labelled as such.
    const recorded = marks.answerMs
    const answerMs = recorded === undefined ? answered - admitted : Math.min(recorded, totalMs)
    const admissionMs = totalMs - answerMs
    turns.push({ id, admissionMs, answerMs, totalMs, source: recorded === undefined ? 'derived' : 'recorded' })
  }
  return turns.sort((a, b) => a.totalMs - b.totalMs)
}

/**
 * The reading a caller wants: per-stage distributions, and an honest count of what did not complete.
 *
 * `excluded` names the delegations that were seen and never answered, by id. It is a list rather than a
 * number because the number alone cannot distinguish "the user hung up" from "the responder dropped it", and
 * the next question after a latency reading is always "and what fell out of it?".
 */
export function summariseTimings(entries: readonly JournalEntry[]): TimingSummary {
  const turns = turnTimings(entries)
  const all = new Set<string>()
  for (const entry of entries) {
    const id = entry.kind === 'delegation.seen' ? entry.detail['id'] : undefined
    if (id !== undefined) all.add(id)
  }
  const measured = new Set(turns.map(turn => turn.id))
  return {
    measured: turns.length,
    recorded: turns.filter(turn => turn.source === 'recorded').length,
    derived: turns.filter(turn => turn.source === 'derived').length,
    excluded: [...all].filter(id => !measured.has(id)).sort(),
    stages: {
      admission: summarise(turns.map(turn => turn.admissionMs)),
      answer: summarise(turns.map(turn => turn.answerMs)),
      total: summarise(turns.map(turn => turn.totalMs)),
    },
  }
}
