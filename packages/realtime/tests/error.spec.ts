/**
 * The seam's failure structure.
 *
 * The point of `detail` is that a consumer can *act* on a failure without parsing prose, which only
 * holds if the structure is always well-formed — so the constructor validates it, for the same reason
 * it validates its own message and code: a failure raised while reporting a failure is the worst
 * place to discover a malformed argument.
 */

import { describe, expect, it } from 'vitest'
import { RealtimeError } from 'dsh-realtime'

describe('RealtimeError detail', () => {
  it('retains structured detail, so a caller can act without interpreting prose', () => {
    const error = new RealtimeError('the key was refused', 'CREDENTIAL_REJECTED', {
      detail: {
        remedy: 'replace the configured credential',
        setting: 'apiKey',
        retryable: false,
        providerCode: 'invalid_api_key',
      },
    })
    expect(error.code).toBe('CREDENTIAL_REJECTED')
    expect(error.detail).toEqual({
      remedy: 'replace the configured credential',
      setting: 'apiKey',
      retryable: false,
      providerCode: 'invalid_api_key',
    })
  })

  it('leaves detail undefined when none was supplied, rather than inventing an empty one', () => {
    expect(new RealtimeError('something broke', 'PROVIDER_ERROR').detail).toBeUndefined()
  })

  it('accepts a partial detail, checking only the fields actually supplied', () => {
    const error = new RealtimeError('throttled', 'RATE_LIMITED', { detail: { retryable: true } })
    expect(error.detail).toEqual({ retryable: true })
  })

  it('rejects a field of the wrong type rather than attaching it', () => {
    expect(() => new RealtimeError('throttled', 'RATE_LIMITED', {
      detail: { retryable: 'yes' } as never,
    })).toThrow(TypeError)
  })

  it('rejects an empty-string field, which would render as a blank instruction', () => {
    expect(() => new RealtimeError('throttled', 'RATE_LIMITED', {
      detail: { remedy: '' },
    })).toThrow(TypeError)
  })

  it('names the offending field, so a malformed detail is fixable from the message alone', () => {
    expect(() => new RealtimeError('throttled', 'RATE_LIMITED', {
      detail: { providerCode: 7 } as never,
    })).toThrow(/detail\.providerCode/)
  })
})
