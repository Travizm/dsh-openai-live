import { describe, expect, it } from 'vitest'
import type { DelegationRequest } from 'dsh-realtime-agent'
import { answerText, createTurnRunner, promptFrom, type TurnDeps } from '../src/turn.ts'
import type { SessionEventLike } from '../src/types.ts'

const request = (transcript: readonly { kind: 'input' | 'output'; text: string }[]): DelegationRequest => ({
  id: 'item_1',
  offsetMs: 0,
  sessionId: 'sess-1',
  transcript,
} as unknown as DelegationRequest)

/** An appended assistant message, as `session/event` carries one. */
const message = (content: unknown, sessionId = 'sess-1'): SessionEventLike => ({
  type: 'assistant/message',
  sessionId,
  surfaceOp: 'append',
  data: { message: { content } },
})

const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value })

describe('promptFrom', () => {
  it('joins the conversation in order and drops empty lines', () => {
    expect(promptFrom(request([
      { kind: 'input', text: 'is staging ok?' },
      { kind: 'input', text: '' },
      { kind: 'output', text: 'checking' },
    ]), 1_000)).toBe('is staging ok?\nchecking')
  })

  it('truncates on the budget, because a rejected prompt is worse than a short one', () => {
    expect(promptFrom(request([{ kind: 'input', text: 'abcdefghij' }]), 4)).toBe('abcd')
  })

  it('yields nothing for a transcript that carried no text', () => {
    expect(promptFrom(request([{ kind: 'input', text: '' }]), 100)).toBe('')
  })
})

describe('answerText', () => {
  it('reads the text blocks of an appended assistant message', () => {
    expect(answerText(message([text('Staging is green.')]), 'sess-1')).toBe('Staging is green.')
  })

  it('joins multiple text blocks in order', () => {
    expect(answerText(message([text('one'), text('two')]), 'sess-1')).toBe('one\ntwo')
  })

  it('ignores anything that is not an assistant message', () => {
    expect(answerText({ type: 'assistant/chunk' }, 'sess-1')).toBeUndefined()
  })

  it('ignores another session, so one conversation cannot answer for another', () => {
    expect(answerText(message([text('elsewhere')], 'sess-2'), 'sess-1')).toBeUndefined()
  })

  it('ignores a replayed message — only an append is news', () => {
    expect(answerText({ ...message([text('history')]), surfaceOp: 'replace' }, 'sess-1')).toBeUndefined()
  })

  it('ignores a payload with no content array', () => {
    expect(answerText({ type: 'assistant/message', sessionId: 'sess-1', surfaceOp: 'append' }, 'sess-1')).toBeUndefined()
    expect(answerText(message('not-an-array'), 'sess-1')).toBeUndefined()
  })

  it('skips blocks that are not text — nulls, primitives, other kinds', () => {
    expect(answerText(message([
      null,
      'a bare string',
      { type: 'reasoning', text: 'thinking' },
      text('real'),
    ]), 'sess-1')).toBe('real')
  })

  it('skips a text block whose text is not a string', () => {
    expect(answerText(message([{ type: 'text', text: 7 }, text('real')]), 'sess-1')).toBe('real')
  })

  it('treats whitespace-only content as no answer at all', () => {
    expect(answerText(message([text('   ')]), 'sess-1')).toBeUndefined()
  })
})

describe('createTurnRunner', () => {
  const deps = (over: Partial<TurnDeps> = {}) => {
    const admitted: string[] = []
    const listeners: ((event: SessionEventLike) => void)[] = []
    let unsubscribed = 0
    const run = createTurnRunner({
      sessionId: 'sess-1',
      maxPromptChars: 1_000,
      answerTimeoutMs: 50,
      admit: (prompt) => { admitted.push(prompt); return Promise.resolve() },
      subscribe: (listener) => { listeners.push(listener); return () => { unsubscribed += 1 } },
      ...over,
    })
    return { admitted, listeners, unsubscribed: () => unsubscribed, run }
  }

  it('admits the turn, then returns the answer when it lands', async () => {
    const { admitted, listeners, unsubscribed, run } = deps()
    const pending = run(request([{ kind: 'input', text: 'is staging ok?' }]))
    await Promise.resolve()
    expect(admitted).toEqual(['is staging ok?'])
    listeners[0]!(message([text('green')]))
    await expect(pending).resolves.toBe('green')
    expect(unsubscribed()).toBe(1)
  })

  it('subscribes before admitting, so an answer on the same tick is not lost', () => {
    const { listeners, run } = deps()
    void run(request([{ kind: 'input', text: 'q' }]))
    // Synchronously, before the admission has settled.
    expect(listeners).toHaveLength(1)
  })

  it('ignores unrelated events while waiting for its own answer', async () => {
    const { listeners, run } = deps()
    const pending = run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()
    listeners[0]!({})
    listeners[0]!({ type: 'assistant/chunk' })
    listeners[0]!(message([text('someone else')], 'sess-2'))
    listeners[0]!(message([text('green')]))
    await expect(pending).resolves.toBe('green')
  })

  it('declines without admitting when the transcript carried no text', async () => {
    const { admitted, run } = deps()
    await expect(run(request([{ kind: 'input', text: '' }]))).resolves.toBeUndefined()
    expect(admitted).toEqual([])
  })

  it('declines when nothing answers in time, and stops listening', async () => {
    const { unsubscribed, run } = deps({ answerTimeoutMs: 5 })
    await expect(run(request([{ kind: 'input', text: 'q' }]))).resolves.toBeUndefined()
    expect(unsubscribed()).toBe(1)
  })

  it('declines when the controller refuses the admission, and stops listening', async () => {
    const { unsubscribed, run } = deps({ admit: () => Promise.reject(new Error('session/model-unavailable')) })
    await expect(run(request([{ kind: 'input', text: 'q' }]))).resolves.toBeUndefined()
    expect(unsubscribed()).toBe(1)
  })
})
