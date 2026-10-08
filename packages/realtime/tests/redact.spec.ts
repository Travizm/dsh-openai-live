import { describe, expect, it } from 'vitest'
import { REDACTED, redact } from '../src/redact.ts'

/**
 * Key-shaped fixtures, **assembled rather than written**.
 *
 * `scripts/leak-scan.mjs` sweeps every tracked file for unambiguous credential shapes and has **no
 * allow-list** — deliberately, because a check with a compliant path relocates the work instead of
 * preventing it. A literal in the shape of a key therefore cannot be committed here, and should not
 * be: the scan cannot tell a fixture from the real thing, and that is exactly what makes it worth
 * having. Concatenation hands the redactor the identical bytes to remove.
 */
const KEY = 'sk-' + 'abcdefghijklmnop'
const SENTINEL_KEY = 'sk-' + 'sentinelmustneverappear0001'
const SENTINEL_TEXT = 'sentinelmustneverappear'
const PEM = ['-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----', '\nAAAA\n', '-----END ', 'OPENSSH ', 'PRIVATE KEY-----'].join('')
const FINGERPRINT = 'fp=' + '0123456789abcdef0123456789abcdef'

/**
 * The redaction primitive, tested as an adversarial reading of itself.
 *
 * Every case here is a *sink* in miniature: the text that would reach the journal, the route or the
 * user's ear. A test that only checks a happy path proves nothing about the failure that matters —
 * a key that reached the wrong reader — so the interesting assertions are the negative ones.
 */
describe('redact', () => {
  it('leaves ordinary diagnostic text alone', () => {
    expect(redact('the session controller refused the prompt: model unavailable'))
      .toBe('the session controller refused the prompt: model unavailable')
  })

  it('returns an empty string unchanged', () => {
    expect(redact('')).toBe('')
  })

  it('returns a non-string unchanged, so a diagnostics path cannot throw on bad input', () => {
    // A failure raised while reporting a failure is the worst place to discover a malformed argument.
    expect(redact(undefined as unknown as string)).toBeUndefined()
  })

  it('removes a provider key by shape', () => {
    expect(redact(`rejected key ${KEY} for model gpt-live-1`))
      .toBe(`rejected key ${REDACTED} for model gpt-live-1`)
  })

  it('removes the rk- and pk- prefixes as well as sk-', () => {
    expect(redact('rk-' + '0123456789abcdef')).toBe(REDACTED)
    expect(redact('pk-' + '0123456789abcdef')).toBe(REDACTED)
  })

  it('removes a bearer header but keeps the header name', () => {
    expect(redact('Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwx'))
      .toBe(`Authorization: Bearer ${REDACTED}`)
  })

  it('removes a private key block whole, not line by line', () => {
    expect(redact(`handshake failed: ${PEM}`)).toBe('handshake failed: [redacted private key]')
  })

  it('removes a JWT', () => {
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'dBjftJeZ4CVP',
    ].join('.')
    expect(redact(`token ${jwt} expired`)).toBe(`token ${REDACTED} expired`)
  })

  it('removes a recorded key fingerprint', () => {
    expect(redact(FINGERPRINT)).toBe(`fp=${REDACTED}`)
  })

  it('removes a known secret that has no shape at all — the route token', () => {
    // The capability token is 32 random base64url bytes. No pattern can ever catch it, which is
    // exactly why the caller that holds it must name it.
    //
    // Derived, not written: a literal high-entropy string slips past `scripts/leak-scan.mjs` — which
    // refuses entropy guessing by design, because a false positive there corrupts the diagnostic it
    // guards — and still trips CI's gitleaks, which *does* guess by entropy. Same shape, no literal.
    const token = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url')
    expect(redact(`upgrade refused: /dsh-realtime/audio?t=${token}`, [token]))
      .toBe(`upgrade refused: /dsh-realtime/audio?t=${REDACTED}`)
  })

  it('removes the longest known secret first, so no fragment of it survives', () => {
    expect(redact('abcdefghij', ['abcd', 'abcdefghij'])).toBe(REDACTED)
  })

  it('ignores empty and non-string entries in the secret list', () => {
    expect(redact('safe text', ['', 7 as unknown as string])).toBe('safe text')
  })

  it('never emits the secret it removed', () => {
    const out = redact(`provider said: ${SENTINEL_KEY} is invalid`, [SENTINEL_KEY])
    expect(out).not.toContain(SENTINEL_TEXT)
    expect(out).toContain(REDACTED)
  })
})
