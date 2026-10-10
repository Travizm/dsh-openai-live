import type { AgentTranscriptLine } from './types.ts'

/** One buffered line, plus the bookkeeping the public type deliberately does not carry. */
interface BufferedLine extends AgentTranscriptLine {
  /** Whether the utterance it belongs to is closed, so the next fragment starts a new line. */
  sealed: boolean
}

/**
 * A bounded record of the conversation, oldest first.
 *
 * Bounded because a long session would otherwise grow without limit, and it is the **oldest** lines
 * that are least useful: a delegation is answered from the recent context, so eviction drops from the
 * front. Fragments are coalesced, because transcripts arrive as deltas and a record of eighty deltas
 * would evict the very conversation it exists to preserve.
 *
 * **A line ends when something ends it**, and that is the correction this class carries. The wire marks
 * no utterance boundary at all, so coalescing cannot be left to a `final` flag that is never true — the
 * buffer would merge every fragment from one side for the life of the session and one line would mean
 * whatever a whole side of the conversation said. Two things end a line here instead: the other side
 * speaking (the turn changed hands), and {@link seal}, called once the transcript has settled and a
 * delegation is about to be answered from it.
 */
export class TranscriptBuffer {
  private readonly buffered: BufferedLine[] = []
  private chars = 0
  private fragments = 0
  private lastAt: number | undefined

  /**
   * @param maxChars - character budget, read at every eviction.
   *
   * An accessor rather than a number because `maxTranscriptChars` is a **live** field
   * (`docs/control-plane-fields.md`): the budget can change while the conversation runs, and a copy
   * taken at construction would make the change look applied while the buffer kept the old one.
   * Every value is accepted: a budget smaller than one line degrades to keeping exactly the most recent
   * line rather than to keeping nothing, because a buffer that can hold nothing cannot answer any
   * delegation at all.
   */
  constructor(private readonly maxChars: () => number) {}

  /**
   * Record one fragment.
   *
   * `at` is injectable for the same reason {@link Journal.record}'s is: the quiet a buffer reports is
   * measured against it, and a test that had to sleep to assert a wait would be a test that fails on a
   * loaded machine.
   * @param kind - which side spoke.
   * @param text - the fragment. An empty fragment carries nothing and is dropped — including for the
   *   quiet reading, because a frame with no text is not transcription progress.
   * @param final - whether this fragment closes the utterance, as the wire reports it. Always `false`
   *   from this adapter; kept because the seam's own type carries it, and meaningless here on purpose
   *   rather than by accident. See {@link seal}.
   * @param at - epoch milliseconds; defaults to now.
   */
  append(kind: 'input' | 'output', text: string, final: boolean, at: number = Date.now()): void {
    if (text.length === 0) return
    this.chars += text.length
    this.fragments += 1
    this.lastAt = at

    const last = this.buffered[this.buffered.length - 1]
    if (last !== undefined && last.kind === kind && !last.sealed) {
      last.text += text
      last.sealed = final
    } else {
      this.buffered.push({ kind, text, sealed: final })
    }

    this.evict()
  }

  /**
   * End the line currently being written, so the next fragment starts a new one.
   *
   * Called when a delegation is answered from the buffer. Without it the line the request came from would
   * keep absorbing whatever is said next, and the next delegation's "last line" would be one utterance plus
   * however much of the following one had arrived — which is precisely the shape that made a relayed request
   * read as a clipped sentence rather than as a question.
   *
   * A no-op on an empty buffer, which is reachable: a delegation can be raised with nothing heard at all.
   */
  seal(): void {
    const last = this.buffered[this.buffered.length - 1]
    if (last === undefined) return
    last.sealed = true
  }

  /**
   * Milliseconds since the last fragment arrived.
   *
   * `Infinity` when nothing ever has, which is the honest answer rather than zero: a transcript that has
   * never carried anything can never become quieter, so a caller waiting for quiet should not wait at all.
   * That is why the value is not clamped to the cap.
   * @param now - epoch milliseconds; defaults to now.
   */
  quietFor(now: number = Date.now()): number {
    return this.lastAt === undefined ? Number.POSITIVE_INFINITY : now - this.lastAt
  }

  /** Fragments appended since this buffer was created. What a settle can report having caught. */
  get appends(): number {
    return this.fragments
  }

  /**
   * A detached snapshot, oldest first.
   * @returns copies, so a caller cannot mutate the buffer through the result.
   */
  lines(): AgentTranscriptLine[] {
    return this.buffered.map(line => ({ kind: line.kind, text: line.text }))
  }

  /** Drop the oldest lines until the budget is met, never dropping the most recent one. */
  private evict(): void {
    const budget = this.maxChars()
    while (this.chars > budget && this.buffered.length > 1) {
      // The loop condition proves a first element exists, so this assertion is an invariant rather
      // than a hope — and it leaves no unreachable branch for the coverage gate to flag.
      this.chars -= this.buffered.shift()!.text.length
    }
  }
}
