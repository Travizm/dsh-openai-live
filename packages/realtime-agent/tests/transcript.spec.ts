import { describe, expect, it } from 'vitest'
import { TranscriptBuffer } from '../src/transcript.ts'

describe('TranscriptBuffer', () => {
  it('records a fragment as a line', () => {
    const buffer = new TranscriptBuffer(() => 100)
    buffer.append('input', 'is staging ok?', true)
    expect(buffer.lines()).toEqual([{ kind: 'input', text: 'is staging ok?' }])
  })

  it('coalesces consecutive fragments from the same side', () => {
    // Transcripts arrive as deltas. A record of one line per delta would evict the conversation it
    // exists to preserve, so this is the property that makes the buffer worth having.
    const buffer = new TranscriptBuffer(() => 100)
    buffer.append('output', 'Stag', false)
    buffer.append('output', 'ing is', false)
    buffer.append('output', ' healthy.', true)
    expect(buffer.lines()).toEqual([{ kind: 'output', text: 'Staging is healthy.' }])
  })

  it('starts a new line once the previous utterance is sealed', () => {
    const buffer = new TranscriptBuffer(() => 100)
    buffer.append('input', 'one', true)
    buffer.append('input', 'two', false)
    expect(buffer.lines()).toEqual([
      { kind: 'input', text: 'one' },
      { kind: 'input', text: 'two' },
    ])
  })

  it('starts a new line when the side changes mid-utterance', () => {
    const buffer = new TranscriptBuffer(() => 100)
    buffer.append('input', 'one', false)
    buffer.append('output', 'two', false)
    expect(buffer.lines()).toEqual([
      { kind: 'input', text: 'one' },
      { kind: 'output', text: 'two' },
    ])
  })

  it('drops an empty fragment', () => {
    const buffer = new TranscriptBuffer(() => 100)
    buffer.append('input', '', false)
    expect(buffer.lines()).toEqual([])
  })

  it('evicts the oldest lines once the budget is exceeded', () => {
    const buffer = new TranscriptBuffer(() => 10)
    buffer.append('input', 'aaaaa', true)
    buffer.append('input', 'bbbbb', true)
    buffer.append('input', 'ccccc', true)
    // 15 chars against a 10-char budget: the oldest line goes, and the rest are kept whole.
    expect(buffer.lines()).toEqual([
      { kind: 'input', text: 'bbbbb' },
      { kind: 'input', text: 'ccccc' },
    ])
  })

  it('keeps the most recent line even when it alone exceeds the budget', () => {
    // A buffer that can hold nothing cannot answer any delegation, which is worse than holding too
    // little — so the floor is one line, not zero.
    const buffer = new TranscriptBuffer(() => 2)
    buffer.append('input', 'aaaaa', true)
    buffer.append('input', 'bbbbb', true)
    expect(buffer.lines()).toEqual([{ kind: 'input', text: 'bbbbb' }])
  })

  it('reads the budget at every eviction, so a change reaches the next fragment', () => {
    // `maxTranscriptChars` is a live field: a copy taken when the buffer was constructed would make a
    // change look applied while the buffer kept the old budget for the rest of the conversation.
    let budget = 1_000
    const buffer = new TranscriptBuffer(() => budget)
    buffer.append('input', 'aaaaa', true)
    buffer.append('input', 'bbbbb', true)

    budget = 5
    buffer.append('input', 'ccccc', true)

    expect(buffer.lines()).toEqual([{ kind: 'input', text: 'ccccc' }])
  })

  it('returns copies, so a caller cannot mutate the buffer through the result', () => {
    const buffer = new TranscriptBuffer(() => 100)
    buffer.append('input', 'original', true)
    const snapshot = buffer.lines()
    snapshot[0]!.text = 'tampered'
    snapshot.push({ kind: 'output', text: 'invented' })
    expect(buffer.lines()).toEqual([{ kind: 'input', text: 'original' }])
  })

  it('seals the line a request came from, so the next utterance does not join it', () => {
    // The wire marks no utterance boundary, so this is the only thing that ends one. Without it the line a
    // delegation was answered from keeps absorbing whatever is said next — and a request read as a clipped
    // sentence rather than as a question is the same defect seen from the other end.
    const buffer = new TranscriptBuffer(() => 1_000)
    buffer.append('input', 'which animal comes up', false)
    buffer.seal()
    buffer.append('input', ' with a long neck?', false)

    expect(buffer.lines()).toEqual([
      { kind: 'input', text: 'which animal comes up' },
      { kind: 'input', text: ' with a long neck?' },
    ])
  })

  it('sealing an empty buffer does nothing', () => {
    // Reachable: a delegation can be raised with nothing heard, and a request is built from the empty buffer.
    const buffer = new TranscriptBuffer(() => 100)
    buffer.seal()
    expect(buffer.lines()).toEqual([])
  })

  it('reports how long the transcript has been quiet, counting from the last fragment', () => {
    const buffer = new TranscriptBuffer(() => 100)
    buffer.append('input', 'one', false, 1_000)
    expect(buffer.quietFor(1_250)).toBe(250)

    buffer.append('output', 'two', false, 1_400)
    expect(buffer.quietFor(1_450)).toBe(50)
  })

  it('reports an infinite quiet when nothing has ever arrived', () => {
    // Not zero. A transcript that has never carried anything cannot become quieter, and a caller waiting for
    // quiet must not wait a full window on a session where nothing was said.
    const buffer = new TranscriptBuffer(() => 100)
    expect(buffer.quietFor(1_000)).toBe(Number.POSITIVE_INFINITY)
  })

  it('does not count an empty fragment as progress', () => {
    // A frame with no text is not transcription progress, so it neither resets the quiet nor is counted as
    // something a wait caught.
    const buffer = new TranscriptBuffer(() => 100)
    buffer.append('input', 'one', false, 1_000)
    buffer.append('input', '', false, 1_500)

    expect(buffer.quietFor(1_600)).toBe(600)
    expect(buffer.appends).toBe(1)
  })

  it('counts every fragment it appends', () => {
    const buffer = new TranscriptBuffer(() => 1_000)
    expect(buffer.appends).toBe(0)

    buffer.append('input', 'a', false)
    buffer.append('output', 'b', false)

    expect(buffer.appends).toBe(2)
  })
})
