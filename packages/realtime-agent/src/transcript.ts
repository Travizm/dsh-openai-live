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
 */
export class TranscriptBuffer {
  private readonly buffered: BufferedLine[] = []
  private chars = 0

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
   * @param kind - which side spoke.
   * @param text - the fragment. An empty fragment carries nothing and is dropped.
   * @param final - whether this fragment closes the utterance.
   */
  append(kind: 'input' | 'output', text: string, final: boolean): void {
    if (text.length === 0) return
    this.chars += text.length

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
