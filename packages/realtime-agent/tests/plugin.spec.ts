import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { RealtimeAdapter, RealtimeRuntime, type Journal, type RealtimeSession, type RealtimeSessionHandlers, type RealtimeSessionOptions } from 'dsh-realtime'
import * as agent from '../src/index.ts'
import { Config, createHandlers, apply } from '../src/index.ts'
import { TranscriptBuffer } from '../src/transcript.ts'
import type { DelegationRequest, RealtimeAgentConfig } from '../src/types.ts'

/** An adapter that records what the consumer appended, and lets a test raise a delegation. */
class RecordingAdapter extends RealtimeAdapter {
  readonly appends: Array<{ kind: 'commentary' | 'thinking'; text: string; delegationId: string | undefined }> = []
  readonly sentAudio: Uint8Array[] = []
  handlers: RealtimeSessionHandlers | undefined
  opened = 0
  closed = 0
  /** Make the next audio write fail, as a session that closed mid-flight does. */
  refuseAudio = false
  /** Make opening fail, as a provider that refuses the session does. */
  refuseOpen = false
  /** Make closing fail, as a session that is already gone does. */
  refuseClose = false

  session(options: RealtimeSessionOptions): Promise<RealtimeSession> {
    // Wire the handlers exactly as a real adapter does: a substitute that drops them makes every
    // injected event vanish, and the suite then debugs the wrong file.
    this.handlers = options.handlers
    if (this.refuseOpen) return Promise.reject(new Error('the provider refused the session'))
    this.opened += 1
    const appends = this.appends
    const adapter = this
    return Promise.resolve({
      id: 'sess-1',
      started: {
        provider: 'fake',
        model: 'gpt-live-1',
        inputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
        outputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
      },
      sendAudio(pcm16: Uint8Array): void {
        if (adapter.refuseAudio) throw new Error('the session closed mid-write')
        adapter.sentAudio.push(pcm16)
      },
      muteInput(): void {},
      unmuteInput(): void {},
      appendCommentary(text, delegationId) {
        appends.push({ kind: 'commentary', text, delegationId })
        return Promise.resolve()
      },
      appendThinking(text, delegationId) {
        appends.push({ kind: 'thinking', text, delegationId })
        return Promise.resolve()
      },
      appendInstructions: () => Promise.resolve(),
      close: () => {
        if (adapter.refuseClose) return Promise.reject(new Error('the session is already gone'))
        adapter.closed += 1
        // A real adapter reports the close — `realtime-openai/session.ts` calls this on teardown — and
        // that report is the only way the agent learns the session is gone. A fake that stayed silent
        // would leave the plugin journaling a close it had no way to observe.
        adapter.handlers?.onClosed?.()
        return Promise.resolve()
      },
    })
  }
}

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5) })

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** A tools service that records what was registered and what was released. */
class FakeTools extends Service {
  readonly registered: ToolDefinition[] = []
  readonly released: string[] = []

  constructor(context: Context) {
    super(context, 'tools')
  }

  register(definition: ToolDefinition): () => void {
    this.registered.push(definition)
    return () => { this.released.push(definition.name) }
  }
}

/** A context with the real seam, one recording adapter on the `fake` route, and a tools service. */
function harness(): { ctx: Context; adapter: RecordingAdapter; tools: FakeTools; journal: Journal } {
  const context = new Context()
  const seam = new RealtimeRuntime(context)
  const tools = new FakeTools(context)
  const adapter = new RecordingAdapter()
  context.realtime.registerAdapter(['fake'], adapter)
  ctx = context
  return { ctx: context, adapter, tools, journal: seam.journal }
}

/** The plugin applied and a session already open: the state most journal entries need. */
async function started(): Promise<ReturnType<typeof harness>> {
  const mounted = harness()
  apply(mounted.ctx, Config({ provider: 'fake' }) as RealtimeAgentConfig)
  await tick()
  mounted.ctx.emit('realtime-agent/start')
  await tick()
  return mounted
}

/**
 * A planted key and its unmistakable fragment. Assembled, not written — a credential-shaped literal in
 * source is what the repo's leak scan denies by construction and what gitleaks fails on by entropy.
 */
const SENTINEL_KEY = ['sk', 'agent', 'sentinelmustneverappear'].join('-')
const SENTINEL_TEXT = 'sentinelmustneverappear'

describe('the journal the agent writes', () => {
  it('records the session it opened and closed, because it owns that lifecycle', async () => {
    const { ctx: context, journal } = await started()

    context.emit('realtime-agent/stop')
    await tick()

    const kinds = journal.snapshot().map(entry => entry.kind)
    // The audio route emits a *request* for a session and records nothing for it; this plugin is the
    // one that knows whether one exists, so the entry lands here or nowhere.
    expect(kinds).toContain('session.opened')
    expect(kinds).toContain('session.closed')
  })

  it('records the class of a session failure and never its message', async () => {
    const { adapter, journal } = await started()

    // A provider error is exactly where a key turns up, and this plugin holds no credential to redact
    // against — so it records the category and leaves the text to the plugin that holds the key.
    adapter.handlers?.onError?.(new TypeError(`the provider refused key ${SENTINEL_KEY}`))

    const failed = journal.snapshot().find(entry => entry.kind === 'session.failed')
    expect(failed?.detail).toEqual({ class: 'TypeError' })
    expect(JSON.stringify(journal.snapshot())).not.toContain(SENTINEL_TEXT)
  })

  it('records output audio as handed over, never as heard (invariant 6)', async () => {
    const { adapter, journal } = await started()

    adapter.handlers?.onAudio?.(new Uint8Array(8))

    expect(journal.snapshot().find(entry => entry.kind === 'speech.sent')?.detail).toEqual({ bytes: '8' })
    // No sink in this journal claims playback, because no host-side observer has one to claim: the ear
    // belongs to the page. A kind named for it would be the diagnostics layer lying about itself.
    expect(journal.snapshot().every(entry => !entry.kind.includes('played'))).toBe(true)
  })
})

describe('plugin shape', () => {
  it('named-exports its contract and has no default export', () => {
    // A default export makes the Loader discard a function plugin's namespace: it loads and
    // contributes nothing, which is the quietest possible failure.
    expect(agent.name).toBe('realtime-agent')
    expect(agent.inject).toEqual(['realtime', 'tools'])
    expect('default' in agent).toBe(false)
    expect(typeof apply).toBe('function')
  })

  it('defaults to not opening a session', () => {
    const resolved = Config({}) as RealtimeAgentConfig
    expect(resolved.autoStart).toBe(false)
    expect(resolved.provider).toBe('openai-live')
    expect(resolved.model).toBe('gpt-live-1')
    expect(resolved.voice).toBeUndefined()
    expect(resolved.instructions).toBeUndefined()
    expect(resolved.delegationTimeoutMs).toBe(10_000)
    expect(resolved.maxTranscriptChars).toBe(6_000)
  })
})

describe('createHandlers', () => {
  const deps = (overrides: Partial<Parameters<typeof createHandlers>[0]> = {}) => {
    const calls: { closed: number; errors: Error[]; audio: Uint8Array[] } = { closed: 0, errors: [], audio: [] }
    const transcript = new TranscriptBuffer(100)
    return {
      calls,
      transcript,
      handlers: createHandlers({
        transcript,
        session: () => undefined,
        ask: () => undefined,
        timeoutMs: 50,
        onClosed: () => { calls.closed += 1 },
        onSessionError: (error) => { calls.errors.push(error) },
        onAudio: (pcm16) => { calls.audio.push(pcm16) },
        ...overrides,
      }),
    }
  }

  it('forwards output audio to the caller, frame for frame', () => {
    const { handlers, calls } = deps()
    const pcm16 = new Uint8Array([1, 2])
    handlers.onAudio?.(pcm16)
    expect(calls.audio).toEqual([pcm16])
  })

  it('records transcripts, coalescing as it goes', () => {
    const { handlers, transcript } = deps()
    handlers.onTranscript?.({ kind: 'input', text: 'is ', final: false })
    handlers.onTranscript?.({ kind: 'input', text: 'staging ok?', final: true })
    expect(transcript.lines()).toEqual([{ kind: 'input', text: 'is staging ok?' }])
  })

  it('does nothing for a delegation with no live session', () => {
    // Speaking into a closed transport would raise a failure from inside a handler, which is the
    // worst place to raise one — so the handler declines to act instead.
    const { handlers } = deps({ session: () => undefined, ask: () => { throw new Error('should not be asked') } })
    expect(() => { handlers.onDelegation?.({ id: 'd', target: 'client', offsetMs: 0 }) }).not.toThrow()
  })

  it('reports a session-scoped failure rather than throwing it', () => {
    const { handlers, calls } = deps()
    const failure = new Error('transport died')
    handlers.onError?.(failure)
    expect(calls.errors).toEqual([failure])
  })

  it('notes the close, so the caller can drop its session reference', () => {
    const { handlers, calls } = deps()
    handlers.onClosed?.('completed')
    expect(calls.closed).toBe(1)
  })
})

describe('apply', () => {
  it('opens nothing when not asked to start', () => {
    const { ctx: context, adapter } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    expect(adapter.handlers).toBeUndefined()
  })

  it('opens a session and reports the options the provider accepted', async () => {
    const { ctx: context, adapter } = harness()
    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()
    expect(adapter.handlers).toBeDefined()
  })

  it('passes through a configured voice and instructions', async () => {
    const { ctx: context } = harness()
    const seen: string[] = []
    class SpyingAdapter extends RecordingAdapter {
      override session(options: RealtimeSessionOptions): Promise<RealtimeSession> {
        seen.push(options.voice ?? '(none)', options.instructions ?? '(none)')
        return super.session(options)
      }
    }
    context.realtime.registerAdapter(['spy'], new SpyingAdapter())
    apply(context, Config({
      provider: 'spy',
      autoStart: true,
      voice: 'marin',
      instructions: 'Be brief.',
    }) as RealtimeAgentConfig)
    await tick()
    expect(seen).toEqual(['marin', 'Be brief.'])
  })

  it('reports a failed open on the bus instead of throwing it', async () => {
    const { ctx: context } = harness()
    const failures: Error[] = []
    class FailingAdapter extends RecordingAdapter {
      override session(): Promise<RealtimeSession> {
        return Promise.reject(new Error('credit_balance_exhausted'))
      }
    }
    context.realtime.registerAdapter(['failing'], new FailingAdapter())
    // `apply` is synchronous, so it cannot throw an asynchronous failure — the composer must still
    // learn about it, and the bus is where it lands.
    context.on('realtime-agent/error', (error) => { failures.push(error) })
    apply(context, Config({ provider: 'failing', autoStart: true }) as RealtimeAgentConfig)
    await tick()
    expect(failures).toHaveLength(1)
    expect(failures[0]!.message).toBe('credit_balance_exhausted')
  })

  it('reports a failure a live session contained, rather than letting it vanish', async () => {
    const { ctx: context, adapter } = harness()
    const failures: Error[] = []
    context.on('realtime-agent/error', (error) => { failures.push(error) })
    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()

    const failure = new Error('transport died mid-session')
    adapter.handlers?.onError?.(failure)
    // A post-open failure the adapter contained is the only signal the application gets that the
    // conversation is no longer whole; dropping it would leave a session that looks healthy.
    expect(failures).toEqual([failure])
  })

  it('bridges a delegation end to end: seam, serial dispatch, session append', async () => {
    const { ctx: context, adapter } = harness()
    const asked: DelegationRequest[] = []
    context.on('realtime-agent/delegation', (request) => {
      asked.push(request)
      return { text: 'Staging is green.', mode: 'spoken' }
    })

    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()

    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'is staging ok?', final: true })
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 4800 })
    await tick()

    // The responder saw the delegation correlated with the conversation, not a bare id.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toEqual({
      id: 'item_1',
      offsetMs: 4800,
      transcript: [{ kind: 'input', text: 'is staging ok?' }],
      sessionId: 'sess-1',
    })
    expect(adapter.appends).toEqual([{ kind: 'commentary', text: 'Staging is green.', delegationId: 'item_1' }])
  })

  it('says so out loud when nothing answers, and stops after the session closes', async () => {
    const { ctx: context, adapter } = harness()
    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()

    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await tick()
    expect(adapter.appends).toEqual([
      { kind: 'commentary', text: agent.UNANSWERED_NOTICE, delegationId: 'item_1' },
    ])

    adapter.handlers?.onClosed?.('completed')
    adapter.handlers?.onDelegation?.({ id: 'item_2', target: 'client', offsetMs: 0 })
    await tick()
    expect(adapter.appends).toHaveLength(1)
  })
})

describe('the audio seams', () => {
  /** A context with a live session, so the microphone seam has somewhere to write. */
  const live = async () => {
    const { ctx: context, adapter } = harness()
    const out: Uint8Array[] = []
    const failures: Error[] = []
    context.on('realtime-agent/audio', (pcm16: Uint8Array) => { out.push(pcm16) })
    context.on('realtime-agent/error', (error: Error) => { failures.push(error) })
    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()
    return { context, adapter, out, failures }
  }

  it('writes captured frames to the open session, in order', async () => {
    const { context, adapter } = await live()
    const first = new Uint8Array([1, 2, 3])
    const second = new Uint8Array([4, 5])
    context.emit('realtime-agent/mic', first)
    context.emit('realtime-agent/mic', second)
    expect(adapter.sentAudio).toEqual([first, second])
  })

  it('drops capture frames with no session open, rather than buffering or throwing', async () => {
    const { ctx: context, adapter } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    // No `autoStart`, so nothing is open. A capture device may well start first.
    expect(() => { context.emit('realtime-agent/mic', new Uint8Array([9])) }).not.toThrow()
    expect(adapter.sentAudio).toEqual([])
  })

  it('reports a failed audio write on the bus instead of throwing from the listener', async () => {
    const { context, adapter, failures } = await live()
    adapter.refuseAudio = true
    // A write into a session that closed a moment ago is a race, not a fault — and raising from inside
    // a listener is the worst place to raise one.
    expect(() => { context.emit('realtime-agent/mic', new Uint8Array([7])) }).not.toThrow()
    expect(failures).toHaveLength(1)
    expect(failures[0]!.message).toBe('the session closed mid-write')
  })

  it('carries provider output audio onto the bus, unbuffered', async () => {
    const { adapter, out } = await live()
    const pcm16 = new Uint8Array([10, 11])
    adapter.handlers?.onAudio?.(pcm16)
    expect(out).toEqual([pcm16])
  })

  it('stops writing capture frames once the fiber that registered the seam is disposed', async () => {
    const { context, adapter } = await live()
    await context.fiber.dispose()
    ctx = undefined
    context.emit('realtime-agent/mic', new Uint8Array([1]))
    expect(adapter.sentAudio).toEqual([])
  })
})

describe('session requests from a transport', () => {
  it('opens the session when a transport asks, and closes it when told', async () => {
    const { ctx: context, adapter } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await tick()

    context.emit('realtime-agent/start')
    await tick()
    expect(adapter.opened).toBe(1)
    // Idempotent: a second ask must not leave two live sessions nobody can see.
    context.emit('realtime-agent/start')
    await tick()
    expect(adapter.opened).toBe(1)

    context.emit('realtime-agent/stop')
    await tick()
    expect(adapter.closed).toBe(1)
  })

  it('reports a failed open and a failed close on the bus rather than throwing from the listener', async () => {
    const { ctx: context, adapter } = harness()
    const failures: Error[] = []
    context.on('realtime-agent/error', (error: Error) => { failures.push(error) })
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await tick()

    adapter.refuseOpen = true
    // A listener has no caller to catch a rejection — the worst place to raise one.
    expect(() => { context.emit('realtime-agent/start') }).not.toThrow()
    await tick()
    expect(failures[0]?.message).toBe('the provider refused the session')

    adapter.refuseOpen = false
    context.emit('realtime-agent/start')
    await tick()
    adapter.refuseClose = true
    expect(() => { context.emit('realtime-agent/stop') }).not.toThrow()
    await tick()
    expect(failures).toHaveLength(2)
  })
})

describe('the voice tools a session exposes', () => {
  it('publishes them on mount', () => {
    const { ctx: context, tools } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    expect(tools.registered.map(definition => definition.name))
      .toEqual(['voice_start', 'voice_stop'])
  })

  it('releases them with the fiber that registered them', async () => {
    const { ctx: context, tools } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await context.fiber.dispose()
    ctx = undefined
    // Registrations are effects. If this ever needs a separate teardown path, that path is what will
    // be forgotten on the day it matters.
    expect(tools.released).toEqual(['voice_start', 'voice_stop'])
  })

  it('opens exactly one session however often it is asked', async () => {
    const { ctx: context, adapter, tools } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    const start = tools.registered.find(definition => definition.name === 'voice_start')
    const first = await start!.execute({}, {} as never)
    const second = await start!.execute({}, {} as never)
    expect(second).toEqual(first)
    expect(adapter.opened).toBe(1)
  })

  it('stops the session, then reports there was nothing left to stop', async () => {
    const { ctx: context, adapter, tools } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    const start = tools.registered.find(definition => definition.name === 'voice_start')
    const stop = tools.registered.find(definition => definition.name === 'voice_stop')

    await start!.execute({}, {} as never)
    expect(await stop!.execute({}, {} as never)).toEqual({ closed: true })
    expect(adapter.closed).toBe(1)

    expect(await stop!.execute({}, {} as never)).toEqual({ closed: false })
    expect(adapter.closed).toBe(1)
  })
})
