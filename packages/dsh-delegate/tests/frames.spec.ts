import { describe, expect, it } from 'vitest'
import { answerFrom, assistantText } from '../src/index.ts'
import type { FollowFrame, WireEvent } from '../src/index.ts'

const event = (seq: number, data: unknown, type = 'assistant/message'): WireEvent => ({ type, seq, time: 1, data })

const assistantData = (...parts: readonly unknown[]): unknown => ({
  stream: [],
  turn: 1,
  step: 1,
  message: { role: 'assistant', content: parts, source: { kind: 'model' } },
})

const end = (outcome: unknown): FollowFrame => ({ type: 'assistant-stream', frame: { type: 'end', outcome } as never })

describe('assistantText', () => {
  it('joins the text parts of an assistant message', () => {
    expect(assistantText(assistantData({ type: 'text', text: 'Hello, ' }, { type: 'text', text: 'world.' })))
      .toBe('Hello, world.')
  })

  it('excludes reasoning parts, because a completion is a public surface', () => {
    // The harness stores the model's private thinking beside its answer. Joining them would put a chain of
    // thought into whatever consumes the completion — a leak that looks like verbosity.
    expect(assistantText(assistantData(
      { type: 'reasoning', text: 'the user probably means X' },
      { type: 'text', text: 'It is raining.' },
    ))).toBe('It is raining.')
  })

  it('says nothing when the message carries no text at all', () => {
    expect(assistantText(assistantData({ type: 'reasoning', text: 'only thinking' }))).toBeUndefined()
    expect(assistantText(assistantData())).toBeUndefined()
  })

  it('says nothing for a shape that is not an assistant message', () => {
    expect(assistantText(undefined)).toBeUndefined()
    expect(assistantText('a string')).toBeUndefined()
    expect(assistantText(null)).toBeUndefined()
    expect(assistantText({})).toBeUndefined()
    expect(assistantText({ message: null })).toBeUndefined()
    expect(assistantText({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })).toBeUndefined()
    expect(assistantText({ message: { role: 'assistant', content: 'not an array' } })).toBeUndefined()
  })

  it('ignores a part whose text is not a string', () => {
    expect(assistantText(assistantData({ type: 'text', text: 42 }, { type: 'text', text: 'ok' }))).toBe('ok')
  })
})

describe('answerFrom', () => {
  it('is pending until a terminal frame arrives', () => {
    expect(answerFrom([])).toEqual({ kind: 'pending' })
    expect(answerFrom([{ type: 'assistant-stream', frame: { type: 'chunk', chunk: 'x' } }])).toEqual({ kind: 'pending' })
  })

  it('reads the answer from the committed durable record, found among live event frames', () => {
    const frames: FollowFrame[] = [
      { type: 'event', event: event(7, assistantData({ type: 'text', text: 'probe one.' })) },
      end({ kind: 'committed', eventType: 'assistant/message', seq: 7 }),
    ]
    expect(answerFrom(frames)).toEqual({ kind: 'answer', text: 'probe one.' })
  })

  it('finds the record in the opening snapshot too, not only in live frames', () => {
    const frames: FollowFrame[] = [
      { type: 'snapshot', cursor: 7, records: [{ type: 'event', event: event(7, assistantData({ type: 'text', text: 'from the snapshot' })) }] },
      end({ kind: 'committed', eventType: 'assistant/message', seq: 7 }),
    ]
    expect(answerFrom(frames)).toEqual({ kind: 'answer', text: 'from the snapshot' })
  })

  it('reports an abandoned attempt as abandoned, never as an empty answer', () => {
    expect(answerFrom([end({ kind: 'abandoned' })])).toEqual({ kind: 'abandoned' })
  })

  it('refuses to answer from a commit that is not an assistant message', () => {
    // `assistant/attempt` is a checkpoint, not a reply. Answering from it would return a fragment as though it
    // were the turn's result.
    expect(answerFrom([end({ kind: 'committed', eventType: 'assistant/attempt', seq: 7 })])).toEqual({ kind: 'unresolved' })
  })

  it('is unresolved when the commit points at a record the stream never delivered', () => {
    expect(answerFrom([end({ kind: 'committed', eventType: 'assistant/message', seq: 99 })])).toEqual({ kind: 'unresolved' })
  })

  it('keeps looking past a snapshot that does not hold the committed record', () => {
    // A snapshot can predate the commit. The lookup must not stop at the first place it looked.
    const frames: FollowFrame[] = [
      { type: 'snapshot', cursor: 3, records: [{ type: 'event', event: event(3, assistantData({ type: 'text', text: 'older turn' })) }] },
      end({ kind: 'committed', eventType: 'assistant/message', seq: 8 }),
    ]
    expect(answerFrom(frames)).toEqual({ kind: 'unresolved' })
  })

  it('is unresolved when the committed record carries no speakable text', () => {
    const frames: FollowFrame[] = [
      { type: 'event', event: event(7, assistantData({ type: 'reasoning', text: 'only thinking' })) },
      end({ kind: 'committed', eventType: 'assistant/message', seq: 7 }),
    ]
    expect(answerFrom(frames)).toEqual({ kind: 'unresolved' })
  })

  it('is unresolved when the text is only whitespace', () => {
    const frames: FollowFrame[] = [
      { type: 'event', event: event(7, assistantData({ type: 'text', text: '   ' })) },
      end({ kind: 'committed', eventType: 'assistant/message', seq: 7 }),
    ]
    expect(answerFrom(frames)).toEqual({ kind: 'unresolved' })
  })
})
