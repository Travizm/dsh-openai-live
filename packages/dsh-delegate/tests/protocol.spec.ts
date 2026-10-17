import { describe, expect, it } from 'vitest'
import {
  COMPLETIONS_PATH,
  DelegateRequestError,
  toCompletion,
  toPromptRequest,
} from '../src/index.ts'
import type { CompletionBody } from '../src/index.ts'

const body = (over: Partial<CompletionBody> = {}): CompletionBody => ({
  sessionId: 'session-abc',
  messages: [{ role: 'user', content: 'What is the weather?' }],
  ...over,
})

const refusal = (fn: () => unknown): DelegateRequestError => {
  try { fn() } catch (error) { return error as DelegateRequestError }
  throw new Error('expected a refusal')
}

describe('toPromptRequest', () => {
  it('renders one text part per message, with the role kept visible', () => {
    // `PromptContentPart` has no role channel, so the role has to be rendered. Dropping it would read
    // identically in a test and change meaning in a conversation: a system instruction becomes user speech.
    const request = toPromptRequest(body({
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'What is the weather?' },
      ],
    }))
    expect(request.content).toEqual([
      { type: 'text', text: '[system] Be terse.' },
      { type: 'text', text: '[user] What is the weather?' },
    ])
  })

  it('queues rather than steers, because a completion is a turn', () => {
    // Steering interleaves into work already in flight; a completion has no in-flight work to join.
    expect(toPromptRequest(body()).mode).toBe('queue')
  })

  it('carries the session and a generated request id for correlation', () => {
    const request = toPromptRequest(body(), () => 'req-fixed')
    expect(request.sessionId).toBe('session-abc')
    expect(request.requestId).toBe('req-fixed')
  })

  it('keeps a caller-supplied request id, so a caller can correlate its own turn', () => {
    expect(toPromptRequest(body({ requestId: 'req-mine' }), () => 'ignored').requestId).toBe('req-mine')
  })

  it('passes the caller time zone through only when it is given', () => {
    // Absent must stay absent: a default here would silently date-format against the shim's clock.
    expect('clientTimeZone' in toPromptRequest(body())).toBe(false)
    expect(toPromptRequest(body({ clientTimeZone: 'Australia/Brisbane' })).clientTimeZone).toBe('Australia/Brisbane')
  })

  it('refuses a request with no messages', () => {
    expect(refusal(() => toPromptRequest(body({ messages: [] }))).code).toBe('NO_MESSAGES')
    expect(refusal(() => toPromptRequest({ sessionId: 's' } as CompletionBody)).code).toBe('NO_MESSAGES')
  })

  it('refuses a parts array by name, rather than stringifying it into a prompt', () => {
    const parts = body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as never] })
    const error = refusal(() => toPromptRequest(parts))
    expect(error.code).toBe('UNSUPPORTED_CONTENT')
    expect(error.message).toContain('message 0')
    expect(error.message).toContain('text only')
  })

  it('refuses an unknown role instead of guessing one', () => {
    const error = refusal(() => toPromptRequest(body({ messages: [{ role: 'tool', content: 'x' } as never] })))
    expect(error.code).toBe('MALFORMED_REQUEST')
    expect(error.message).toContain('"tool"')
  })

  it('refuses an empty message, naming its index', () => {
    const error = refusal(() => toPromptRequest(body({
      messages: [{ role: 'user', content: 'ok' }, { role: 'assistant', content: '   ' }],
    })))
    expect(error.code).toBe('MALFORMED_REQUEST')
    expect(error.message).toContain('message 1')
  })

  it('exposes a stable path for the HTTP surface to serve', () => {
    expect(COMPLETIONS_PATH).toBe('/v1/chat/completions')
  })
})

describe('toCompletion', () => {
  it('renders an answer as an OpenAI-shaped completion', () => {
    expect(toCompletion('It is raining.', { model: 'dsh-delegate', requestId: 'req-1', created: 1_700_000_000 }))
      .toEqual({
        id: 'chatcmpl-req-1',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'dsh-delegate',
        choices: [{ index: 0, message: { role: 'assistant', content: 'It is raining.' }, finish_reason: 'stop' }],
      })
  })

  it('omits usage rather than inventing token counts', () => {
    // The shim never sees the provider's usage. A zeroed object would be a number a caller bills against, and
    // an invented one would be worse. Absent is the only honest value available here.
    expect('usage' in toCompletion('x', { model: 'm', requestId: 'r', created: 0 })).toBe(false)
  })

  it('always finishes with stop — a partial answer has no representation here', () => {
    expect(toCompletion('', { model: 'm', requestId: 'r', created: 0 }).choices[0]?.finish_reason).toBe('stop')
  })
})
