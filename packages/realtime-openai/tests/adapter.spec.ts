import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type { RealtimeSessionHandlers, RealtimeSessionStarted } from 'dsh-realtime'
import { OpenAiLiveAdapter, resolveApiKey } from '../src/adapter.ts'
import { OpenAiLiveSession } from '../src/session.ts'
import type {
  OpenAiLiveConfig,
  RealtimeTransport,
  RealtimeTransportFactory,
  RealtimeTransportHandlers,
} from '../src/types.ts'

/** A transport the test drives by hand: everything sent is recorded, nothing leaves the process. */
class FakeTransport implements RealtimeTransport {
  readonly sent: string[] = []
  closed = false

  constructor(private readonly handlers: RealtimeTransportHandlers) {}

  send(frame: string): void {
    this.sent.push(frame)
  }

  close(): void {
    this.closed = true
  }

  /** Deliver one server frame. */
  deliver(event: Record<string, unknown> | string): void {
    this.handlers.onMessage(typeof event === 'string' ? event : JSON.stringify(event))
  }

  /** Simulate the transport closing. */
  drop(code = 1006, reason = ''): void {
    this.handlers.onClose(code, reason)
  }

  /** Simulate a transport-level failure. */
  fail(error = new Error('transport blew up')): void {
    this.handlers.onError(error)
  }

  /** The frames sent, parsed. */
  parsed(): Array<Record<string, unknown>> {
    return this.sent.map(frame => JSON.parse(frame) as Record<string, unknown>)
  }
}

/** Hands the test the transport it created, so frames can be injected. */
class FakeFactory implements RealtimeTransportFactory {
  transport?: FakeTransport
  readonly urls: string[] = []
  readonly headers: Array<Record<string, string>> = []
  refuse?: Error

  async connect(
    url: string,
    headers: Readonly<Record<string, string>>,
    handlers: RealtimeTransportHandlers,
  ): Promise<RealtimeTransport> {
    if (this.refuse !== undefined) throw this.refuse
    this.urls.push(url)
    this.headers.push({ ...headers })
    this.transport = new FakeTransport(handlers)
    return this.transport
  }
}

/** A key that is obviously not a credential, so a leaked value would be visible in a failure. */
const KEY = 'test-key-not-a-real-credential'

function config(overrides: Partial<OpenAiLiveConfig> = {}): OpenAiLiveConfig {
  return {
    apiKey: KEY,
    baseURL: 'wss://example.test/v1/live/sessions',
    provider: 'openai-live',
    model: 'gpt-live-1',
    voice: 'marin',
    appendAckTimeoutMs: 50,
    establishTimeoutMs: 50,
    ...overrides,
  }
}

/**
 * A configuration with the credential **absent**.
 *
 * Built by deletion rather than by assigning `undefined`: `exactOptionalPropertyTypes` distinguishes
 * the two, and "the setting is not there" is the case the seam must refuse.
 */
function configWithoutKey(): OpenAiLiveConfig {
  const keyless = config()
  delete (keyless as { apiKey?: string }).apiKey
  return keyless
}

/** Let the adapter's async connect settle. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const STARTED_EVENT = {
  type: 'session.started',
  session: { model: 'gpt-live-1', audio: { output: { voice: 'marin' } } },
}

const STARTED_FACTS: RealtimeSessionStarted = {
  provider: 'openai-live',
  model: 'gpt-live-1',
  voice: 'marin',
  inputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
  outputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
}

/** Start a session attempt and hand back the fake transport it created. */
async function openSession(
  overrides: Partial<OpenAiLiveConfig> = {},
  handlers: RealtimeSessionHandlers = {},
): Promise<{ factory: FakeFactory; transport: FakeTransport; pending: ReturnType<OpenAiLiveAdapter['session']> }> {
  const factory = new FakeFactory()
  const adapter = new OpenAiLiveAdapter(config(overrides), factory)
  const pending = adapter.session({ provider: 'openai-live', model: 'gpt-live-1', handlers })
  await tick()
  const transport = factory.transport
  if (transport === undefined) throw new Error('no transport was created')
  return { factory, transport, pending }
}

describe('resolveApiKey', () => {
  it('names the setting and never any part of the value', () => {
    const failure = (() => {
      try {
        resolveApiKey(configWithoutKey())
        return undefined
      } catch (error: unknown) {
        return error as { code?: string; message?: string }
      }
    })()
    expect(failure?.code).toBe('MISSING_CREDENTIAL')
    expect(failure?.message).toContain('apiKey')
    expect(failure?.message).not.toContain(KEY)
  })

  it('refuses a blank or whitespace-only key', () => {
    expect(() => resolveApiKey(config({ apiKey: '' }))).toThrowError(expect.objectContaining({ code: 'MISSING_CREDENTIAL' }))
    expect(() => resolveApiKey(config({ apiKey: '   ' }))).toThrowError(expect.objectContaining({ code: 'MISSING_CREDENTIAL' }))
  })

  it('trims a key that arrived with whitespace', () => {
    expect(resolveApiKey(config({ apiKey: `  ${KEY}  ` }))).toBe(KEY)
  })
})

describe('OpenAiLiveAdapter metadata', () => {
  it('describes its route without special-casing it in the seam', () => {
    const adapter = new OpenAiLiveAdapter(config(), new FakeFactory())
    expect(adapter.providerInfo('openai-live')).toEqual({
      id: 'openai-live',
      name: 'OpenAI Live',
      description: 'GPT-Live-1 full-duplex voice with client delegation',
    })
  })

  it('advertises the configured model as advisory metadata', async () => {
    const adapter = new OpenAiLiveAdapter(config(), new FakeFactory())
    expect(await adapter.listModels()).toEqual([{
      id: 'gpt-live-1',
      name: 'gpt-live-1',
      inputModalities: ['audio', 'text'],
      outputModalities: ['audio', 'text'],
    }])
  })
})

describe('handshake', () => {
  it('refuses before opening a socket when no credential is configured', async () => {
    const factory = new FakeFactory()
    const adapter = new OpenAiLiveAdapter(configWithoutKey(), factory)
    await expect(adapter.session({ provider: 'openai-live', model: 'gpt-live-1' }))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(factory.transport).toBeUndefined()
  })

  it('sends the bearer header, the endpoint, and a client-delegation session.start', async () => {
    const { factory, transport, pending } = await openSession()
    expect(factory.urls).toEqual(['wss://example.test/v1/live/sessions'])
    expect(factory.headers[0]).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(transport.parsed()[0]).toEqual({
      type: 'session.start',
      session: {
        model: 'gpt-live-1',
        audio: { output: { voice: 'marin' } },
        delegation: { type: 'client' },
      },
    })
    // Settle the attempt. A test that starts an async operation owns it through teardown: leaving the
    // establishment timer to fire into an unawaited promise reports an unhandled rejection instead.
    transport.deliver(STARTED_EVENT)
    await pending
  })

  it('omits instructions the caller never gave, rather than sending an empty field', async () => {
    // The endpoint rejects unknown fields, so an omitted instruction must be absent, not blank.
    const { transport, pending } = await openSession()
    const frame = transport.parsed()[0] as { session: Record<string, unknown> }
    expect('instructions' in frame.session).toBe(false)
    transport.deliver(STARTED_EVENT)
    await pending
  })

  it('carries instructions when the caller supplies them', async () => {
    const factory = new FakeFactory()
    const adapter = new OpenAiLiveAdapter(config(), factory)
    const pending = adapter.session({ provider: 'openai-live', model: 'gpt-live-1', instructions: 'Be brief.' })
    await tick()
    const frame = factory.transport?.parsed()[0] as { session: Record<string, unknown> }
    expect(frame.session.instructions).toBe('Be brief.')
    factory.transport?.deliver(STARTED_EVENT)
    await pending
  })

  it('falls back to the configured model when the caller names none', async () => {
    // The seam rejects an empty model before reaching an adapter; this covers a direct caller.
    const factory = new FakeFactory()
    const adapter = new OpenAiLiveAdapter(config(), factory)
    const pending = adapter.session({ provider: 'openai-live', model: '' })
    await tick()
    const frame = factory.transport?.parsed()[0] as { session: { model: string } }
    expect(frame.session.model).toBe('gpt-live-1')
    factory.transport?.deliver(STARTED_EVENT)
    await pending
  })

  it('names the failure generically when a provider error carries no message', async () => {
    const { transport, pending } = await openSession()
    transport.deliver({ type: 'error', error: {} })
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('omits the reason when the transport closes with none before establishment', async () => {
    const { transport, pending } = await openSession()
    transport.drop(1006, '')
    await expect(pending).rejects.toThrow('established (1006)')
  })

  it('resolves with the facts the provider accepted', async () => {
    const { transport, pending } = await openSession()
    transport.deliver(STARTED_EVENT)
    expect((await pending).started).toEqual(STARTED_FACTS)
  })

  it('reports the provider-accepted voice rather than the requested one', async () => {
    const { transport, pending } = await openSession()
    transport.deliver({ type: 'session.started', session: { model: 'gpt-live-1', audio: { output: { voice: 'verse' } } } })
    expect((await pending).started.voice).toBe('verse')
  })

  it('omits the voice when neither side names one', async () => {
    const { transport, pending } = await openSession({ voice: '' })
    transport.deliver({ type: 'session.started', session: { model: 'gpt-live-1' } })
    expect('voice' in (await pending).started).toBe(false)
  })

  it('honours an explicitly requested voice over the configured default', async () => {
    const factory = new FakeFactory()
    const adapter = new OpenAiLiveAdapter(config(), factory)
    const pending = adapter.session({ provider: 'openai-live', model: 'gpt-live-1', voice: 'coral' })
    await tick()
    const first = factory.transport?.parsed()[0] as { session: { audio: unknown } }
    expect(first.session.audio).toEqual({ output: { voice: 'coral' } })
    factory.transport?.deliver(STARTED_EVENT)
    await pending
  })

  it('replays frames that arrived before the session object existed', async () => {
    // Establishment and the first deltas can share one tick; dropping them would silently lose speech.
    const seen: string[] = []
    const { transport, pending } = await openSession({}, { onTranscript: t => seen.push(t.text) })
    transport.deliver({ type: 'session.input_transcript.delta', delta: 'early' })
    transport.deliver(STARTED_EVENT)
    await pending
    expect(seen).toEqual(['early'])
  })

  it('rejects with the provider error and leaves no socket behind', async () => {
    const { transport, pending } = await openSession()
    transport.deliver({ type: 'error', error: { code: 'invalid_value', message: 'bad shape' } })
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(transport.closed).toBe(true)
  })

  it('rejects when the transport closes before the session is established', async () => {
    const { transport, pending } = await openSession()
    transport.drop(1006, 'going away')
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('rejects when the transport fails before the session is established', async () => {
    const { transport, pending } = await openSession()
    transport.fail()
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('rejects when the provider never confirms, rather than hanging an open socket', async () => {
    const { transport, pending } = await openSession({ establishTimeoutMs: 5 })
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(transport.sent).toHaveLength(1)
  })

  it('propagates a transport that refuses to connect', async () => {
    const factory = new FakeFactory()
    factory.refuse = new Error('ECONNREFUSED')
    const adapter = new OpenAiLiveAdapter(config(), factory)
    await expect(adapter.session({ provider: 'openai-live', model: 'gpt-live-1' })).rejects.toThrow('ECONNREFUSED')
  })

  it('ignores an unparseable frame while waiting, then still establishes', async () => {
    const { transport, pending } = await openSession()
    transport.deliver('not json at all')
    transport.deliver(STARTED_EVENT)
    await expect(pending).resolves.toBeDefined()
  })

  it('hands a post-establishment transport close to the session, with its reason', async () => {
    // The transport-loss path after establishment is different from the one before it: a caller now
    // holds a session, so the loss is a session event rather than a rejected request.
    const reasons: Array<string | undefined> = []
    const { transport, pending } = await openSession({}, { onClosed: r => reasons.push(r) })
    transport.deliver(STARTED_EVENT)
    await pending
    transport.drop(1006, 'peer reset')
    expect(reasons).toEqual(['peer reset'])
  })

  it('names the close code when the transport supplies no reason', async () => {
    const reasons: Array<string | undefined> = []
    const { transport, pending } = await openSession({}, { onClosed: r => reasons.push(r) })
    transport.deliver(STARTED_EVENT)
    await pending
    transport.drop(1006, '')
    expect(reasons[0]).toContain('transport closed (1006)')
  })

  it('hands a post-establishment transport error to the session', async () => {
    const errors: string[] = []
    const { transport, pending } = await openSession({}, { onError: e => errors.push(e.message) })
    transport.deliver(STARTED_EVENT)
    await pending
    transport.fail(new Error('post-open failure'))
    expect(errors).toEqual(['post-open failure'])
  })

  it('routes frames that arrive after establishment to the session, not the buffer', async () => {
    const seen: string[] = []
    const { transport, pending } = await openSession({}, { onTranscript: t => seen.push(t.text) })
    transport.deliver(STARTED_EVENT)
    await pending
    transport.deliver({ type: 'session.input_transcript.delta', delta: 'after' })
    expect(seen).toEqual(['after'])
  })
})

/**
 * Build a session directly, for behaviour that does not involve the handshake.
 *
 * The transport is wired to the session exactly as the adapter wires it — a helper with inert
 * handlers would let a test deliver frames into nothing and read as a session bug.
 */
function liveSession(handlers: RealtimeSessionHandlers = {}, appendAckTimeoutMs = 50) {
  const holder: { session?: OpenAiLiveSession } = {}
  const transport = new FakeTransport({
    onMessage: (frame: string) => holder.session?.handleFrame(frame),
    onClose: (code: number, reason: string) => holder.session?.handleTransportClose(reason.length > 0 ? reason : `closed (${code})`),
    onError: (error: Error) => holder.session?.handleTransportError(error),
  })
  const session = new OpenAiLiveSession({
    transport,
    started: STARTED_FACTS,
    id: 'sess_test',
    handlers,
    appendAckTimeoutMs,
  })
  holder.session = session
  return { transport, session }
}

describe('session input', () => {
  it('encodes microphone audio as base64 under the verified field name', () => {
    const { transport, session } = liveSession()
    session.sendAudio(new Uint8Array([1, 2, 3]))
    expect(transport.parsed()[0]).toEqual({ type: 'session.input_audio.append', audio: 'AQID' })
  })

  it('mutes and unmutes without ending the session', () => {
    const { transport, session } = liveSession()
    session.muteInput()
    session.unmuteInput()
    expect(transport.parsed().map(frame => frame.type))
      .toEqual(['session.input_audio.mute', 'session.input_audio.unmute'])
  })

  it('refuses input once the session has closed', async () => {
    const { session } = liveSession()
    await session.close()
    expect(() => session.sendAudio(new Uint8Array([1]))).toThrowError(expect.objectContaining({ code: 'SESSION_CLOSED' }))
    expect(() => session.muteInput()).toThrowError(expect.objectContaining({ code: 'SESSION_CLOSED' }))
    expect(() => session.unmuteInput()).toThrowError(expect.objectContaining({ code: 'SESSION_CLOSED' }))
  })
})

describe('the delegation path', () => {
  it('returns a result through commentary with the delegation id attached', async () => {
    const { transport, session } = liveSession()
    const pending = session.appendCommentary('staging is healthy', 'item_1')
    expect(transport.parsed()[0]).toMatchObject({
      type: 'session.commentary.append',
      content: 'staging is healthy',
      delegation_id: 'item_1',
    })
    transport.deliver({ type: 'session.commentary.appended' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('sends silent progress through thinking, and steering through instructions', async () => {
    const { transport, session } = liveSession()
    const thinking = session.appendThinking('looking it up', 'item_1')
    const instructions = session.appendInstructions('keep it short')
    expect(transport.parsed().map(frame => frame.type)).toEqual([
      'session.thinking.append',
      'session.instructions.append',
    ])
    expect(transport.parsed()[1]).toMatchObject({ delegation_id: null })
    transport.deliver({ type: 'session.thinking.appended' })
    transport.deliver({ type: 'session.instructions.appended' })
    await expect(thinking).resolves.toBeUndefined()
    await expect(instructions).resolves.toBeUndefined()
  })

  it('correlates by the echoed client id when the provider supplies one', async () => {
    const { transport, session } = liveSession()
    const first = session.appendThinking('one')
    const second = session.appendCommentary('two')
    const secondId = (transport.parsed()[1] as { event_id: string }).event_id
    // Acknowledge the *second* first, by id: the first must still be outstanding afterwards.
    transport.deliver({ type: 'session.commentary.appended', client_event_id: secondId })
    await expect(second).resolves.toBeUndefined()
    transport.deliver({ type: 'session.thinking.appended', client_event_id: 'not-a-match' })
    await expect(first).resolves.toBeUndefined()
  })

  it('falls back to the oldest outstanding append of that kind when no id is echoed', async () => {
    // The echo is not documented for the appended events, so a missing correlation must degrade to
    // FIFO rather than to a hung promise.
    const { transport, session } = liveSession()
    const first = session.appendThinking('one')
    const second = session.appendThinking('two')
    transport.deliver({ type: 'session.thinking.appended' })
    await expect(first).resolves.toBeUndefined()
    transport.deliver({ type: 'session.thinking.appended' })
    await expect(second).resolves.toBeUndefined()
  })

  it('ignores an acknowledgement that matches nothing', () => {
    const { transport } = liveSession()
    expect(() => transport.deliver({ type: 'session.commentary.appended' })).not.toThrow()
  })

  it('does not settle an append of one kind with an acknowledgement of another', async () => {
    // Kinds are not interchangeable: a `thinking` ack must leave a `commentary` append outstanding,
    // otherwise a provider that acknowledges out of order would silently complete the wrong promise.
    const { transport, session } = liveSession()
    const pending = session.appendCommentary('two')
    transport.deliver({ type: 'session.thinking.appended' })
    transport.deliver({ type: 'session.commentary.appended' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('treats an empty echoed client id as absent, falling back to FIFO', async () => {
    const { transport, session } = liveSession()
    const pending = session.appendThinking('one')
    transport.deliver({ type: 'session.thinking.appended', client_event_id: '' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('fails loudly when the provider never acknowledges', async () => {
    const { session } = liveSession({}, 5)
    await expect(session.appendCommentary('anything')).rejects
      .toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('refuses an append over the bound before it reaches the wire', async () => {
    const { transport, session } = liveSession()
    await expect(session.appendCommentary('x'.repeat(2001)))
      .rejects.toMatchObject({ code: 'INVALID_APPEND' })
    expect(transport.sent).toEqual([])
  })

  it('refuses an empty append', async () => {
    const { session } = liveSession()
    await expect(session.appendCommentary('')).rejects.toMatchObject({ code: 'INVALID_APPEND' })
  })

  it('refuses an append once the session has closed', async () => {
    const { session } = liveSession()
    await session.close()
    await expect(session.appendCommentary('late')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})

describe('session callbacks', () => {
  it('delivers transcripts from both sides', () => {
    const seen: Array<{ kind: string; text: string }> = []
    const { transport } = liveSession({ onTranscript: t => seen.push({ kind: t.kind, text: t.text }) })
    transport.deliver({ type: 'session.input_transcript.delta', delta: 'hi' })
    transport.deliver({ type: 'session.output_transcript.delta', delta: 'hello' })
    expect(seen).toEqual([{ kind: 'input', text: 'hi' }, { kind: 'output', text: 'hello' }])
  })

  it('decodes output audio to bytes, so no consumer sees a transport encoding', () => {
    const chunks: Uint8Array[] = []
    const { transport } = liveSession({ onAudio: pcm => chunks.push(pcm) })
    transport.deliver({ type: 'session.output_audio.delta', delta: Buffer.from([9, 8, 7]).toString('base64') })
    expect(chunks).toHaveLength(1)
    expect(Array.from(chunks[0]!)).toEqual([9, 8, 7])
  })

  it('ignores an empty or non-string audio payload', () => {
    const chunks: Uint8Array[] = []
    const { transport } = liveSession({ onAudio: pcm => chunks.push(pcm) })
    transport.deliver({ type: 'session.output_audio.delta', delta: '' })
    transport.deliver({ type: 'session.output_audio.delta', delta: 5 })
    expect(chunks).toEqual([])
  })

  it('surfaces a delegation with its target and no invented task text', () => {
    const delegations: Array<{ id: string; target: string }> = []
    const { transport } = liveSession({ onDelegation: d => delegations.push({ id: d.id, target: d.target }) })
    transport.deliver({
      type: 'session.delegation.created',
      offset_ms: 4600,
      delegation: { id: 'item_1', type: 'delegation', target: 'client' },
    })
    expect(delegations).toEqual([{ id: 'item_1', target: 'client' }])
  })

  it('reports usage in audio-seconds', () => {
    const usage: number[] = []
    const { transport } = liveSession({ onUsage: u => usage.push(u.seconds) })
    transport.deliver({ type: 'session.usage.updated', usage: { seconds: 7 } })
    expect(usage).toEqual([7])
  })

  it('ignores a known frame whose payload is unusable, without throwing', () => {
    // Each of these types IS one this adapter reads, so the frame is not filtered out — the payload
    // is simply not usable. Returning undefined is the translation layer's way of saying "ignore
    // this frame", and nothing may be surfaced or thrown.
    const seen: unknown[] = []
    const { transport } = liveSession({
      onTranscript: t => seen.push(t),
      onDelegation: d => seen.push(d),
      onUsage: u => seen.push(u),
    })
    transport.deliver({ type: 'session.input_transcript.delta', delta: 5 })
    transport.deliver({ type: 'session.delegation.created', delegation: { id: '', target: 'client' } })
    transport.deliver({ type: 'session.usage.updated', usage: { seconds: 'seven' } })
    expect(seen).toEqual([])
  })

  it('ignores frames it does not know, rather than failing the session', () => {
    const { transport, session } = liveSession()
    expect(() => transport.deliver({ type: 'session.something.new' })).not.toThrow()
    expect(() => session.handleFrame('{{{')).not.toThrow()
  })

  it('ignores a repeat of session.started on an open session', () => {
    const { transport } = liveSession()
    expect(() => transport.deliver(STARTED_EVENT)).not.toThrow()
  })
})

describe('session teardown', () => {
  it('reports the provider reason and the final usage when the provider closes', () => {
    const reasons: Array<string | undefined> = []
    const usage: number[] = []
    const { transport } = liveSession({ onClosed: r => reasons.push(r), onUsage: u => usage.push(u.seconds) })
    transport.deliver({ type: 'session.closed', reason: 'completed', usage: { seconds: 12 } })
    expect(reasons).toEqual(['completed'])
    expect(usage).toEqual([12])
  })

  it('fails an outstanding append when the provider closes', async () => {
    const { transport, session } = liveSession()
    const pending = session.appendCommentary('still waiting')
    transport.deliver({ type: 'session.closed' })
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })

  it('fails outstanding appends and reports a provider error frame', async () => {
    const errors: string[] = []
    const { transport, session } = liveSession({ onError: e => errors.push(e.message) })
    const pending = session.appendThinking('in flight')
    transport.deliver({ type: 'error', error: { code: 'invalid_value', message: 'bad' } })
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(errors).toHaveLength(1)
  })

  it('reports a post-establishment transport close and a transport error', () => {
    const reasons: Array<string | undefined> = []
    const errors: string[] = []
    const { session } = liveSession({ onClosed: r => reasons.push(r), onError: e => errors.push(e.message) })
    session.handleTransportError(new Error('socket died'))
    session.handleTransportClose('peer reset')
    expect(errors).toEqual(['socket died'])
    expect(reasons).toEqual(['peer reset'])
  })

  it('closes idempotently: one close frame, one close callback', async () => {
    const closed = vi.fn()
    const { transport, session } = liveSession({ onClosed: closed })
    await session.close()
    await session.close()
    expect(transport.sent.filter(frame => frame.includes('session.close'))).toHaveLength(1)
    expect(transport.closed).toBe(true)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('notifies the consumer when the transport closes without a provider reason', () => {
    const reasons: Array<string | undefined> = []
    const { session } = liveSession({ onClosed: r => reasons.push(r) })
    session.handleTransportClose()
    expect(reasons).toEqual([undefined])
  })

  it('is idempotent about finalising: a second close report does not re-notify', () => {
    // `close()` returns early once closed, so nothing else reaches this guard. A transport that
    // reports a close twice would otherwise notify the consumer twice and re-fail settled appends.
    const closed = vi.fn()
    const { session } = liveSession({ onClosed: closed })
    session.handleTransportClose('first')
    session.handleTransportClose('second')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith('first')
  })

  it('survives a session with no handlers at all', async () => {
    const transport = new FakeTransport({ onMessage: () => {}, onClose: () => {}, onError: () => {} })
    const session = new OpenAiLiveSession({
      transport,
      started: STARTED_FACTS,
      id: 's',
      handlers: {},
      appendAckTimeoutMs: 50,
    })
    expect(() => {
      session.sendAudio(new Uint8Array([1]))
      session.handleFrame(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'x' }))
      session.handleFrame(JSON.stringify({ type: 'session.output_audio.delta', delta: 'AA==' }))
      // Every callback is optional, so the no-handler path must cover all of them — not only the two
      // that happen to be convenient elsewhere. An unhandled optional callback would throw here.
      session.handleFrame(JSON.stringify({
        type: 'session.delegation.created',
        delegation: { id: 'i', target: 'client' },
      }))
      session.handleFrame(JSON.stringify({ type: 'session.usage.updated', usage: { seconds: 1 } }))
      session.handleFrame(JSON.stringify({ type: 'session.instructions.appended' }))
      session.handleFrame(JSON.stringify({ type: 'error', error: { message: 'boom' } }))
      session.handleFrame(JSON.stringify({ type: 'session.closed', reason: 'bye', usage: { seconds: 2 } }))
    }).not.toThrow()
    await session.close()
  })
})
