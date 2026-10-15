import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { RealtimeAdapter, RealtimeRuntime, REALTIME_ERROR_CODES, RealtimeError, type Journal, type RealtimeDelegationProgress, type RealtimeSession, type RealtimeSessionHandlers, type RealtimeSessionOptions } from 'dsh-realtime'
import * as agent from '../src/index.ts'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { ConfigureAnswer, DiagnoseAnswer, JournalToolAnswer, ProbeAnswer } from '../src/tools.ts'
import { VOICE_SKILL_NAME } from '../src/skill.ts'
import { Config, createHandlers, apply } from '../src/index.ts'
import type { SettleOutcome } from '../src/settle.ts'
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
  /** Make opening fail with *this* error, so a classified refusal can be driven through the same path. */
  refuseOpenWith: Error | undefined
  /** Make closing fail, as a session that is already gone does. */
  refuseClose = false
  /**
   * The reason the provider gives for ending the session, when it gives one.
   *
   * A real close carries one — `session.closed` on the wire has a reason and a usage figure — and it is the
   * only field that says *why* a session someone was talking into ended. Left undefined, the fake closes as
   * silently as it always did.
   */
  closeReason: string | undefined

  session(options: RealtimeSessionOptions): Promise<RealtimeSession> {
    // Wire the handlers exactly as a real adapter does: a substitute that drops them makes every
    // injected event vanish, and the suite then debugs the wrong file.
    this.handlers = options.handlers
    if (this.refuseOpenWith !== undefined) return Promise.reject(this.refuseOpenWith)
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
        adapter.handlers?.onClosed?.(adapter.closeReason)
        return Promise.resolve()
      },
    })
  }
}

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5) })

/**
 * The same, for a test that has to let a settle window elapse rather than one turn of the loop.
 *
 * The settle is real time by design — that is what it is for — so the suite states the policy it runs under
 * rather than inheriting the production 500 ms and spending half a second per delegation.
 */
const tickFor = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** The shortest policy that still exercises the wait, for tests that delegate after a fragment arrived. */
const FAST_SETTLE = { transcriptQuietMs: 25, transcriptSettleCapMs: 100 }

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

/** A skills service that records what was contributed and what was withdrawn. */
class FakeSkills extends Service {
  readonly registered: SkillRegistration[] = []
  readonly withdrawn: string[] = []

  constructor(context: Context) {
    super(context, 'skills')
  }

  register(skill: SkillRegistration): () => void {
    this.registered.push(skill)
    return () => { this.withdrawn.push(skill.name) }
  }
}

/**
 * A context with the real seam, one recording adapter on the `fake` route, a tools service and a skills one.
 *
 * Both services are mounted because the plugin injects both, and a substitute that omits one makes `apply`
 * throw in every test rather than in the one that cares.
 */
function harness(): { ctx: Context; adapter: RecordingAdapter; tools: FakeTools; skills: FakeSkills; journal: Journal } {
  const context = new Context()
  const seam = new RealtimeRuntime(context)
  const tools = new FakeTools(context)
  const skills = new FakeSkills(context)
  const adapter = new RecordingAdapter()
  context.realtime.registerAdapter(['fake'], adapter)
  ctx = context
  return { ctx: context, adapter, tools, skills, journal: seam.journal }
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

describe('the skill the agent contributes', () => {
  it('is contributed while the row is loaded, from the code rather than from a directory', async () => {
    const { ctx: context, skills } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await tick()

    expect(skills.registered.map(skill => skill.name)).toEqual([VOICE_SKILL_NAME])
    expect(skills.registered[0]?.source).toBe('runtime')
  })

  it('is withdrawn when the row is disposed, rather than left standing', async () => {
    // The property that makes contributing it in code worth doing at all: text that outlives the tools it
    // names is an instruction to call something that is not there. That the registry *hands back* a disposer
    // is only half of it — what matters is that this plugin's own effect runs it.
    const { ctx: context, skills } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await tick()

    expect(skills.registered.map(skill => skill.name)).toEqual([VOICE_SKILL_NAME])
    expect(skills.withdrawn).toEqual([])

    await context.fiber.dispose()
    await tick()

    expect(skills.withdrawn).toEqual([VOICE_SKILL_NAME])
  })
})

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

  it('records why a session closed, because an empty close cannot be told from any other', async () => {
    // A run of five-second sessions with a bare `session.closed` is indistinguishable from somebody pressing
    // stop twice — and the discarded field is the one that would have named a provider-side limit.
    const { ctx: context, adapter, journal } = await started()

    adapter.closeReason = 'session_limit_reached'
    context.emit('realtime-agent/stop')
    await tick()

    const closed = journal.snapshot().find(entry => entry.kind === 'session.closed')
    expect(closed?.detail).toEqual({ reason: 'session_limit_reached' })
  })

  it('bounds the reason it records, so one provider string cannot bloat the file', async () => {
    const { ctx: context, adapter, journal } = await started()

    adapter.closeReason = 'x'.repeat(4_000)
    context.emit('realtime-agent/stop')
    await tick()

    const closed = journal.snapshot().find(entry => entry.kind === 'session.closed')
    expect((closed?.detail as { reason?: string }).reason).toHaveLength(200)
  })

  it('records whether a request was built from a settled transcript', async () => {
    // Nothing had ever been heard, so nothing had to be waited for. The entry says that rather than leaving a
    // reader to assume a wait happened — and an entry that is present in every session is what makes its
    // absence meaningful.
    const { adapter, journal } = await started()

    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await tick()

    const settled = journal.snapshot().find(entry => entry.kind === 'transcript.settled')
    expect(settled?.detail).toEqual({ waitedMs: '0', fragments: '0', capped: 'false' })
  })

  it('records that the model heard something, and never what it heard', async () => {
    // The entry whose absence made "the voice is broken" unanswerable: an output track that runs whatever
    // happens, and no record at all of whether anything reached the model. It is a count, so that a journal
    // can be handed to somebody.
    const { adapter, journal } = await started()

    adapter.handlers?.onTranscript?.({ kind: 'input', text: SENTINEL_TEXT, final: true })
    await tick()

    const heard = journal.snapshot().filter(entry => entry.kind === 'transcript.input')
    expect(heard).toHaveLength(1)
    expect(heard[0]!.detail).toEqual({ chars: String(SENTINEL_TEXT.length), final: 'true' })
    // The words themselves are the one thing this entry must not carry.
    expect(JSON.stringify(journal.snapshot())).not.toContain(SENTINEL_TEXT)
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

  it('records the CODE of a refusal and never its message, so a reader can act on it', async () => {
    const { ctx: context, adapter, journal } = harness()
    // The first real refusal this instrument ever captured, verbatim: the account was out of credit. The
    // journal could say `RealtimeError` and nothing else, so answering "why" took a probe against the
    // provider — the code is what turns a record of a failure into a record of what to do about it.
    adapter.refuseOpenWith = new RealtimeError(
      `no credits remaining for key ${SENTINEL_KEY}`,
      'INSUFFICIENT_CREDIT',
      {
        detail: {
          providerCode: 'credit_balance_exhausted',
          retryable: false,
          remedy: 'add credit to the OpenAI account — the balance is exhausted',
          link: 'https://platform.openai.com/settings/organization/billing/',
        },
      },
    )
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await tick()

    context.emit('realtime-agent/start')
    await tick()

    expect(journal.snapshot().find(entry => entry.kind === 'session.failed')?.detail).toEqual({
      class: 'RealtimeError',
      code: 'INSUFFICIENT_CREDIT',
      providerCode: 'credit_balance_exhausted',
      remedy: 'add credit to the OpenAI account — the balance is exhausted',
      link: 'https://platform.openai.com/settings/organization/billing/',
      retryable: 'false',
    })
    // The message is where a key turns up — this plugin holds no credential to redact against, which is why
    // the text is the adapter's to record and the code is this plugin's.
    expect(JSON.stringify(journal.snapshot())).not.toContain(SENTINEL_TEXT)
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
      transcriptQuietMs: '500',
      transcriptSettleCapMs: '1500',
      journalEntries: '25',    })
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
    // Three now: the seam it drives, the registry it publishes its tools on, and the one it contributes its
    // triage skill to. All three are hard injections because the skill is not decoration — a harness without
    // the skills registry is a harness whose model does not know these tools exist.
    expect(agent.inject).toEqual(['realtime', 'tools', 'skills'])
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
    const calls: { closed: number; errors: Error[]; audio: Uint8Array[]; settleCalls: number; settled: SettleOutcome[] } =
      { closed: 0, errors: [], audio: [], settleCalls: 0, settled: [] }
    const transcript = new TranscriptBuffer(() => 100)
    return {
      calls,
      transcript,
      handlers: createHandlers({
        transcript,
        session: () => undefined,
        ask: () => undefined,
        timeoutMs: () => 50,
        settle: () => {
          calls.settleCalls += 1
          return Promise.resolve({ waitedMs: 0, fragments: 0, capped: false })
        },
        onSettled: (outcome) => { calls.settled.push(outcome) },
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

  it('waits for a transcript only when there is a session to answer into', () => {
    // The wait sits between the guard and the answer, so a delegation with no session still declines
    // synchronously: it has nothing to answer into, and no reason to hold a timer open deciding otherwise.
    const { handlers, calls } = deps({ session: () => undefined })
    handlers.onDelegation?.({ id: 'd', target: 'client', offsetMs: 0 })

    expect(calls.settleCalls).toBe(0)
    expect(calls.settled).toEqual([])
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

    apply(context, Config({ provider: 'fake', autoStart: true, ...FAST_SETTLE }) as RealtimeAgentConfig)
    await tick()

    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'is staging ok?', final: true })
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 4800 })
    // A transcript was heard, so the request waits for it to settle before it is built: the wait is real time
    // even under the fast policy this suite states.
    await tickFor(60)

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

  it('carries the tail of the utterance, not the prefix that had arrived when the delegation landed', async () => {
    // Measured on a running app at 07:16:55.301: the delegation arrived 162 ms before the last fragment of the
    // utterance it was acting on, so the request read `Delegate this task to a client: "In a recent session,
    // which animal comes up` — cut mid-sentence, no closing quote, and the session answered that prefix. The
    // fragment below arrives after the delegation, as that one did, and it has to be in what the responder sees.
    const { ctx: context, adapter, journal } = harness()
    const asked: DelegationRequest[] = []
    context.on('realtime-agent/delegation', (request) => {
      asked.push(request)
      return { text: 'A giraffe.', mode: 'spoken' }
    })
    apply(context, Config({ provider: 'fake', autoStart: true, ...FAST_SETTLE }) as RealtimeAgentConfig)
    await tick()

    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'which animal comes up', final: false })
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 10_600 })
    setTimeout(() => { adapter.handlers?.onTranscript?.({ kind: 'input', text: ' with a long neck?', final: false }) }, 10)
    await tickFor(120)

    expect(asked[0]?.transcript).toEqual([{ kind: 'input', text: 'which animal comes up with a long neck?' }])

    // And the record says the wait is why. Three facts, because a clipped request and a badly-worded one are
    // otherwise the same journal: the wait caught something, the ceiling did not end it, and it took time.
    const settled = journal.snapshot().find(entry => entry.kind === 'transcript.settled')
    expect(settled?.detail).toMatchObject({ fragments: '1', capped: 'false' })
    expect(Number((settled?.detail as { waitedMs?: string }).waitedMs)).toBeGreaterThan(0)
  })

  it('seals the utterance a request came from, so the next request does not join it', async () => {
    // Two questions in one session with an answer between them. Without the seal the second request's last
    // line is the first question plus a prefix of the second — which is the shape the relay hands the session
    // as "the live request", and the reason a request can arrive as a sentence fragment.
    const { ctx: context, adapter } = harness()
    const asked: DelegationRequest[] = []
    context.on('realtime-agent/delegation', (request) => {
      asked.push(request)
      return { text: 'Answer.', mode: 'spoken' }
    })
    apply(context, Config({ provider: 'fake', autoStart: true, ...FAST_SETTLE }) as RealtimeAgentConfig)
    await tick()

    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'first question', final: false })
    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await tickFor(120)

    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'second question', final: false })
    adapter.handlers?.onDelegation?.({ id: 'item_2', target: 'client', offsetMs: 0 })
    await tickFor(120)

    expect(asked[1]?.transcript).toEqual([
      { kind: 'input', text: 'first question' },
      { kind: 'input', text: 'second question' },
    ])
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
      .toEqual([
        'voice_start', 'voice_stop', 'voice_status', 'voice_configure', 'voice_diagnose', 'voice_probe_provider',
        'voice_journal',
      ])
  })

  it('releases them with the fiber that registered them', async () => {
    const { ctx: context, tools } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    await context.fiber.dispose()
    ctx = undefined
    // Registrations are effects. If this ever needs a separate teardown path, that path is what will
    // be forgotten on the day it matters.
    expect(tools.released).toEqual([
      'voice_start', 'voice_stop', 'voice_status', 'voice_configure', 'voice_diagnose', 'voice_probe_provider',
      'voice_journal',
    ])
  })

  it('reports the session it opened, through the tool a model would call', async () => {
    // The wiring test for the status tool: the unit suite supplies the status, so only this can show that
    // the registered tool is reading the plugin's own session rather than a fixed answer.
    const { ctx: context, tools } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    const call = async (name: string) =>
      await tools.registered.find(definition => definition.name === name)!.execute({}, {} as never)

    // `steering` is empty here because this harness mounts no responder: the list is read from the seam,
    // and an empty one is the honest answer rather than an omission.
    expect(await call('voice_status')).toMatchObject({ open: false, provider: 'fake', steering: [] })
    await call('voice_start')
    expect(await call('voice_status')).toMatchObject({ open: true, sessionId: 'sess-1' })
  })

  it('probes the provider without adopting the session it opens', async () => {
    // The property that makes the probe safe to call at all: it goes through the seam directly rather than
    // through the agent's own `open()`, so the live session is untouched — a diagnostic that displaced the
    // session it was reporting on would be worse than no diagnostic.
    const { ctx: context, adapter, tools } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    const call = async (name: string) =>
      await tools.registered.find(definition => definition.name === name)!.execute({}, {} as never)

    expect(await call('voice_probe_provider')).toMatchObject({ ok: true })
    expect(adapter.opened).toBe(1)
    // Still closed, because the probe's session was not adopted as the plugin's own.
    expect(await call('voice_status')).toMatchObject({ open: false })

    // And a provider that refuses is reported as a class when there is no code: the same classifier an open
    // uses, so the two cannot disagree about what a provider error means.
    adapter.refuseOpen = true
    expect(await call('voice_probe_provider') as ProbeAnswer).toMatchObject({ ok: false, class: 'Error' })
  })

  it('reads the settings this bundle registered, through the tool a model would call', async () => {
    // The wiring test: the unit suite hands the tool a registry it supplies, so only this can show the tool is
    // pointed at the seam's own — the registry that is also the only route a live change can take.
    const { ctx: context, tools } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    const answer = await tools.registered.find(definition => definition.name === 'voice_configure')!
      .execute({}, {} as never) as ConfigureAnswer

    expect(answer.action).toBe('read')
    expect(answer.settings.map(entry => entry.key)).toContain('realtime-agent.journalEntries')
    expect(answer.settings.every(entry => entry.scope.length > 0)).toBe(true)
  })

  it('diagnoses from the seam, through the tool a model would call', async () => {
    // The wiring test for the five checks: every one of them is read from the seam or from this plugin's own
    // record, so only a test at this level can show the accessors are pointed at the live ones. This harness
    // mounts no transport, no responder and an adapter that reports nothing about its credential, and all
    // three of those facts have to come back out of the tool.
    const { ctx: context, tools } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    const call = async (name: string) =>
      await tools.registered.find(definition => definition.name === name)!.execute({}, {} as never)
    const answer = await call('voice_diagnose') as DiagnoseAnswer

    expect(answer.checks.map(check => check.name)).toEqual(['key', 'route', 'session', 'delegation', 'turn'])
    // The adapter here is the seam's base class, whose metadata says nothing about a credential: `waiting` is
    // the honest answer, and the branch that reports it.
    expect(answer.checks.find(check => check.name === 'key')).toMatchObject({ state: 'waiting' })
    expect(answer.checks.find(check => check.name === 'route')).toMatchObject({ state: 'fail' })
    expect(answer.checks.find(check => check.name === 'delegation')).toMatchObject({ state: 'fail' })
    expect(answer.verdict).toBe('fail')
  })

  it('reads the record this plugin writes, not an empty one it was handed', async () => {
    // The unit suite hands the tool a journal it supplies, so only a test at this level can show that the
    // tool the plugin actually registers is pointed at the journal the plugin actually writes to. Without
    // it, a mis-wired accessor would answer every question with an empty record and every other test
    // would still pass.
    const { ctx: context, tools } = harness()
    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()

    const journalTool = tools.registered.find(definition => definition.name === 'voice_journal')
    const result = await journalTool!.execute({}, {} as never) as JournalToolAnswer

    expect(result.entries.map(e => e.kind)).toContain('config.resolved')
    expect(result.entries.map(e => e.kind)).toContain('session.opened')
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
      it('declares its five live fields, and the field the gate reclassified', async () => {    const { ctx: context } = harness()
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
        // The pair that decides whether a delegation is answered from a settled transcript or from a prefix
        // of one. Live, because a delegation reads them at the moment it is answered: a change must reach the
        // next delegation rather than the next boot.
        key: 'realtime-agent.transcriptQuietMs',
        owner: 'realtime-agent',
        field: 'transcriptQuietMs',
        kind: 'number',
        scope: 'live',
        describe: 'How long the transcript must be quiet before a delegation is answered from it',
        value: 500,
      },
      {
        key: 'realtime-agent.transcriptSettleCapMs',
        owner: 'realtime-agent',
        field: 'transcriptSettleCapMs',
        kind: 'number',
        scope: 'live',
        describe: 'Longest a delegation waits for the transcript to settle',
        value: 1_500,
      },
      {
        // Read at each call of the journal tool, so a change reaches the next question rather than the
        // next boot: this is the size of one answer, not of the record.
        key: 'realtime-agent.journalEntries',
        owner: 'realtime-agent',
        field: 'journalEntries',
        kind: 'number',
        scope: 'live',
        describe: 'Most journal entries voice_journal returns in one call',
        value: 25,
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
    apply(context, Config({ provider: 'fake', autoStart: true, ...FAST_SETTLE }) as RealtimeAgentConfig)
    await tick()

    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'first line', final: true })
    expect(context.realtime.settings.apply('realtime-agent.maxTranscriptChars', '10')).toMatchObject({ ok: true })
    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'second line', final: true })

    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    // The fragments arrived before the delegation, so the request waits for the quiet this suite's policy
    // asks for before it is built from them.
    await tickFor(60)

    // The budget is read at eviction, so the change reached the very next fragment rather than the next
    // conversation — which is the difference between a live field and a field that looks live.
    expect(asked[0]?.transcript).toEqual([{ kind: 'input', text: 'second line' }])
  })

  it('applies a changed settle window to the next delegation, rather than to the next boot', async () => {
    // Both fields that decide whether a request is built from a settled transcript. They are read at the moment
    // a delegation is answered, so a change has to reach the *next* delegation: a copy taken when the plugin
    // mounted would make the change look applied while the request still waited the old number.
    const { ctx: context, adapter, journal } = harness()
    context.on('realtime-agent/delegation', () => ({ text: 'ok', mode: 'spoken' as const }))
    apply(context, Config({ provider: 'fake', autoStart: true, ...FAST_SETTLE }) as RealtimeAgentConfig)
    await tick()

    adapter.handlers?.onTranscript?.({ kind: 'input', text: 'is staging ok?', final: true })
    expect(context.realtime.settings.apply('realtime-agent.transcriptQuietMs', '80')).toMatchObject({ ok: true })
    expect(context.realtime.settings.apply('realtime-agent.transcriptSettleCapMs', '900')).toMatchObject({ ok: true })

    adapter.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await tickFor(160)

    // 80 ms of quiet was asked for with the fragment already in the buffer, so the wait cannot have been the
    // 25 this suite mounted with: the registry's change reached the delegation, not the next boot.
    //
    // The bound is 60 rather than 80 because the wait is *polled*: `SETTLE_POLL_MS` samples `now` to decide
    // whether the quiet window has elapsed, so the measured wait can land a millisecond under the number that
    // was asked for (measured: 79 against a requested 80, intermittently and more often under load). What this
    // asserts is that the change reached the delegation at all, and 60 splits that from the 25 the suite
    // mounted with by a margin no scheduling noise can cross.
    const settled = journal.snapshot().find(entry => entry.kind === 'transcript.settled')
    expect(Number((settled?.detail as { waitedMs?: string }).waitedMs)).toBeGreaterThan(60)
    expect(context.realtime.settings.apply('realtime-agent.transcriptQuietMs', '0'))
      .toMatchObject({ code: 'INVALID_SETTING', reason: /transcriptQuietMs must be a positive whole number/ })
  })

  it('refuses a budget that is not a positive whole number, naming the field', async () => {
    const { ctx: context } = harness()
    apply(context, Config({ provider: 'fake' }) as RealtimeAgentConfig)
    expect(context.realtime.settings.apply('realtime-agent.delegationTimeoutMs', '0'))
      .toMatchObject({ code: 'INVALID_SETTING', reason: /delegationTimeoutMs must be a positive whole number/ })
    expect(context.realtime.settings.apply('realtime-agent.maxTranscriptChars', 'lots'))
      .toMatchObject({ code: 'INVALID_SETTING' })
    expect(context.realtime.settings.apply('realtime-agent.journalEntries', 'lots'))
      .toMatchObject({ code: 'INVALID_SETTING', reason: /journalEntries must be a positive whole number/ })
  })

  it('applies a changed journal ceiling to the next call, rather than to the next boot', async () => {
    // The field is read when the tool is called, so a change has to reach the next question: a copy taken
    // when the plugin mounted would make the change look applied while the answer kept its old size.
    const { ctx: context, tools } = harness()
    apply(context, Config({ provider: 'fake', autoStart: true }) as RealtimeAgentConfig)
    await tick()

    expect(context.realtime.settings.apply('realtime-agent.journalEntries', '1')).toMatchObject({ ok: true })

    const journalTool = tools.registered.find(definition => definition.name === 'voice_journal')
    const answer = await journalTool!.execute({}, {} as never) as JournalToolAnswer
    expect(answer.entries).toHaveLength(1)
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
