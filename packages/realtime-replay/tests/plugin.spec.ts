import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import RealtimeRuntime from 'dsh-realtime'
import * as plugin from '../src/index.ts'

/**
 * The plugin entry, mounted the way the Loader mounts it: a real `Context` with the real seam service,
 * then `apply`. A composition-level test belongs with the bundle; this asserts what `apply` contributes.
 */
const contexts: Context[] = []
const FIXTURE = new URL('./fixtures/mini-session.jsonl', import.meta.url).pathname

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
    // A default export makes the Loader discard the namespace, so the plugin loads and contributes
    // nothing — a silent, total failure. The harness's own postmortem is about exactly this.
    expect('default' in plugin).toBe(false)
    for (const key of ['apply', 'name', 'inject', 'Config']) {
      expect(key in plugin).toBe(true)
    }
  })

  it('declares the seam it registers onto', () => {
    expect(plugin.name).toBe('realtime-replay')
    expect(plugin.inject).toEqual(['realtime'])
  })
})

describe('Config', () => {
  it('requires a fixture and fills in every other default', () => {
    const resolved = plugin.Config({ fixture: FIXTURE })
    expect(resolved).toMatchObject({
      provider: 'replay',
      baseURL: 'wss://replay.invalid/v1/live/sessions',
      model: 'gpt-live-1',
      voice: 'marin',
      appendAckTimeoutMs: 5000,
      establishTimeoutMs: 5000,
      fixture: FIXTURE,
    })
  })

  it('defaults the endpoint to an address that cannot resolve', () => {
    // The replay transport never dials, and a default that could resolve invites mistaking replay for
    // a live profile.
    expect(plugin.Config({ fixture: FIXTURE }).baseURL).toContain('.invalid')
  })
})

describe('apply', () => {
  it('registers its provider route on the seam', () => {
    const ctx = mount()
    plugin.apply(ctx, plugin.Config({ fixture: FIXTURE }))
    expect(ctx.realtime.listProviders().map(entry => entry.id)).toEqual(['replay'])
  })

  it('registers the route named by configuration rather than a hardcoded one', () => {
    const ctx = mount()
    plugin.apply(ctx, plugin.Config({ fixture: FIXTURE, provider: 'replay-staging' }))
    expect(ctx.realtime.listProviders().map(entry => entry.id)).toEqual(['replay-staging'])
  })

  it('fails at compose time when the recording is missing, rather than at first use', () => {
    const ctx = mount()
    expect(() => plugin.apply(ctx, plugin.Config({ fixture: '/nonexistent/session.jsonl' })))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RECORDING' }))
    expect(ctx.realtime.listProviders()).toEqual([])
  })

  it('withdraws its route when the contributing fiber is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const service = new RealtimeRuntime(ctx)
    plugin.apply(ctx, plugin.Config({ fixture: FIXTURE }))
    expect(service.listProviders()).toHaveLength(1)
    await ctx.fiber.dispose()
    expect(service.listProviders()).toEqual([])
  })
})
