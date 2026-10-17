import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LISTEN_MODEL,
  DEFAULT_SPEAK_MODEL,
  SettingsError,
  buildSettings,
  listenVersion,
} from '../src/index.ts'
import type { SettingsConfig } from '../src/index.ts'

const config = (over: Partial<SettingsConfig> = {}): SettingsConfig => ({
  think: { model: 'gpt-4o-mini', prompt: 'You are a probe.' },
  ...over,
})

const refusal = (fn: () => unknown): SettingsError => {
  try { fn() } catch (error) { return error as SettingsError }
  throw new Error('expected a refusal')
}

describe('buildSettings', () => {
  it('produces the frame the probe ran and Deepgram accepted', () => {
    const settings = buildSettings(config())
    expect(settings.type).toBe('Settings')
    expect(settings.audio).toEqual({
      input: { encoding: 'linear16', sample_rate: 16_000 },
      output: { encoding: 'linear16', sample_rate: 24_000 },
    })
    expect(settings.agent.listen.provider).toEqual({
      type: 'deepgram', model: DEFAULT_LISTEN_MODEL, version: 'v2',
    })
    expect(settings.agent.think).toEqual({
      provider: { type: 'open_ai', model: 'gpt-4o-mini' },
      prompt: 'You are a probe.',
    })
    expect(settings.agent.speak.provider).toEqual({ type: 'deepgram', model: DEFAULT_SPEAK_MODEL })
  })

  it('names the vendor in listen.provider.type, because the model is not the vendor', () => {
    // `flux` here connects and then applies nothing — the failure that cost the first probe run.
    expect(buildSettings(config()).agent.listen.provider.type).toBe('deepgram')
  })

  it('omits the think endpoint when none is given, rather than sending an empty one', () => {
    // An empty `endpoint.url` is rejected; absent means "use Deepgram's managed LLM".
    expect('endpoint' in buildSettings(config()).agent.think).toBe(false)
  })

  it('includes a bring-your-own endpoint when given, normalised to an absolute URL', () => {
    const settings = buildSettings(config({ think: { model: 'm', prompt: 'p', endpoint: 'https://llm.example.com/v1/chat/completions' } }))
    expect(settings.agent.think.endpoint).toEqual({ url: 'https://llm.example.com/v1/chat/completions' })
  })

  it('refuses a loopback endpoint, because the provider cannot reach the caller\'s machine', () => {
    // Not a style rule: this configuration produces a session that fails at the first turn with nothing in the
    // log saying why.
    const error = refusal(() => buildSettings(config({ think: { model: 'm', prompt: 'p', endpoint: 'http://127.0.0.1:8787/v1/chat/completions' } })))
    expect(error.code).toBe('INVALID_ENDPOINT')
    expect(error.field).toBe('think.endpoint')
    expect(error.message).toContain('loopback')
    expect(refusal(() => buildSettings(config({ think: { model: 'm', prompt: 'p', endpoint: 'http://localhost:8787/x' } }))).code).toBe('INVALID_ENDPOINT')
  })

  it('refuses an empty endpoint, which is the shape that broke the probe', () => {
    const error = refusal(() => buildSettings(config({ think: { model: 'm', prompt: 'p', endpoint: '   ' } })))
    expect(error.code).toBe('INVALID_ENDPOINT')
    expect(error.message).toContain('omit it')
  })

  it('refuses an endpoint that is not absolute, and one that is not http', () => {
    expect(refusal(() => buildSettings(config({ think: { model: 'm', prompt: 'p', endpoint: '/v1/chat/completions' } }))).message)
      .toContain('absolute URL')
    expect(refusal(() => buildSettings(config({ think: { model: 'm', prompt: 'p', endpoint: 'ftp://example.com/x' } }))).message)
      .toContain('http or https')
  })

  it('requires a model and a prompt, naming the missing field', () => {
    expect(refusal(() => buildSettings({ think: { model: '', prompt: 'p' } }))).toMatchObject({ code: 'MISSING_FIELD', field: 'think.model' })
    expect(refusal(() => buildSettings({ think: { model: 'm', prompt: '  ' } }))).toMatchObject({ code: 'MISSING_FIELD', field: 'think.prompt' })
    expect(refusal(() => buildSettings({} as SettingsConfig))).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('accepts an end-of-turn threshold in range and carries it', () => {
    expect(buildSettings(config({ listen: { eotThreshold: 0.8 } })).agent.listen.provider.eot_threshold).toBe(0.8)
  })

  it('refuses an end-of-turn threshold outside 0.5–1, instead of sending one the provider ignores', () => {
    const error = refusal(() => buildSettings(config({ listen: { eotThreshold: 0.2 } })))
    expect(error).toMatchObject({ code: 'INVALID_FIELD', field: 'listen.eotThreshold' })
    expect(refusal(() => buildSettings(config({ listen: { eotThreshold: 1.5 } }))).code).toBe('INVALID_FIELD')
    expect(refusal(() => buildSettings(config({ listen: { eotThreshold: Number.NaN } }))).code).toBe('INVALID_FIELD')
  })

  it('carries keyterms only when given', () => {
    expect('keyterms' in buildSettings(config()).agent.listen.provider).toBe(false)
    expect(buildSettings(config({ listen: { keyterms: ['Perio AI'] } })).agent.listen.provider.keyterms).toEqual(['Perio AI'])
  })

  it('lets a caller override the models and the wire rates', () => {
    const settings = buildSettings(config({
      listen: { model: 'nova-3' },
      speak: { model: 'aura-2-orpheus-en' },
      audio: { inputSampleRate: 48_000, outputSampleRate: 16_000 },
    }))
    expect(settings.agent.listen.provider).toMatchObject({ model: 'nova-3', version: 'v1' })
    expect(settings.agent.speak.provider.model).toBe('aura-2-orpheus-en')
    expect(settings.audio.input.sample_rate).toBe(48_000)
    expect(settings.audio.output.sample_rate).toBe(16_000)
  })
})

describe('listenVersion', () => {
  it('selects v2 for Flux and v1 for everything else', () => {
    // The provider decides which API version serves a model; sending v1 for a Flux model is a session that
    // configures and then never hears anything.
    expect(listenVersion('flux-general-en')).toBe('v2')
    expect(listenVersion('flux-general-multi')).toBe('v2')
    expect(listenVersion('nova-3')).toBe('v1')
    expect(listenVersion(DEFAULT_LISTEN_MODEL)).toBe('v2')
  })
})
