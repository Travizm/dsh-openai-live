import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APPEND_CHAR_LIMIT, toDelegation, toProviderError, toStarted, toTranscript, toUsage } from '../src/translate.ts'
import { parseServerEvent } from '../src/wire.ts'

/** One recorded server frame, as the fixture stores it. */
interface RecordedFrame {
  /** Milliseconds from session start, as observed. */
  t: number
  /** The provider's frame, verbatim. */
  event: Record<string, unknown>
}

/**
 * The recorded session these specs replay came off a live `gpt-live-1` session on 2026-10-07
 * (`spike/evidence/w1-m4-events.jsonl`), trimmed to the server frames plus two real audio deltas.
 *
 * This is the point of the fixture: the translation layer is verified against **what the provider
 * actually sent**, with no key and no network. A hand-written frame only proves the parser agrees
 * with whoever wrote the frame.
 */
const fixture: RecordedFrame[] = readFileSync(new URL('./fixtures/live-session.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line: string) => JSON.parse(line) as RecordedFrame)

const framesOf = (type: string): RecordedFrame[] => fixture.filter(row => row.event.type === type)
const parsed = fixture.map(row => parseServerEvent(JSON.stringify(row.event)))

describe('the recorded session is a usable fixture', () => {
  it('parses every recorded frame', () => {
    expect(fixture.length).toBeGreaterThan(20)
    expect(parsed.every(event => event !== null)).toBe(true)
  })

  it('records a clean session: the provider reported no error', () => {
    expect(framesOf('error')).toHaveLength(0)
  })
})

describe('toTranscript', () => {
  it('reads every input transcript delta as input', () => {
    const frames = framesOf('session.input_transcript.delta')
    expect(frames.length).toBeGreaterThan(0)
    for (const row of frames) {
      expect(toTranscript(parseServerEvent(JSON.stringify(row.event))!)).toMatchObject({ kind: 'input', final: false })
    }
  })

  it('reconstructs the utterance that was streamed in', () => {
    const text = framesOf('session.input_transcript.delta')
      .map(row => toTranscript(parseServerEvent(JSON.stringify(row.event))!)?.text ?? '')
      .join('')
    expect(text).toContain('deployment status of the staging environment')
  })

  it('reads output transcript deltas as output', () => {
    const frames = framesOf('session.output_transcript.delta')
    expect(frames.length).toBeGreaterThan(0)
    expect(toTranscript(parseServerEvent(JSON.stringify(frames[0]!.event))!)).toMatchObject({ kind: 'output' })
  })

  it('returns undefined for a frame that is not a transcript', () => {
    expect(toTranscript({ type: 'session.started' })).toBeUndefined()
  })

  it('returns undefined when the delta is missing or not a string', () => {
    expect(toTranscript({ type: 'session.input_transcript.delta' })).toBeUndefined()
    expect(toTranscript({ type: 'session.input_transcript.delta', delta: 5 })).toBeUndefined()
  })

  it('accepts an empty delta as a real fragment rather than dropping the frame', () => {
    expect(toTranscript({ type: 'session.output_transcript.delta', delta: '' }))
      .toEqual({ kind: 'output', text: '', final: false })
  })
})

describe('toDelegation', () => {
  it('reads the recorded client delegation', () => {
    const frames = framesOf('session.delegation.created')
    expect(frames).toHaveLength(1)
    const delegation = toDelegation(parseServerEvent(JSON.stringify(frames[0]!.event))!)
    expect(delegation?.target).toBe('client')
    expect(delegation?.id).toMatch(/^item_/)
    expect(delegation?.offsetMs).toBeGreaterThan(0)
  })

  it('never invents task text, because the wire carries none', () => {
    const delegation = toDelegation({ type: 'session.delegation.created', delegation: { id: 'item_1', target: 'client' } })
    expect(Object.keys(delegation!).sort()).toEqual(['id', 'offsetMs', 'target'])
  })

  it('defaults a missing offset to zero and preserves a real one', () => {
    expect(toDelegation({ type: 'session.delegation.created', delegation: { id: 'i', target: 'client' } })?.offsetMs).toBe(0)
    expect(toDelegation({ type: 'session.delegation.created', delegation: { id: 'i', target: 'client' }, offset_ms: 4600 })?.offsetMs).toBe(4600)
  })

  it('rejects a delegation without a usable id or target', () => {
    expect(toDelegation({ type: 'session.delegation.created' })).toBeUndefined()
    expect(toDelegation({ type: 'session.delegation.created', delegation: null })).toBeUndefined()
    expect(toDelegation({ type: 'session.delegation.created', delegation: { target: 'client' } })).toBeUndefined()
    expect(toDelegation({ type: 'session.delegation.created', delegation: { id: '', target: 'client' } })).toBeUndefined()
    expect(toDelegation({ type: 'session.delegation.created', delegation: { id: 'i', target: 'nobody' } })).toBeUndefined()
  })

  it('accepts the responses target, which a different delegation mode would produce', () => {
    expect(toDelegation({ type: 'session.delegation.created', delegation: { id: 'i', target: 'responses' } })?.target)
      .toBe('responses')
  })

  it('returns undefined for a frame that is not a delegation', () => {
    expect(toDelegation({ type: 'session.started' })).toBeUndefined()
  })
})

describe('toUsage', () => {
  it('reads the recorded usage in audio-seconds', () => {
    const frames = framesOf('session.usage.updated')
    expect(frames.length).toBeGreaterThan(0)
    for (const row of frames) {
      expect(toUsage(parseServerEvent(JSON.stringify(row.event))!)?.seconds).toBe(7)
    }
  })

  it('returns undefined when no usable figure is present', () => {
    expect(toUsage({ type: 'session.usage.updated' })).toBeUndefined()
    expect(toUsage({ type: 'session.usage.updated', usage: {} })).toBeUndefined()
    expect(toUsage({ type: 'session.usage.updated', usage: { seconds: -1 } })).toBeUndefined()
    expect(toUsage({ type: 'session.usage.updated', usage: { seconds: 'seven' } })).toBeUndefined()
    expect(toUsage({ type: 'session.usage.updated', usage: { seconds: Number.NaN } })).toBeUndefined()
  })

  it('accepts zero', () => {
    expect(toUsage({ type: 'session.usage.updated', usage: { seconds: 0 } })).toEqual({ seconds: 0 })
  })
})

describe('toStarted', () => {
  it('reports what the provider accepted, not what was requested', () => {
    const row = framesOf('session.started')[0]!
    const started = toStarted(parseServerEvent(JSON.stringify(row.event))!, {
      provider: 'openai-live',
      model: 'gpt-live-1',
      voice: 'marin',
    })
    expect(started.provider).toBe('openai-live')
    expect(started.model).toBe('gpt-live-1')
    expect(started.voice).toBe('marin')
    expect(started.inputAudio).toEqual({ sampleRate: 24_000, channels: 1, encoding: 'pcm16' })
    expect(started.outputAudio).toEqual({ sampleRate: 24_000, channels: 1, encoding: 'pcm16' })
  })

  it('falls back to the requested values when the provider reports nothing', () => {
    const started = toStarted({ type: 'session.started' }, { provider: 'p', model: 'm', voice: 'v' })
    expect(started).toMatchObject({ provider: 'p', model: 'm', voice: 'v' })
  })

  it('omits the voice key when neither side names one', () => {
    const started = toStarted({ type: 'session.started' }, { provider: 'p', model: 'm' })
    expect('voice' in started).toBe(false)
  })

  it('prefers the provider voice over the requested one', () => {
    const started = toStarted(
      { type: 'session.started', session: { model: 'gpt-live-1', audio: { output: { voice: 'verse' } } } },
      { provider: 'p', model: 'm', voice: 'marin' },
    )
    expect(started.voice).toBe('verse')
  })

  it('ignores a non-string provider voice rather than propagating it', () => {
    const started = toStarted(
      { type: 'session.started', session: { audio: { output: { voice: 7 } } } },
      { provider: 'p', model: 'm', voice: 'marin' },
    )
    expect(started.voice).toBe('marin')
  })
})

describe('toProviderError', () => {
  it('preserves the field-naming detail, which is the fastest available specification', () => {
    const error = toProviderError({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Invalid value', param: 'type' },
    })
    expect(error?.code).toBe('PROVIDER_ERROR')
    expect(error?.message).toContain('Invalid value')
    expect(error?.message).toContain('code=invalid_value')
    expect(error?.message).toContain('param=type')
  })

  it('classifies a refused credential, so a caller can tell the user to replace it', () => {
    const error = toProviderError({
      type: 'error',
      error: { code: 'invalid_api_key', message: 'Incorrect API key provided' },
    })
    expect(error?.code).toBe('CREDENTIAL_REJECTED')
    expect(error?.detail).toMatchObject({ providerCode: 'invalid_api_key', retryable: false })
    expect(error?.detail?.remedy).toBeDefined()
    // The page a person acts on travels with the remedy. Written as a literal rather than read from the table
    // under test: a check that derives its expectation from its subject can only ever agree with it.
    expect(error?.detail?.link).toBe('https://platform.openai.com/api-keys')
  })

  it('sends an account with no credit to the billing page, not just the words "add credit"', () => {
    const error = toProviderError({
      type: 'error',
      error: { code: 'credit_balance_exhausted', message: 'You have no credits remaining.' },
    })

    expect(error?.code).toBe('INSUFFICIENT_CREDIT')
    expect(error?.detail).toMatchObject({
      providerCode: 'credit_balance_exhausted',
      retryable: false,
      link: 'https://platform.openai.com/settings/organization/billing/',
    })
    // The provider's message contains this URL and the message is deliberately not carried — a provider
    // message is where a key turns up. So the page has to survive on its own, or the remedy names an action
    // and not its destination, which is the half nobody can guess.
    expect(error?.detail?.remedy).toContain('add credit')
  })

  it('marks a throttle retryable, which a refusal is not', () => {
    const error = toProviderError({
      type: 'error',
      error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' },
    })
    expect(error?.code).toBe('RATE_LIMITED')
    expect(error?.detail?.retryable).toBe(true)
  })

  it('keeps the generic class for a code it does not recognise, rather than guessing', () => {
    const error = toProviderError({
      type: 'error',
      error: { code: 'some_unheard_of_code', message: 'Who knows' },
    })
    expect(error?.code).toBe('PROVIDER_ERROR')
    expect(error?.detail).toMatchObject({ providerCode: 'some_unheard_of_code', retryable: false })
  })

  it('copes with a missing, null or non-object error body', () => {
    expect(toProviderError({ type: 'error' })?.message).toContain('unspecified')
    expect(toProviderError({ type: 'error', error: null })?.message).toContain('unspecified')
    expect(toProviderError({ type: 'error', error: { code: null, param: null } })?.message).toContain('unspecified')
  })
})

describe('append bound', () => {
  it('is the seam bound, not a second opinion', () => {
    expect(APPEND_CHAR_LIMIT).toBe(2000)
  })
})
