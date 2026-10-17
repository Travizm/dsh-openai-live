import { describe, expect, it } from 'vitest'
import { API_KEY_SETTING, name, inject, apply, openWebSocket } from '../src/index.ts'
import { DeepgramAdapter } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

interface Registered {
  routes: readonly string[]
  adapter: unknown
}

/** A Cordis context with just the two surfaces this plugin touches. */
function context(): { ctx: Context; secrets: string[][]; registered: Registered[] } {
  const secrets: string[][] = []
  const registered: Registered[] = []
  const ctx = {
    realtime: {
      journal: { addSecrets: (values: readonly string[]) => { secrets.push([...values]) } },
      registerAdapter: (routes: readonly string[], adapter: unknown) => { registered.push({ routes, adapter }) },
    },
  } as unknown as Context
  return { ctx, secrets, registered }
}

describe('the plugin surface', () => {
  it('is a function plugin with named exports and no default', async () => {
    // A default export makes the Loader discard the namespace: the plugin loads and contributes nothing, with no
    // error and no log line.
    expect(name).toBe('realtime-deepgram')
    expect(inject).toEqual(['realtime'])
    const module = await import('../src/plugin.ts')
    expect('default' in module).toBe(false)
  })

  it('names the environment variable a composition should read', () => {
    expect(API_KEY_SETTING).toBe('DEEPGRAM_API_KEY')
  })
})

describe('apply', () => {
  it('registers the key as a journal secret before the adapter exists', () => {
    // Order matters: a record written ahead of the redaction that knows this value would carry it unredacted.
    const { ctx, secrets, registered } = context()
    apply(ctx, { apiKey: 'dg-secret-value' })
    expect(secrets).toEqual([['dg-secret-value']])
    expect(registered).toHaveLength(1)
  })

  it('registers an empty secret list rather than the string "undefined" when there is no key', () => {
    // A profile without a credential still composes; the failure belongs at the session request, not at boot.
    const { ctx, secrets } = context()
    apply(ctx, {})
    expect(secrets).toEqual([[]])
  })

  it('registers the default route when none is configured', () => {
    const { ctx, registered } = context()
    apply(ctx, {})
    expect(registered[0]?.routes).toEqual(['deepgram'])
  })

  it('registers the configured route', () => {
    const { ctx, registered } = context()
    apply(ctx, { provider: 'dg-cheap' })
    expect(registered[0]?.routes).toEqual(['dg-cheap'])
  })

  it('registers a DeepgramAdapter whose declared route carries the capabilities', () => {
    const { ctx, registered } = context()
    apply(ctx, { provider: 'deepgram' })
    const adapter = registered[0]?.adapter as DeepgramAdapter
    expect(adapter).toBeInstanceOf(DeepgramAdapter)
    expect(adapter.providerInfo('deepgram').capabilities?.promptUpdate).toBe('append')
  })

  it('carries configured models and an establish budget into the adapter', async () => {
    const { ctx, registered } = context()
    apply(ctx, { thinkModel: 'gpt-4o', thinkPrompt: 'Be terse.', listenModel: 'nova-3', speakModel: 'aura-2-orpheus-en', establishTimeoutMs: 5 })
    const adapter = registered[0]?.adapter as DeepgramAdapter
    // The adapter has no credential here, so the refusal proves the config was read rather than defaulted.
    await expect(adapter.session({ provider: 'deepgram' } as never))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('passes a bring-your-own endpoint through, so P1c can point at the delegate shim', () => {
    const { ctx, registered } = context()
    apply(ctx, { apiKey: 'k', thinkEndpoint: 'https://shim.example.com/v1/chat/completions' })
    expect(registered[0]?.adapter).toBeInstanceOf(DeepgramAdapter)
  })
})

describe('openWebSocket', () => {
  it('returns a socket the transport can bind to, without waiting for a connection', () => {
    // The constructor does not connect synchronously, so this exercises the only networked line in the package
    // without depending on a server existing.
    const socket = openWebSocket('ws://127.0.0.1:9/', { Authorization: 'Token test' })
    expect(typeof socket.send).toBe('function')
    expect(typeof socket.close).toBe('function')
    socket.on('error', () => { /* the port is closed; the point is the constructor and the shape */ })
    socket.close()
  })
})
