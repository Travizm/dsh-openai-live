import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import RealtimeRuntime from 'dsh-realtime'
import * as plugin from '../src/index.ts'

/**
 * The plugin entry, mounted the way the Loader mounts it: a real `Context` with the real seam service,
 * then `apply`. Hand-built `ctx.plugin(...)` suites are explicitly insufficient for a product-visible
 * plugin, but they are exactly right for asserting what `apply` contributes — the composition-level
 * test belongs with the bundle, not here.
 */
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function mount(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  new RealtimeRuntime(ctx)
  return ctx
}

describe('the Loader contract', () => {
  it('named-exports its namespace and has NO default export', () => {
    // The harness's own documented regression: a default export makes the Loader discard the
    // namespace, so the plugin loads and contributes nothing — a silent, total failure.
    expect('default' in plugin).toBe(false)
    expect('apply' in plugin).toBe(true)
    expect('name' in plugin).toBe(true)
    expect('inject' in plugin).toBe(true)
    expect('Config' in plugin).toBe(true)
  })

  it('declares the seam it registers onto', () => {
    expect(plugin.name).toBe('realtime-openai-live')
    expect(plugin.inject).toEqual(['realtime'])
  })
})

describe('Config', () => {
  it('fills in every default, so a composition can supply only the credential', () => {
    const resolved = plugin.Config({ apiKey: 'test-value' })
    expect(resolved).toMatchObject({
      baseURL: 'wss://api.openai.com/v1/live/sessions',
      provider: 'openai-live',
      model: 'gpt-live-1',
      voice: 'marin',
      appendAckTimeoutMs: 10_000,
      establishTimeoutMs: 20_000,
    })
  })

  it('resolves without a credential, so a keyless profile still composes', () => {
    // The failure belongs at the session request as a coded error, not at boot as an opaque one.
    expect(plugin.Config({})).toMatchObject({ model: 'gpt-live-1' })
  })

  it('honours a supplied override', () => {
    expect(plugin.Config({ voice: 'coral', model: 'gpt-live-1-mini' }))
      .toMatchObject({ voice: 'coral', model: 'gpt-live-1-mini' })
  })
})

describe('apply', () => {
  it('registers its provider route on the seam', () => {
    const ctx = mount()
    plugin.apply(ctx, plugin.Config({ apiKey: 'test-value' }))
    expect(ctx.realtime.listProviders()).toEqual([
      { id: 'openai-live', name: 'OpenAI Live', description: 'GPT-Live-1 full-duplex voice with client delegation' },
    ])
  })

  it('registers the route named by configuration rather than a hardcoded one', () => {
    const ctx = mount()
    plugin.apply(ctx, plugin.Config({ apiKey: 'test-value', provider: 'openai-live-alt' }))
    expect(ctx.realtime.listProviders().map(entry => entry.id)).toEqual(['openai-live-alt'])
  })

  it('composes without a credential, deferring the failure to the session request', () => {
    const ctx = mount()
    expect(() => plugin.apply(ctx, plugin.Config({}))).not.toThrow()
    expect(ctx.realtime.listProviders()).toHaveLength(1)
  })

  it('withdraws its route when the contributing fiber is disposed', async () => {
    // Dispose the whole fiber, then observe via the instance: withdrawing the fiber also unregisters
    // the service, so reading `ctx.realtime` afterwards would test the wrong thing (and throw).
    const ctx = new Context()
    contexts.push(ctx)
    const service = new RealtimeRuntime(ctx)
    plugin.apply(ctx, plugin.Config({ apiKey: 'test-value' }))
    expect(service.listProviders()).toHaveLength(1)
    await ctx.fiber.dispose()
    expect(service.listProviders()).toEqual([])
  })
})
