import { describe, expect, it } from 'vitest'
import {
  BOOLEAN_CAPABILITIES,
  DEEPGRAM_CAPABILITIES,
  REALTIME_ERROR_CODES,
  RealtimeError,
  assertPromptUpdate,
  auditCapabilities,
  requireCapability,
} from '../src/index.ts'
import type { RealtimeCapabilities, RealtimeProviderInfo } from '../src/index.ts'

const route = (capabilities?: RealtimeCapabilities): RealtimeProviderInfo =>
  ({ id: 'test-route', name: 'Test route', ...(capabilities === undefined ? {} : { capabilities }) })

const all = (over: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities => ({
  appendThinking: true,
  appAuthoredSpeech: true,
  functionCalls: true,
  usageReporting: true,
  transcriptDeltas: true,
  inputMute: true,
  promptUpdate: 'replace',
  ...over,
})

describe('requireCapability', () => {
  it('refuses a capability the provider declared it does not have, with a code rather than prose', () => {
    // The whole point of the declaration: a caller finds out at the call site, not by watching a live session
    // do nothing. The message names the operation in the caller's words, because that is what gets read.
    expect(() => requireCapability(route(all({ appendThinking: false })), 'appendThinking', 'append thinking'))
      .toThrowError(RealtimeError)
    try {
      requireCapability(route(all({ inputMute: false })), 'inputMute', 'mute the input')
    } catch (error) {
      expect((error as RealtimeError).code).toBe(REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED)
      expect((error as RealtimeError).message).toContain('cannot mute the input')
      expect((error as RealtimeError).message).toContain('inputMute = false')
      expect((error as RealtimeError).message).toContain('test-route')
    }
  })

  it('allows a capability the provider declared', () => {
    expect(() => requireCapability(route(all()), 'functionCalls', 'call a function')).not.toThrow()
  })

  it('does not refuse a provider that has declared nothing', () => {
    // Absent is not "cannot". Refusing on a route's behalf would break every adapter that predates the
    // declaration — and it would be a claim about a provider nobody has asked.
    expect(() => requireCapability(route(), 'appendThinking', 'append thinking')).not.toThrow()
  })

  it('never widens PROVIDER_ERROR — a retry loop must be able to tell them apart', () => {
    expect(REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED).not.toBe(REALTIME_ERROR_CODES.PROVIDER_ERROR)
  })
})

describe('assertPromptUpdate', () => {
  it('lets a caller that needs a replacement proceed only when the provider replaces', () => {
    expect(() => assertPromptUpdate(route(all({ promptUpdate: 'replace' })), 'replace')).not.toThrow()
  })

  it('refuses a replacement against an appending provider, and says which mode it has', () => {
    // The distinction is not pedantry: replacement discards the previous rules, and a caller relying on that
    // would silently keep them.
    try {
      assertPromptUpdate(route(all({ promptUpdate: 'append' })), 'replace')
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as RealtimeError).code).toBe(REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED)
      expect((error as RealtimeError).message).toContain('promptUpdate = append')
    }
  })

  it('refuses a replacement against an unknown, rather than assuming the kinder reading', () => {
    expect(() => assertPromptUpdate(route(all({ promptUpdate: 'unknown' })), 'replace')).toThrowError(RealtimeError)
  })

  it('lets a caller that only needs appending proceed against either established mode', () => {
    // A replace still installs the new rule; it merely also discards what came before, which an appending
    // caller has not relied on.
    expect(() => assertPromptUpdate(route(all({ promptUpdate: 'replace' })), 'append')).not.toThrow()
    expect(() => assertPromptUpdate(route(all({ promptUpdate: 'append' })), 'append')).not.toThrow()
  })

  it('refuses an append against an unknown', () => {
    expect(() => assertPromptUpdate(route(all({ promptUpdate: 'unknown' })), 'append')).toThrowError(RealtimeError)
  })

  it('says nothing about a provider that has declared nothing', () => {
    expect(() => assertPromptUpdate(route(), 'replace')).not.toThrow()
  })
})

describe('auditCapabilities', () => {
  it('passes when every declaration matches what the adapter did', () => {
    const audit = auditCapabilities(all(), [
      { capability: 'appendThinking', outcome: 'used' },
      { capability: 'functionCalls', outcome: 'used' },
    ])
    expect(audit).toEqual({ honoured: true, divergences: [], unknowns: [] })
  })

  it('catches a capability declared false but used — the declaration under-sold the provider', () => {
    const audit = auditCapabilities(all({ appendThinking: false }), [{ capability: 'appendThinking', outcome: 'used' }])
    expect(audit.honoured).toBe(false)
    expect(audit.divergences).toEqual(['appendThinking: declared false, but the adapter used it'])
  })

  it('catches a capability declared true but refused — the promise a user experiences as flakiness', () => {
    const audit = auditCapabilities(all(), [{ capability: 'usageReporting', outcome: 'refused' }])
    expect(audit.honoured).toBe(false)
    expect(audit.divergences).toEqual(['usageReporting: declared true, but the adapter refused it'])
  })

  it('reports an unknown prompt-update mode always, and never fails on it', () => {
    // An admitted unknown is not a contradiction. Failing it would push the next person to assert a value
    // they cannot support, which is the failure this whole module exists to avoid.
    const audit = auditCapabilities(all({ promptUpdate: 'unknown' }), [])
    expect(audit.honoured).toBe(true)
    expect(audit.unknowns).toHaveLength(1)
    expect(audit.unknowns[0]).toContain('promptUpdate')
  })

  it('accumulates every divergence rather than stopping at the first', () => {
    const audit = auditCapabilities(all({ inputMute: false, transcriptDeltas: false }), [
      { capability: 'inputMute', outcome: 'used' },
      { capability: 'transcriptDeltas', outcome: 'used' },
    ])
    expect(audit.divergences).toHaveLength(2)
  })
})

describe('the declarations themselves', () => {
  it('lists every boolean capability once, so an audit cannot silently skip one', () => {
    expect([...BOOLEAN_CAPABILITIES]).toEqual([
      'appendThinking', 'appAuthoredSpeech', 'functionCalls', 'usageReporting', 'transcriptDeltas', 'inputMute',
    ])
    expect(new Set(BOOLEAN_CAPABILITIES).size).toBe(BOOLEAN_CAPABILITIES.length)
  })

  it('declares Deepgram from evidence: no usage event and utterance-level transcripts are probed facts', () => {
    // These two were ❓ in the chamber's §6.2 table and are now confirmed on the wire — the declaration is
    // where that probe result becomes something the code can act on.
    expect(DEEPGRAM_CAPABILITIES.usageReporting).toBe(false)
    expect(DEEPGRAM_CAPABILITIES.transcriptDeltas).toBe(false)
    expect(DEEPGRAM_CAPABILITIES.promptUpdate).toBe('unknown')
    // Muting is implemented adapter-side (the session stops writing audio). Declaring it false would refuse a
    // call that works — the declaration describes the seam's method, not the provider's vocabulary.
    expect(DEEPGRAM_CAPABILITIES.inputMute).toBe(true)
  })

  it('is frozen, because a capability declaration that a caller can mutate is not a declaration', () => {
    expect(Object.isFrozen(DEEPGRAM_CAPABILITIES)).toBe(true)
  })

  it('audits clean against itself when nothing is exercised', () => {
    const audit = auditCapabilities(DEEPGRAM_CAPABILITIES, [])
    expect(audit.honoured).toBe(true)
    expect(audit.unknowns).toHaveLength(1)
  })
})
