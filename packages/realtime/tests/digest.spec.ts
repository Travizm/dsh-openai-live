import { describe, expect, it } from 'vitest'
import { DIGEST_CHARS, digestOf } from '../src/index.ts'

describe('digestOf', () => {
  it('is stable for one text and different for another', () => {
    // The whole value of a digest is that it is comparable across two records that were written at
    // different times by different code: a ledger entry here, a session log there.
    expect(digestOf('is staging ok?')).toBe(digestOf('is staging ok?'))
    expect(digestOf('is staging ok?')).not.toBe(digestOf('is staging ok!'))
    // A one-character difference must not survive as the same fingerprint, or the digest cannot
    // distinguish a relayed question from a later one that only looks like it.
    expect(digestOf('dog')).not.toBe(digestOf('dogs'))
  })

  it('is a fixed-width lowercase hex string, so an entry has a predictable size', () => {
    for (const text of ['', 'a', 'x'.repeat(10_000), 'naïve — 漢字 🜚']) {
      expect(digestOf(text)).toMatch(/^[0-9a-f]+$/)
      expect(digestOf(text)).toHaveLength(DIGEST_CHARS)
    }
  })

  it('is total: no input is unrepresentable, including the empty one', () => {
    // No branch here on purpose. A digest that returned a marker for the empty string would make
    // "nothing was said" and "a digest was not computed" the same value, which is the collapse this
    // whole layer exists to avoid.
    expect(digestOf('')).toHaveLength(DIGEST_CHARS)
    expect(digestOf('')).not.toBe(digestOf(' '))
  })
})
