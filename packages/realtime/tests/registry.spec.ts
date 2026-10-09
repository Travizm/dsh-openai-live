import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RealtimeRuntime, { RealtimeAdapter, RealtimeError } from '../src/index.ts'
import type { RealtimeSession, RealtimeSessionOptions } from '../src/types.ts'

/**
 * Unit idiom, matching the harness's own service specs: construct the service directly on a bare
 * context, so registry behaviour needs no Agent stack. The service registers itself through
 * `ctx.reflect.provide()` in its constructor and is withdrawn with the owning fiber.
 */
const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function mount(): { ctx: Context; service: RealtimeRuntime } {
  const ctx = new Context()
  contexts.push(ctx)
  return { ctx, service: new RealtimeRuntime(ctx) }
}

describe('the journal the seam owns', () => {
  it('records and serves through the same instance a plugin holds', () => {
    const { service } = mount()
    const recorded = service.journal.record('session.opened', { provider: 'openai-live' })

    expect(recorded.kind).toBe('session.opened')
    expect(service.journal.snapshot()).toEqual([recorded])
  })

  it('gives each service its own journal, so two bundles cannot interleave one record', () => {
    const first = mount().service
    const second = mount().service
    first.journal.record('session.opened', {})

    expect(first.journal.size).toBe(1)
    expect(second.journal.size).toBe(0)
  })
})

/** Minimal adapter whose only job is to exist; the registry never calls `session` in these specs. */
class StubAdapter extends RealtimeAdapter {
  override async session(_options: RealtimeSessionOptions): Promise<RealtimeSession> {
    throw new Error('not used')
  }
}

/** An adapter reporting a malformed provider id, to prove metadata validation is not cosmetic. */
class BadMetaAdapter extends RealtimeAdapter {
  override providerInfo(provider: string) {
    return { id: `${provider}-mismatch`, name: 'bad' }
  }
  override async session(_options: RealtimeSessionOptions): Promise<RealtimeSession> {
    throw new Error('not used')
  }
}

const ids = (service: RealtimeRuntime) => service.listProviders().map(provider => provider.id)

describe('RealtimeRuntime registration', () => {
  it('registers routes and lists their provider metadata', () => {
    const { service } = mount()
    service.registerAdapter(['openai-live'], new StubAdapter())
    expect(service.listProviders()).toEqual([{ id: 'openai-live', name: 'openai-live' }])
  })

  it('refuses an empty route set', () => {
    const { service } = mount()
    expect(() => service.registerAdapter([], new StubAdapter()))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PROVIDER' }))
  })

  it('refuses an empty route name', () => {
    const { service } = mount()
    expect(() => service.registerAdapter([''], new StubAdapter()))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PROVIDER' }))
  })

  it('refuses a route another registration holds, and registers nothing from that batch', () => {
    const { service } = mount()
    service.registerAdapter(['openai-live'], new StubAdapter())
    expect(() => service.registerAdapter(['new-route', 'openai-live'], new StubAdapter()))
      .toThrowError(expect.objectContaining({ code: 'DUPLICATE_PROVIDER' }))
    // All-or-nothing: the valid sibling in the rejected batch must not have landed.
    expect(ids(service)).toEqual(['openai-live'])
  })

  it('refuses a route whose adapter metadata does not preserve the id', () => {
    const { service } = mount()
    expect(() => service.registerAdapter(['openai-live'], new BadMetaAdapter()))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PROVIDER' }))
    expect(service.listProviders()).toEqual([])
  })

  it('releases every route when its registration is disposed', () => {
    const { service } = mount()
    const dispose = service.registerAdapter(['a', 'b'], new StubAdapter())
    expect(ids(service)).toEqual(['a', 'b'])
    dispose()
    expect(service.listProviders()).toEqual([])
  })

  it('replaces routes atomically, and refuses once disposed', () => {
    const { service } = mount()
    const handle = service.registerAdapter(['a'], new StubAdapter())
    handle.replace(['a', 'b'])
    expect(ids(service)).toEqual(['a', 'b'])
    // `replace([])` is legal on a live registration: it keeps its identity and holds no routes.
    handle.replace([])
    expect(service.listProviders()).toEqual([])
    handle()
    expect(() => handle.replace(['a']))
      .toThrowError(expect.objectContaining({ code: 'REGISTRATION_DISPOSED' }))
  })

  it('leaves the registry untouched when a replacement candidate is rejected', () => {
    const { service } = mount()
    service.registerAdapter(['taken'], new StubAdapter())
    const handle = service.registerAdapter(['mine'], new StubAdapter())
    expect(() => handle.replace(['mine', 'taken']))
      .toThrowError(expect.objectContaining({ code: 'DUPLICATE_PROVIDER' }))
    expect(ids(service)).toEqual(['taken', 'mine'])
  })
})

describe('RealtimeRuntime HMR safety', () => {
  it('withdraws routes contributed by a child fiber when that fiber is disposed', async () => {
    const { ctx, service } = mount()
    // Contribute from a child fiber, exactly as a real adapter plugin would.
    const contributor = {
      name: 'test-adapter',
      apply(child: Context) {
        child.realtime.registerAdapter(['openai-live'], new StubAdapter())
      },
    }
    const fiber = await ctx.plugin(contributor)
    expect(ids(service)).toEqual(['openai-live'])
    // Dispose the *contributing* fiber: its effect disposer must run and withdraw the routes.
    await fiber.dispose()
    expect(service.listProviders()).toEqual([])
  })

  it('withdraws routes when the owning fiber is disposed', async () => {
    const { ctx, service } = mount()
    service.registerAdapter(['a'], new StubAdapter())
    expect(ids(service)).toEqual(['a'])
    await ctx.fiber.dispose()
    expect(service.listProviders()).toEqual([])
  })
})

describe('RealtimeRuntime session dispatch', () => {
  it('refuses an unregistered route rather than returning a dead session', async () => {
    const { service } = mount()
    await expect(service.session({ provider: 'nope', model: 'gpt-live-1' }))
      .rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })

  it('routes the request to the owning adapter exactly once', async () => {
    const { service } = mount()
    const seen: RealtimeSessionOptions[] = []
    class Recording extends RealtimeAdapter {
      override async session(options: RealtimeSessionOptions): Promise<RealtimeSession> {
        seen.push(options)
        throw new RealtimeError('stop here', 'SESSION_CLOSED')
      }
    }
    service.registerAdapter(['openai-live'], new Recording())
    await expect(service.session({ provider: 'openai-live', model: 'gpt-live-1' }))
      .rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.model).toBe('gpt-live-1')
  })

  it('rejects a request it cannot honor instead of forwarding a no-op', async () => {
    const { service } = mount()
    const adapter = new StubAdapter()
    const spy = vi.spyOn(adapter, 'session')
    service.registerAdapter(['openai-live'], adapter)
    await expect(service.session({ provider: 'openai-live', model: 'gpt-live-1', instructions: '' }))
      .rejects.toMatchObject({ code: 'INVALID_APPEND' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses a session whose signal already aborted', async () => {
    const { service } = mount()
    service.registerAdapter(['openai-live'], new StubAdapter())
    await expect(service.session({
      provider: 'openai-live',
      model: 'gpt-live-1',
      signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })

  it('rejects an empty provider or model before reaching an adapter', async () => {
    const { service } = mount()
    await expect(service.session({ provider: '', model: 'gpt-live-1' }))
      .rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
    await expect(service.session({ provider: 'openai-live', model: '' }))
      .rejects.toMatchObject({ code: 'INVALID_PROVIDER' })
  })
})

describe('model catalogue', () => {
  it('detaches model metadata and drops duplicate ids', async () => {
    const { service } = mount()
    class Catalogued extends RealtimeAdapter {
      override async session(_options: RealtimeSessionOptions): Promise<RealtimeSession> {
        throw new Error('not used')
      }
      override async listModels() {
        return [
          { id: 'gpt-live-1', name: 'GPT Live 1', inputModalities: ['audio' as const], outputModalities: ['audio', 'text'] as const },
          { id: 'gpt-live-1', name: 'duplicate' },
          { id: '', name: 'nameless' },
        ]
      }
    }
    service.registerAdapter(['openai-live'], new Catalogued())
    expect(await service.listModels('openai-live')).toEqual([
      { id: 'gpt-live-1', name: 'GPT Live 1', inputModalities: ['audio'], outputModalities: ['audio', 'text'] },
    ])
  })

  it('returns an empty catalogue when an adapter declares none', async () => {
    // The base-class default. Advisory by design: an adapter that advertises nothing must still be
    // routable, because absence from a catalogue is never a reason to reject a request.
    const { service } = mount()
    service.registerAdapter(['openai-live'], new StubAdapter())
    expect(await service.listModels('openai-live')).toEqual([])
  })

  it('falls back to the model id when an adapter omits or blanks a name', async () => {
    const { service } = mount()
    class Nameless extends RealtimeAdapter {
      override async session(_options: RealtimeSessionOptions): Promise<RealtimeSession> {
        throw new Error('not used')
      }
      override async listModels() {
        return [{ id: 'gpt-live-1', name: '' }, { id: 'gpt-live-2' } as { id: string; name: string }]
      }
    }
    service.registerAdapter(['openai-live'], new Nameless())
    expect(await service.listModels('openai-live')).toEqual([
      { id: 'gpt-live-1', name: 'gpt-live-1' },
      { id: 'gpt-live-2', name: 'gpt-live-2' },
    ])
  })

  it('carries an adapter-declared provider description through to the registry', async () => {
    const { service } = mount()
    class Described extends RealtimeAdapter {
      override providerInfo(provider: string) {
        return { id: provider, name: 'OpenAI Live', description: 'GPT-Live-1 full-duplex voice' }
      }
      override async session(_options: RealtimeSessionOptions): Promise<RealtimeSession> {
        throw new Error('not used')
      }
    }
    service.registerAdapter(['openai-live'], new Described())
    expect(service.listProviders()).toEqual([
      { id: 'openai-live', name: 'OpenAI Live', description: 'GPT-Live-1 full-duplex voice' },
    ])
  })
})

describe('append bounds', () => {
  it('accepts content at the bound and rejects one character past it', () => {
    expect(RealtimeRuntime.assertAppendable('ok', 2)).toBe('ok')
    expect(() => RealtimeRuntime.assertAppendable('abc', 2))
      .toThrowError(expect.objectContaining({ code: 'INVALID_APPEND' }))
  })

  it('rejects empty and non-string content', () => {
    expect(() => RealtimeRuntime.assertAppendable('', 10))
      .toThrowError(expect.objectContaining({ code: 'INVALID_APPEND' }))
    expect(() => RealtimeRuntime.assertAppendable(undefined as unknown as string, 10))
      .toThrowError(expect.objectContaining({ code: 'INVALID_APPEND' }))
  })

  it('counts characters, so a multibyte value is bounded by its character length', () => {
    expect(RealtimeRuntime.assertAppendable('éé', 2)).toBe('éé')
  })
})

describe('RealtimeError', () => {
  it('carries a stable code and a conventional name', () => {
    const error = new RealtimeError('boom', 'NO_ADAPTER')
    expect(error.code).toBe('NO_ADAPTER')
    expect(error.name).toBe('RealtimeError')
    expect(error).toBeInstanceOf(Error)
  })

  it('refuses to be constructed without a message or a code', () => {
    expect(() => new RealtimeError('', 'NO_ADAPTER')).toThrowError(TypeError)
    expect(() => new RealtimeError('boom', '' as never)).toThrowError(TypeError)
  })
})
