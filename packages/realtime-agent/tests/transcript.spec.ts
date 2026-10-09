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
})
