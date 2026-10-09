import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { RealtimeAdapter, RealtimeRuntime, REALTIME_ERROR_CODES, RealtimeError, type Journal, type RealtimeDelegationProgress, type RealtimeSession, type RealtimeSessionHandlers, type RealtimeSessionOptions } from 'dsh-realtime'
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
  /** Make the next append fail, as a provider that will not take it does. */
  refuseAppend = false
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
        if (adapter.refuseAppend) return Promise.reject(new Error('the provider refused the append'))
        return Promise.resolve()
      },
      appendThinking(text, delegationId) {
        appends.push({ kind: 'thinking', text, delegationId })
        if (adapter.refuseAppend) return Promise.reject(new Error('the provider refused the append'))
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

  it('records the ask and the refusal when a boot-time open fails, so a restart cannot be silent', async () => {
    const mounted = harness()
    mounted.adapter.refuseOpen = true

    apply(mounted.ctx, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()

    // This path used to raise the failure on the bus and record nothing, so a journal read after a restart
    // showed no trace of an open that was attempted and refused — the same three entries of silence as a
    // session nobody asked for. It is routed through `requestSession` for exactly that reason.
    const kinds = mounted.journal.snapshot().map(entry => entry.kind)
    expect(kinds).toContain('session.requested')
    expect(mounted.journal.snapshot().find(entry => entry.kind === 'session.requested')?.detail)
      .toEqual({ trigger: 'autostart' })
    expect(mounted.journal.snapshot().find(entry => entry.kind === 'session.failed')?.detail)
      .toEqual({ class: 'Error', trigger: 'autostart' })
  })

  it('records no ask of its own for a request that arrived as an event', async () => {
    const { ctx: context, adapter, journal } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await tick()

    adapter.refuseOpen = true
    context.emit('realtime-agent/start')
    await tick()

    // The asker records the ask — the route does, on the connection that prompted it — so echoing it here
    // would write two requests for one, and the pair that brackets the hand-off would read as a duplicate.
    expect(journal.snapshot().some(entry => entry.kind === 'session.requested')).toBe(false)
    expect(journal.snapshot().find(entry => entry.kind === 'session.failed')?.detail)
      .toEqual({ class: 'Error' })
  })

  it('records what it resolved, so a journal can be read without the profile beside it', async () => {
    const { ctx: context, journal } = harness()
    apply(context, Config({
      provider: 'fake',
      model: 'gpt-live-1',
      voice: 'marin',
      autoStart: true,
      instructions: SENTINEL_TEXT,
    }) as RealtimeAgentConfig)
    await tick()

    expect(journal.snapshot().find(entry => entry.kind === 'config.resolved')?.detail).toEqual({
      plugin: 'dsh-realtime-agent',
      provider: 'fake',
      model: 'gpt-live-1',
      voice: 'marin',
      autoStart: 'true',
      delegationTimeoutMs: '10000',
      maxTranscriptChars: '6000',
    })
    // `instructions` is authored text of unbounded length: the journal records what happened, rather than
    // copying the configuration into itself. The sentinel is the same one the leak test uses.
    expect(JSON.stringify(journal.snapshot())).not.toContain(SENTINEL_TEXT)
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
    const transcript = new TranscriptBuffer(() => 100)
    return {
      calls,
      transcript,
      handlers: createHandlers({
        transcript,
        session: () => undefined,
        ask: () => undefined,
        timeoutMs: () => 50,
        onClosed: () => { calls.closed += 1 },
        onSessionError: (error) => { calls.errors.push(error) },
        onAudio: (pcm16) => { calls.audio.push(pcm16) },
        // Recorded nowhere here: this suite is about the handlers, and the plugin's own journal
        // wiring is asserted beside it.
        onAcknowledged: () => undefined,
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

describe('narrating a turn', () => {
  /** A live session whose delegations are answered, so a turn stays open long enough to be stepped. */
  const running = async () => {
    const mounted = harness()
    mounted.ctx.on('realtime-agent/delegation', () => ({ text: 'Staging is green.', mode: 'spoken' }))
    apply(mounted.ctx, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()
    return mounted
  }

  const step = (id: string, channel: 'commentary' | 'thinking' = 'commentary'): RealtimeDelegationProgress =>
    ({ id, channel, text: 'Reading a file.' })

  it('carries a step to the session while the turn is still waiting', async () => {
    const { ctx: context, adapter } = await running()
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    // Emitted synchronously, while the delegation is outstanding: the only moment the provider will place
    // an append at all is while it is generating, which is while this turn is still open.
    context.emit('realtime-agent/delegation-progress', step('item_1'))
    await tick()

    expect(adapter.appends).toEqual([
      { kind: 'commentary', text: 'Reading a file.', delegationId: 'item_1' },
      { kind: 'commentary', text: 'Staging is green.', delegationId: 'item_1' },
    ])
  })

  it('carries a silent step the same way — the channel is the emitter\u2019s choice, not this half\u2019s', async () => {
    const { ctx: context, adapter } = await running()
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    context.emit('realtime-agent/delegation-progress', step('item_1', 'thinking'))
    await tick()

    expect(adapter.appends[0]).toEqual({ kind: 'thinking', text: 'Reading a file.', delegationId: 'item_1' })
  })

  it('acknowledges a step it placed, on the same rule as an answer', async () => {
    const { ctx: context, adapter, journal } = await running()
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    context.emit('realtime-agent/delegation-progress', step('item_1'))
    await tick()

    const acknowledged = journal.snapshot().filter(entry => entry.kind === 'append.acknowledged')
    expect(acknowledged.map(entry => entry.detail.append)).toEqual(['commentary', 'commentary'])
  })

  it('drops a step for a delegation nobody is waiting on', async () => {
    const { ctx: context, adapter } = await running()
    context.emit('realtime-agent/delegation-progress', step('item_9'))
    await tick()

    expect(adapter.appends).toEqual([])
  })

  it('drops a step that arrives after the turn settled, rather than talking into the next one', async () => {
    const { ctx: context, adapter } = await running()
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await tick()
    const answered = adapter.appends.length

    context.emit('realtime-agent/delegation-progress', step('item_1'))
    await tick()

    expect(adapter.appends).toHaveLength(answered)
  })

  it('records a step the provider does not take, so a dropped narration is not silent', async () => {
    const { ctx: context, adapter, journal } = await running()
    adapter.refuseAppend = true
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    context.emit('realtime-agent/delegation-progress', step('item_1'))
    await tick()

    const dropped = journal.snapshot().find(entry => entry.kind === 'progress.dropped')
    expect(dropped?.detail).toEqual({ id: 'item_1', channel: 'commentary' })
  })

  it('does nothing for a step when no session is open', async () => {
    const { ctx: context } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)

    expect(() => { context.emit('realtime-agent/delegation-progress', step('item_1')) }).not.toThrow()
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

describe('the settings it declares', () => {
  it('declares its two live fields, and the field the gate reclassified', async () => {
    const { ctx: context } = harness()
    apply(context, Config({ provider: 'fake', maxTranscriptChars: 6_000 }) as RealtimeAgentConfig)

    expect(context.realtime.settings.list()).toEqual([
      {
        key: 'realtime-agent.delegationTimeoutMs',
        owner: 'realtime-agent',
        field: 'delegationTimeoutMs',
        kind: 'number',
        scope: 'live',
        describe: 'How long the voice model waits for a responder',
        value: 10_000,
      },
      {
        key: 'realtime-agent.maxTranscriptChars',
        owner: 'realtime-agent',
        field: 'maxTranscriptChars',
        kind: 'number',
        scope: 'live',
        describe: 'Character budget for the transcript carried on a delegation',
        value: 6_000,
      },
      {
        // Restart-bound, and declared so that the classification bites: see the refusal below. Its one
        // read site is the boot, so nothing a running process could do would honour a change.
        key: 'realtime-agent.autoStart',
        owner: 'realtime-agent',
        field: 'autoStart',
        kind: 'boolean',
        scope: 'restart',
        describe: 'Open a session as soon as the plugin mounts',
        value: false,
      },
    ])
  })

  it('refuses a change to autoStart with the restart it needs, rather than ignoring it', async () => {
    const { ctx: context, adapter } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)

    expect(context.realtime.settings.apply('realtime-agent.autoStart', 'true')).toEqual({
      ok: false,
      key: 'realtime-agent.autoStart',
      code: 'FROZEN_SETTING',
      reason: '"realtime-agent.autoStart" is claimed when the plugin loads — restart to change it',
    })
    // And nothing happened: a refused change must not open a session on the way past.
    expect(adapter.handlers).toBeUndefined()
  })

  it('applies a shorter delegation window to the next delegation', async () => {
    const { ctx: context, adapter } = harness()
    // A responder far slower than the window under test, so the window is the only thing deciding
    // which of the two is heard.
    context.on('realtime-agent/delegation', async () => {
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      return { text: 'too late', mode: 'spoken' as const }
    })
    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()

    expect(context.realtime.settings.apply('realtime-agent.delegationTimeoutMs', '5')).toMatchObject({ ok: true })
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await new Promise((resolve) => { setTimeout(resolve, 120) })

    // The voice model is told plainly, rather than left waiting — or worse, left believing an answer
    // that never came.
    expect(adapter.appends).toEqual([
      { kind: 'commentary', text: agent.UNANSWERED_NOTICE, delegationId: 'item_1' },
    ])
  })

  it('lets the same slow answer through once the window is raised', async () => {
    const { ctx: context, adapter } = harness()
    context.on('realtime-agent/delegation', async () => {
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      return { text: 'in time after all', mode: 'spoken' as const }
    })
    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()

    expect(context.realtime.settings.apply('realtime-agent.delegationTimeoutMs', '5000')).toMatchObject({ ok: true })
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await new Promise((resolve) => { setTimeout(resolve, 120) })

    expect(adapter.appends).toEqual([
      { kind: 'commentary', text: 'in time after all', delegationId: 'item_1' },
    ])
  })

  it('applies the transcript budget to the next fragment, and so to the next delegation', async () => {
    const { ctx: context, adapter } = harness()
    const asked: DelegationRequest[] = []
    context.on('realtime-agent/delegation', (request) => {
      asked.push(request)
      return { text: 'ok', mode: 'spoken' as const }
    })
    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()

    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'first line', final: true })
    expect(context.realtime.settings.apply('realtime-agent.maxTranscriptChars', '10')).toMatchObject({ ok: true })
    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'second line', final: true })

    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await tick()

    // The budget is read at eviction, so the change reached the very next fragment rather than the next
    // conversation — which is the difference between a live field and a field that looks live.
    expect(asked[0]?.transcript).toEqual([{ kind: 'input', text: 'second line' }])
  })

  it('refuses a budget that is not a positive whole number, naming the field', async () => {
    const { ctx: context } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    expect(context.realtime.settings.apply('realtime-agent.delegationTimeoutMs', '0'))
      .toMatchObject({ code: 'INVALID_SETTING', reason: /delegationTimeoutMs must be a positive whole number/ })
    expect(context.realtime.settings.apply('realtime-agent.maxTranscriptChars', 'lots'))
      .toMatchObject({ code: 'INVALID_SETTING' })
  })

  it('withdraws its settings with the fiber that registered them', async () => {
    const { ctx: context } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    const settings = context.realtime.settings
    await context.fiber.dispose()
    ctx = undefined
    expect(settings.list()).toEqual([])
  })
})

describe('answering a session request with its outcome', () => {
  it('returns the state after a successful start, not an acknowledgement that it was asked', async () => {
    const { ctx: context } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await tick()

    // The dispatch the control channel makes. `emit` ignores this value and `serial` waits for it, which
    // is how one start path serves both callers.
    await expect(context.serial('realtime-agent/start')).resolves.toEqual({
      ok: true,
      voice: { open: true, provider: 'fake', model: 'gpt-live-1', sessionId: 'sess-1' },
    })
    await expect(context.serial('realtime-agent/stop')).resolves.toEqual({
      ok: true,
      voice: { open: false, provider: 'fake', model: 'gpt-live-1' },
    })
  })

  it('reports the voice a start would use, while none is open', async () => {
    const { ctx: context } = harness()
    apply(context, Config({ provider: 'fake', voice: 'marin' }) as RealtimeAgentConfig)
    await tick()

    // An absence would be a worse answer than this one: a status surface needs to know what it is about
    // to open, not only that nothing is.
    await expect(context.serial('realtime-agent/status')).resolves.toEqual({
      open: false,
      provider: 'fake',
      model: 'gpt-live-1',
      voice: 'marin',
    })
  })

  it('carries a seam failure’s code and remedy, and never its message', async () => {
    const { ctx: context } = harness()
    class CodedAdapter extends RecordingAdapter {
      override session(): Promise<RealtimeSession> {
        return Promise.reject(new RealtimeError(
          'the provider credential is not configured (apiKey)',
          REALTIME_ERROR_CODES.NOT_CONFIGURED,
          { detail: { remedy: 'Set the apiKey setting for this route, then try again.', setting: 'apiKey' } },
        ))
      }
    }
    context.realtime.registerAdapter(['coded'], new CodedAdapter())
    apply(context, Config({ provider: 'coded' }) as RealtimeAgentConfig)
    await tick()

    const outcome = await context.serial('realtime-agent/start')
    expect(outcome).toMatchObject({
      ok: false,
      voice: { open: false, provider: 'coded', model: 'gpt-live-1' },
      refusal: { code: 'NOT_CONFIGURED', remedy: 'Set the apiKey setting for this route, then try again.' },
    })
    // The message names no value, but it is still dropped: the class and the code are what a caller
    // branches on, and the plugin that holds the credential is the one that relays the text.
    expect(JSON.stringify(outcome)).not.toContain('the provider credential is not configured')
  })

  it('carries the code alone when the failure offered no remedy', async () => {
    const { ctx: context } = harness()
    class BareAdapter extends RecordingAdapter {
      override session(): Promise<RealtimeSession> {
        return Promise.reject(new RealtimeError('throttled', REALTIME_ERROR_CODES.RATE_LIMITED))
      }
    }
    context.realtime.registerAdapter(['bare'], new BareAdapter())
    apply(context, Config({ provider: 'bare' }) as RealtimeAgentConfig)
    await tick()

    await expect(context.serial('realtime-agent/start')).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'RATE_LIMITED' },
    })
  })

  it('names the class of a failure that carried no code of its own', async () => {
    const { ctx: context } = harness()
    class RudeAdapter extends RecordingAdapter {
      override session(): Promise<RealtimeSession> {
        return Promise.reject('the provider said no')
      }
    }
    context.realtime.registerAdapter(['rude'], new RudeAdapter())
    apply(context, Config({ provider: 'rude' }) as RealtimeAgentConfig)
    await tick()

    await expect(context.serial('realtime-agent/start')).resolves.toMatchObject({
      ok: false,
      refusal: { class: 'string' },
    })
  })

  it('reports a failed stop as well as a failed start', async () => {
    const { ctx: context, adapter } = harness()
    const failures: Error[] = []
    context.on('realtime-agent/error', (error: Error) => { failures.push(error) })
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await tick()
    await context.serial('realtime-agent/start')

    adapter.refuseClose = true
    await expect(context.serial('realtime-agent/stop')).resolves.toMatchObject({
      ok: false,
      voice: { open: false },
      refusal: { class: 'Error' },
    })
    // Still on the bus, because a transport that only emits has nowhere else to learn about it.
    expect(failures).toHaveLength(1)
  })
})
