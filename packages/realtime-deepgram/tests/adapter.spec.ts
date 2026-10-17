import { describe, expect, it } from 'vitest'
import { REALTIME_ERROR_CODES, RealtimeError } from 'dsh-realtime'
import type { RealtimeSessionOptions } from 'dsh-realtime'
import { AGENT_ENDPOINT, DeepgramAdapter } from '../src/index.ts'
import type { SocketLike } from '../src/index.ts'

type Listener = (...args: never[]) => void

class FakeSocket implements SocketLike {
  readonly sent: (string | Uint8Array)[] = []
  readonly headers: Readonly<Record<string, string>>
  closes = 0
  private readonly listeners = new Map<string, Listener[]>()

  constructor(headers: Readonly<Record<string, string>>) { this.headers = headers }
  send(data: string | Uint8Array): void { this.sent.push(data) }
  close(): void { this.closes += 1 }
  on(event: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }
  emit(event: 'open' | 'message' | 'close' | 'error', ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args)
  }
}

const config = (over: Partial<ConstructorParameters<typeof DeepgramAdapter>[0]> = {}) => ({
  apiKey: 'test-key',
  think: { model: 'gpt-4o-mini', prompt: 'You are a probe.' },
  ...over,
})

const request = (over: Partial<RealtimeSessionOptions> = {}): RealtimeSessionOptions =>
  ({ provider: 'deepgram', ...over }) as RealtimeSessionOptions

/** A socket factory that records what it was asked for. */
function factory(): { open: (url: string, headers: Readonly<Record<string, string>>) => SocketLike; sockets: FakeSocket[]; urls: string[] } {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  return {
    sockets,
    urls,
    open: (url, headers) => { urls.push(url); const socket = new FakeSocket(headers); sockets.push(socket); return socket },
  }
}

describe('DeepgramAdapter', () => {
  it('describes its route with the declared capabilities attached', () => {
    // The capabilities travel with the route, so a caller can read what this provider cannot do before it opens
    // anything — which is the entire point of declaring them.
    const info = new DeepgramAdapter(config(), factory().open).providerInfo('deepgram')
    expect(info.id).toBe('deepgram')
    expect(info.capabilities?.appendThinking).toBe(false)
    expect(info.capabilities?.promptUpdate).toBe('unknown')
  })

  it('advertises listening models, and treats the list as advisory', async () => {
    const models = await new DeepgramAdapter(config(), factory().open).listModels()
    expect(models.map(model => model.id)).toContain('flux-general-en')
  })

  it('refuses to open without a credential, naming the setting rather than the secret', async () => {
    // No `apiKey` key at all: `exactOptionalPropertyTypes` (rightly) refuses an explicit undefined, and an absent
    // credential is a different thing from an empty one.
    const adapter = new DeepgramAdapter({ think: { model: 'gpt-4o-mini', prompt: 'You are a probe.' } }, factory().open)
    await expect(adapter.session(request())).rejects.toMatchObject({ code: REALTIME_ERROR_CODES.MISSING_CREDENTIAL })
    await expect(adapter.session(request())).rejects.toThrow(/DEEPGRAM_API_KEY/)
  })

  it('refuses to open on an already-aborted request', async () => {
    const adapter = new DeepgramAdapter(config(), factory().open)
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.session({ ...request(), signal: controller.signal } as RealtimeSessionOptions))
      .rejects.toMatchObject({ code: REALTIME_ERROR_CODES.NETWORK })
  })

  it('opens the socket with the token header and sends Settings', async () => {
    const sockets = factory()
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    // A real socket is CONNECTING here; frames are held until `open`.
    sockets.sockets[0]?.emit('open')
    expect(sockets.urls[0]).toBe(AGENT_ENDPOINT)
    expect(sockets.sockets[0]?.headers).toEqual({ Authorization: 'Token test-key' })
    // The transport serialises before writing, so what reaches the socket is the JSON frame itself.
    expect(JSON.parse(String(sockets.sockets[0]?.sent[0]))).toMatchObject({ type: 'Settings' })
    sockets.sockets[0]?.emit('message', '{"type":"SettingsApplied"}')
    await expect(pending).resolves.toBeDefined()
    await pending.then(session => session.close())
  })

  it('does not resolve on Welcome alone, because this provider welcomes before it validates', async () => {
    // The probe connected, was welcomed, and then had its settings refused. Resolving on Welcome would hand out a
    // session that looks alive and produces nothing.
    const sockets = factory()
    const adapter = new DeepgramAdapter(config({ establishTimeoutMs: 20 }), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    sockets.sockets[0]?.emit('message', '{"type":"Welcome"}')
    await expect(pending).rejects.toMatchObject({ code: REALTIME_ERROR_CODES.PROVIDER_TIMEOUT })
  })

  it('fails on a provider Error frame, with the provider\'s own description', async () => {
    const sockets = factory()
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    sockets.sockets[0]?.emit('message', '{"type":"Error","description":"Check the agent.listen.provider.type field"}')
    await expect(pending).rejects.toThrow(/agent.listen.provider.type/)
  })

  it('fails when the socket closes before the settings apply', async () => {
    const sockets = factory()
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    sockets.sockets[0]?.emit('close', 'going away')
    await expect(pending).rejects.toThrow(/before it was established: going away/)
  })

  it('reports a close with no reason without a dangling colon', async () => {
    const sockets = factory()
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    sockets.sockets[0]?.emit('close')
    await expect(pending).rejects.toThrow(/established$/)
  })

  it('forwards output audio to the handler, because the socket delivers it as bytes', async () => {
    const sockets = factory()
    const received: Uint8Array[] = []
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request({ handlers: { onAudio: bytes => { received.push(bytes) } } }))
    await Promise.resolve()
    sockets.sockets[0]?.emit('message', new Uint8Array([1, 2]), true)
    sockets.sockets[0]?.emit('message', '{"type":"SettingsApplied"}')
    await pending
    expect(received).toHaveLength(1)
  })

  it('reports a transport error to the handler and fails the establishment', async () => {
    const sockets = factory()
    const errors: Error[] = []
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request({ handlers: { onError: error => { errors.push(error) } } }))
    await Promise.resolve()
    sockets.sockets[0]?.emit('error', new Error('socket died'))
    await expect(pending).rejects.toThrow('socket died')
    expect(errors[0]?.message).toBe('socket died')
  })

  it('routes a transcript to the caller\'s handler through the session', async () => {
    const sockets = factory()
    const transcripts: unknown[] = []
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request({ handlers: { onTranscript: transcript => { transcripts.push(transcript) } } }))
    await Promise.resolve()
    sockets.sockets[0]?.emit('message', '{"type":"SettingsApplied"}')
    const session = await pending
    sockets.sockets[0]?.emit('message', '{"type":"ConversationText","role":"user","content":"hello"}')
    expect(transcripts).toEqual([{ kind: 'input', text: 'hello', final: true }])
    await session.close()
  })

  it('carries configured listen and speak models into the Settings frame', async () => {
    const sockets = factory()
    const adapter = new DeepgramAdapter(
      config({ listen: { model: 'nova-3' }, speak: { model: 'aura-2-orpheus-en' } }),
      sockets.open,
    )
    const pending = adapter.session(request())
    await Promise.resolve()
    sockets.sockets[0]?.emit('open')
    const settings = JSON.parse(String(sockets.sockets[0]?.sent[0]))
    expect(settings.agent.listen.provider).toEqual({ type: 'deepgram', model: 'nova-3', version: 'v1' })
    expect(settings.agent.speak.provider.model).toBe('aura-2-orpheus-en')
    sockets.sockets[0]?.emit('message', '{"type":"SettingsApplied"}')
    await pending
  })

  it('names a rejected settings frame that carries no description', async () => {
    const sockets = factory()
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    sockets.sockets[0]?.emit('message', '{"type":"Error"}')
    await expect(pending).rejects.toThrow('the provider rejected the session settings')
  })

  it('passes a transport error through unchanged when it is already coded', async () => {
    // A coded error must not be re-wrapped: the code is the part a caller branches on.
    const sockets = factory()
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    sockets.sockets[0]?.emit('error', new RealtimeError('throttled', REALTIME_ERROR_CODES.RATE_LIMITED))
    await expect(pending).rejects.toMatchObject({ code: REALTIME_ERROR_CODES.RATE_LIMITED })
  })

  it('opens a session without handlers at all, for a caller that only wants the handle', async () => {
    const sockets = factory()
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    sockets.sockets[0]?.emit('message', '{"type":"SettingsApplied"}')
    const session = await pending
    expect(session.started.provider).toBe('deepgram')
    await session.close()
  })

  it('honours a configured endpoint, so a fixture or proxy can be pointed at', async () => {
    const sockets = factory()
    const adapter = new DeepgramAdapter(config({ endpoint: 'wss://fixture.invalid/agent' }), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    expect(sockets.urls[0]).toBe('wss://fixture.invalid/agent')
    sockets.sockets[0]?.emit('message', '{"type":"SettingsApplied"}')
    await pending
  })

  it('surfaces a rejected Settings as a coded provider error, not a hang', async () => {
    const sockets = factory()
    const adapter = new DeepgramAdapter(config(), sockets.open)
    const pending = adapter.session(request())
    await Promise.resolve()
    sockets.sockets[0]?.emit('message', 'not json at all')
    await expect(pending).rejects.toBeInstanceOf(RealtimeError)
  })
})
