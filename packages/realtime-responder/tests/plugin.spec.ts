import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { DelegationRequest } from 'dsh-realtime-agent'
import RealtimeRuntime, { type Journal, type RealtimeDelegationProgress, type RealtimeDelegationSettlement } from 'dsh-realtime'
import * as responder from '../src/index.ts'
import { Config, apply } from '../src/index.ts'
import type { RealtimeResponderConfig } from '../src/types.ts'

/** A session controller that records what was admitted, and can be told to refuse — with any message. */
class FakeSessionController extends Service {
  readonly prompted: unknown[] = []
  /** The signals the responder passed, so a test can assert the one the harness requires is actually sent. */
  readonly signals: (AbortSignal | undefined)[] = []
  refusal: string | undefined

  constructor(context: Context) {
    super(context, 'sessionController')
  }

  prompt(request: unknown, signal?: AbortSignal): Promise<{ accepted: true }> {
    this.prompted.push(request)
    this.signals.push(signal)
    const refusal = this.refusal
    if (refusal !== undefined) return Promise.reject(new Error(refusal))
    return Promise.resolve({ accepted: true as const })
  }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/**
 * A context with both services this plugin injects: a session controller under its own name, and the
 * real seam. The seam is mounted rather than stubbed because the responder writes into the journal it
 * *finds* there — a fake would prove the calls happen and say nothing about whether they land in the
 * instance the diagnostics route serves.
 */
function harness(): {
  context: Context
  controller: FakeSessionController
  settled: RealtimeDelegationSettlement[]
  /** The narrated steps the responder put on the bus, in order. */
  progress: RealtimeDelegationProgress[]
  // The public surface the assertions use, not the class — see the note in `recordOutcome`: the repo
  // has two `Journal` declarations (built `lib/` and `src/`) and a private member makes them nominally
  // incompatible even though they are the same code.
  journal: Pick<Journal, 'record' | 'snapshot'>
} {
  const context = new Context()
  const controller = new FakeSessionController(context)
  const service = new RealtimeRuntime(context)
  const settled: RealtimeDelegationSettlement[] = []
  const progress: RealtimeDelegationProgress[] = []
  // The bus events the diagnostics layer reads from.
  context.on('realtime-agent/delegation-settled', (settlement) => { settled.push(settlement) })
  context.on('realtime-agent/delegation-progress', (step) => { progress.push(step) })
  ctx = context
  return { context, controller, settled, progress, journal: service.journal }
}

/** Planted in the controller's rejection. Assembled, not written — see `redact.spec.ts`. */
const SENTINEL_KEY = 'sk-' + 'sentinelmustneverappear0001'
const SENTINEL_TEXT = 'sentinelmustneverappear'

const request = {
  id: 'item_1',
  offsetMs: 0,
  sessionId: 'sess-1',
  transcript: [{ kind: 'input', text: 'is staging ok?' }],
} as unknown as DelegationRequest

describe('plugin shape', () => {
  it('named-exports its contract and has no default export', () => {
    // A default export makes the Loader discard a function plugin's namespace: it loads and
    // contributes nothing, which is the quietest possible failure.
    expect(responder.name).toBe('realtime-responder')
    // `realtime` is injected because the responder writes into the seam's journal: a turn that
    // produced nothing is exactly what a reader needs to find afterwards, and waiting for the seam is
    // better than loading without it and journaling into nothing.
    expect(responder.inject).toEqual(['sessionController', 'realtime'])
    expect('default' in responder).toBe(false)
    expect(typeof apply).toBe('function')
  })

  it('defaults both budgets, and the frame, rather than leaving them undefined', () => {
    const resolved = Config({ sessionId: 'sess-1' }) as RealtimeResponderConfig
    expect(resolved.sessionId).toBe('sess-1')
    expect(resolved.maxPromptChars).toBe(4_000)
    expect(resolved.answerTimeoutMs).toBe(45_000)
    // A frame that is absent is a session answering bare speech — the defect this default removes — so it
    // has to be a **default** and not an empty string the plugin reads as "no frame".
    expect(resolved.promptFrame).toBe(responder.DEFAULT_PROMPT_FRAME)
    expect(resolved.promptFrame.length).toBeGreaterThan(0)
  })
})

describe('answering a delegation', () => {
  it('admits a turn to the configured session and speaks the reply', async () => {
    const { context, controller, settled } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    const answer = context.serial('realtime-agent/delegation', request)
    await Promise.resolve()

    expect(controller.prompted).toHaveLength(1)
    expect(controller.prompted[0]).toMatchObject({
      sessionId: 'sess-1',
      mode: 'queue',
      // The frame travels with the question. This is the assertion that the plugin wires the configured
      // preamble into what it admits, rather than holding it in config and never reading it.
      content: [{ type: 'text', text: `${responder.DEFAULT_PROMPT_FRAME}\nis staging ok?` }],
    })

    // `session/event` listeners take (session, event): the owning session is the FIRST argument, and the
    // event carries no session id of its own. Emitting it the harness's way is the point of this suite — a
    // hand-built event carrying `sessionId` is what hid a defect that made every real turn time out.
    context.emit('session/event', { id: 'sess-1' } as never, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'Staging is green.' }] } },
    } as unknown as never)

    await expect(answer).resolves.toEqual({ text: 'Staging is green.', mode: 'spoken' })
    // An answered turn is its own report: settling it too would double-report a success.
    expect(settled).toEqual([])
  })

  it('ignores a session event it cannot attribute, rather than answering on a guess', async () => {
    // A `session/event` with no identifiable session is what a listener receives from anything that is not
    // ours. Answering from one would speak another conversation's reply into this one, so the unmatched arm
    // refuses to guess rather than falling back to the configured session.
    const { context } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    const answer = context.serial('realtime-agent/delegation', request)
    await Promise.resolve()

    const payload = {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'from nowhere' }] } },
    } as unknown as never
    context.emit('session/event', undefined as never, payload)
    context.emit('session/event', { notAnId: 1 } as never, payload)

    // Neither was attributed, so the turn is still open — and the answer from the right session still lands.
    context.emit('session/event', { id: 'sess-1' } as never, payload)
    await expect(answer).resolves.toEqual({ text: 'from nowhere', mode: 'spoken' })
  })

  it('declines when nothing answers in time, so the agent speaks its own notice', async () => {
    const { context } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 5 }) as RealtimeResponderConfig)

    await expect(context.serial('realtime-agent/delegation', request)).resolves.toBeUndefined()
  })

  it('reports a timeout as a timeout, not as a refusal', async () => {
    const { context, settled } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 5 }) as RealtimeResponderConfig)

    await context.serial('realtime-agent/delegation', request)

    expect(settled).toEqual([{ id: 'item_1', sessionId: 'sess-1', outcome: 'timeout' }])
    // Nothing to report and nothing to invent.
    expect('reason' in settled[0]!).toBe(false)
  })

  it("speaks the controller's refusal, rather than hanging the voice model", async () => {
    const { context, controller } = harness()
    controller.refusal = 'session/model-unavailable'
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    // S1 story 3. Returning undefined here — the old behaviour — leaves the user hearing the agent's
    // flat notice and nothing else, which is the report this layer exists to replace.
    await expect(context.serial('realtime-agent/delegation', request)).resolves.toEqual({
      text: 'session/model-unavailable',
      mode: 'spoken',
    })
  })

  it("carries the controller's reason onto the bus — the answer to the open question", async () => {
    const { context, controller, settled } = harness()
    controller.refusal = 'session/model-unavailable'
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    await context.serial('realtime-agent/delegation', request)

    expect(settled).toEqual([{
      id: 'item_1',
      sessionId: 'sess-1',
      outcome: 'refused',
      reason: 'session/model-unavailable',
    }])
  })

  it('redacts a credential out of the reason before it reaches the bus', async () => {
    // Q3's sink, in miniature. The controller's own error is the first string this plugin relays that
    // it did not author, so a key echoed into it must not survive the trip.
    const { context, controller, settled } = harness()
    controller.refusal = `invalid api key ${SENTINEL_KEY} for model gpt-live-1`
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    await context.serial('realtime-agent/delegation', request)

    const reason = settled[0]!.reason ?? ''
    expect(reason).not.toContain(SENTINEL_TEXT)
    expect(reason).toContain('[redacted]')
    // The useful part survives: redaction must not cost the diagnosis.
    expect(reason).toContain('invalid api key')
    expect(reason).toContain('gpt-live-1')
  })

  it('redacts a credential out of the reason before it is spoken', async () => {
    // The same sink, reached by the other path. Speech leaves the process entirely — it is the one
    // surface with no second chance — so it is redacted where the reason is produced, not on the way out.
    const { context, controller } = harness()
    controller.refusal = `invalid api key ${SENTINEL_KEY} for model gpt-live-1`
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    const answer = await context.serial('realtime-agent/delegation', request) as { readonly text: string }

    expect(answer.text).not.toContain(SENTINEL_TEXT)
    expect(answer.text).toContain('[redacted]')
    expect(answer.text).toContain('invalid api key')
    expect(answer.text).toContain('gpt-live-1')
  })

  it('redacts a secret with no shape, when the profile names it', async () => {
    // The route's capability token is 32 random bytes of base64url — no prefix, no padding, no
    // structure — so the shape arm cannot find it and only naming it can. Derived at runtime, never
    // written: gitleaks fails on the entropy of a realistic token even with no prefix at all.
    const token = Buffer.from(Uint8Array.from({ length: 32 }, (_unused, index) => (index * 5 + 11) % 256)).toString('base64url')
    const { context, controller } = harness()
    controller.refusal = `upgrade refused for token ${token}`
    apply(context, Config({
      sessionId: 'sess-1',
      answerTimeoutMs: 1_000,
      redactSecrets: [token],
    }) as RealtimeResponderConfig)

    const answer = await context.serial('realtime-agent/delegation', request) as { readonly text: string }

    expect(answer.text).not.toContain(token)
    expect(answer.text).toContain('[redacted]')
    expect(answer.text).toContain('upgrade refused for token')
  })

  it('bounds the reason, so a controller error cannot flood the bus or the ear', async () => {
    const { context, controller, settled } = harness()
    controller.refusal = 'x'.repeat(600)
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    const answer = await context.serial('realtime-agent/delegation', request) as { readonly text: string }

    expect(answer.text).toHaveLength(500)
    expect(settled[0]!.reason).toHaveLength(500)
  })

  it('journals the turn, so a reader has the sequence and not just the last state', async () => {
    const { context, journal } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 5 }) as RealtimeResponderConfig)

    await context.serial('realtime-agent/delegation', request)

    // A timeout is two facts, recorded as two: the prompt got in, and the window closed without an
    // answer. Collapsing them is how "admitted and nothing came back" became indistinguishable from
    // "the controller refused", which is the silence S0 was spent on.
    expect(journal.snapshot().map(entry => entry.kind)).toEqual([
      'delegation.seen',
      'prompt.admitted',
      'window.elapsed',
    ])
  })

  it('journals a decline without recording a prompt that was never admitted', async () => {
    const { context, journal } = harness()
    apply(context, Config({ sessionId: 'sess-1' }) as RealtimeResponderConfig)
    // A transcript carrying no text is declined before the admission, so nothing was admitted and
    // nothing may be recorded as though it had been.
    const silent = { ...request, transcript: [{ kind: 'input', text: '' }] } as unknown as DelegationRequest

    await context.serial('realtime-agent/delegation', silent)

    expect(journal.snapshot().map(entry => entry.kind)).toEqual(['delegation.seen', 'prompt.declined'])
  })

  it('redacts what reaches the journal through the same door as the bus and the speech', async () => {
    const { context, controller, journal } = harness()
    controller.refusal = `invalid api key ${SENTINEL_KEY} for model gpt-live-1`
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    await context.serial('realtime-agent/delegation', request)

    const refused = journal.snapshot().find(entry => entry.kind === 'prompt.refused')
    expect(refused?.detail.reason).not.toContain(SENTINEL_TEXT)
    expect(refused?.detail.reason).toContain('[redacted]')
    expect(refused?.detail.reason).toContain('invalid api key')
  })

  it('releases its listener with the fiber that registered it', async () => {
    const { context } = harness()
    apply(context, Config({ sessionId: 'sess-1' }) as RealtimeResponderConfig)
    await context.fiber.dispose()
    ctx = undefined
    // Registrations are effects. If this ever needs a teardown path of its own, that path is what gets
    // forgotten on the day it matters.
    expect(() => context.emit('session/event', { id: 'sess-1' } as never, {} as unknown as never)).not.toThrow()
  })
})

describe('the signal the controller requires', () => {
  it('hands it one, because the harness throws without it', async () => {
    // The defect this pins was found in the live journal and not in any test, which is the point of pinning
    // it here: the harness reads `signal.throwIfAborted()` before it considers the request, so a one-argument
    // call throws on *every* delegation and arrives as a refusal whose reason reads like a plugin bug. The
    // structural interface this plugin declares had one parameter for two releases, and nothing offline
    // disagreed — only the real service did.
    const { context, controller } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    void context.serial('realtime-agent/delegation', request)
    await Promise.resolve()

    expect(controller.signals).toHaveLength(1)
    expect(controller.signals[0]).toBeInstanceOf(AbortSignal)
  })
})

describe('narrating a turn', () => {
  it('speaks a step from a tool call, addressed to the turn it belongs to', async () => {
    const { context, progress } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    const answer = context.serial('realtime-agent/delegation', request)
    await Promise.resolve()

    // A `tool/call` is **not** a surface event and carries no `surfaceOp`, so a filter copied from
    // `answerText` (`surfaceOp === 'append'`) would drop this silently and the narration would simply never
    // happen. It is emitted here the way the harness emits one, with the session as the first argument.
    context.emit('session/event', { id: 'sess-1' } as never, {
      type: 'tool/call',
      data: { name: 'read_file', arguments: '{"path":"/Users/asd/notes-that-must-not-be-spoken.md"}' },
    } as unknown as never)

    expect(progress).toEqual([{ id: 'item_1', channel: 'commentary', text: 'Reading a file.' }])
    // A tool's arguments are the model's own words: no phrase is ever derived from them, however tempting
    // the detail in them looks. The words come from the phrase table, keyed by the tool's name.
    expect(JSON.stringify(progress)).not.toContain('notes-that-must-not-be-spoken')

    context.emit('session/event', { id: 'sess-1' } as never, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'Staging is green.' }] } },
    } as unknown as never)
    await expect(answer).resolves.toEqual({ text: 'Staging is green.', mode: 'spoken' })
  })

  it('names an unknown tool by the fallback, and carries it silently when the setting is off', async () => {
    const { context, progress } = harness()
    apply(context, Config({
      sessionId: 'sess-1',
      answerTimeoutMs: 1_000,
      speakMilestones: false,
    }) as RealtimeResponderConfig)

    const answer = context.serial('realtime-agent/delegation', request)
    await Promise.resolve()
    context.emit('session/event', { id: 'sess-1' } as never, {
      type: 'tool/call',
      data: { name: 'a_tool_this_plugin_has_never_heard_of' },
    } as unknown as never)

    expect(progress).toEqual([{ id: 'item_1', channel: 'thinking', text: 'Working on it.' }])

    context.emit('session/event', { id: 'sess-1' } as never, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'Staging is green.' }] } },
    } as unknown as never)
    await expect(answer).resolves.toEqual({ text: 'Staging is green.', mode: 'spoken' })
  })
})

describe('the settings it declares', () => {
  it('declares the seven fields the gate calls live, and nothing else', () => {
    const { context } = harness()
    apply(context, Config({ sessionId: 'sess-1' }) as RealtimeResponderConfig)

    expect(context.realtime.settings.list()).toEqual([
      {
        key: 'realtime-responder.sessionId',
        owner: 'realtime-responder',
        field: 'sessionId',
        kind: 'string',
        scope: 'live',
        describe: 'The DSH session the voice conversation steers',
        // Present and empty: the surface reports candidates whenever the owner declared a source, and an
        // empty list is what a page with no session store mounted looks like — the panel renders a text
        // field for it rather than a picker with nothing in it.
        choices: [],
        value: 'sess-1',
      },
      {
        key: 'realtime-responder.answerTimeoutMs',
        owner: 'realtime-responder',
        field: 'answerTimeoutMs',
        kind: 'number',
        scope: 'live',
        describe: 'How long one turn waits for the agent before declining',
        value: 45_000,
      },
      {
        key: 'realtime-responder.maxPromptChars',
        owner: 'realtime-responder',
        field: 'maxPromptChars',
        kind: 'number',
        scope: 'live',
        describe: 'Character budget for the prompt handed to the agent',
        value: 4_000,
      },
      {
        // Write-only: the values are secrets, so the surface reports none of them.
        key: 'realtime-responder.redactSecrets',
        owner: 'realtime-responder',
        field: 'redactSecrets',
        kind: 'string-list',
        scope: 'live',
        describe: 'Values that must never be spoken or carried on the bus',
        value: undefined,
      },
      {
        key: 'realtime-responder.speakMilestones',
        owner: 'realtime-responder',
        field: 'speakMilestones',
        kind: 'boolean',
        scope: 'live',
        describe: 'Speak a step aloud as the agent works, rather than only carrying it silently',
        value: true,
      },
      {
        key: 'realtime-responder.maxSpokenMilestones',
        owner: 'realtime-responder',
        field: 'maxSpokenMilestones',
        kind: 'number',
        scope: 'live',
        describe: 'Most steps spoken aloud in one turn',
        value: 3,
      },
      {
        key: 'realtime-responder.milestoneIntervalMs',
        owner: 'realtime-responder',
        field: 'milestoneIntervalMs',
        kind: 'number',
        scope: 'live',
        describe: 'Shortest gap between two spoken steps',
        value: 4_000,
      },
    ])
  })

  it('steers the voice at another session without a restart, and answers from the new one', async () => {
    // The headline field. Before this, changing it cost two restarts and a false lead.
    const { context, controller, journal } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    expect(context.realtime.settings.apply('realtime-responder.sessionId', 'sess-2'))
      .toEqual({ ok: true, key: 'realtime-responder.sessionId', value: 'sess-2' })

    const answer = context.serial('realtime-agent/delegation', request)
    await Promise.resolve()

    // The next turn is admitted to the new session — and an answer only counts if it comes from there,
    // which is what makes steering real rather than merely recorded. The session is carried as the
    // listener's first argument, which is the only place it exists: this assertion is the one that would
    // have caught the answer path never matching anything.
    expect(controller.prompted.at(-1)).toMatchObject({ sessionId: 'sess-2' })
    context.emit('session/event', { id: 'sess-1' } as never, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'from the old session' }] } },
    } as unknown as never)
    context.emit('session/event', { id: 'sess-2' } as never, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'from the new session' }] } },
    } as unknown as never)

    await expect(answer).resolves.toEqual({ text: 'from the new session', mode: 'spoken' })
    // The change is in the record, by key and not by value. (It is not the *last* entry: the turn it
    // enabled wrote its own entries afterwards, which is exactly the sequence a reader wants.)
    expect(journal.snapshot()).toContainEqual(expect.objectContaining({
      kind: 'config.changed',
      detail: { key: 'realtime-responder.sessionId' },
    }))
  })

  it('applies a shorter answer window to the next turn', async () => {
    const { context, settled } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 45_000 }) as RealtimeResponderConfig)

    // Nobody answers within five milliseconds, so the next turn settles as a timeout — where the
    // configured forty-five seconds would have kept the voice model waiting.
    expect(context.realtime.settings.apply('realtime-responder.answerTimeoutMs', '5')).toMatchObject({ ok: true })
    await context.serial('realtime-agent/delegation', request)

    expect(settled).toEqual([{ id: 'item_1', sessionId: 'sess-1', outcome: 'timeout' }])
  })

  it('applies a smaller prompt budget to the next turn', async () => {
    const { context, controller } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)
    context.realtime.settings.apply('realtime-responder.maxPromptChars', '4')

    void context.serial('realtime-agent/delegation', request)
    await Promise.resolve()

    expect(controller.prompted.at(-1)).toMatchObject({ content: [{ type: 'text', text: 'is s' }] })
  })

  it('applies the narration settings, and refuses a value its own rules reject', async () => {
    const { context, progress } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    // Live, like the budgets beside them: a change lands on the next turn rather than at the next boot.
    expect(context.realtime.settings.apply('realtime-responder.speakMilestones', 'false')).toMatchObject({ ok: true })
    expect(context.realtime.settings.apply('realtime-responder.maxSpokenMilestones', '1')).toMatchObject({ ok: true })
    expect(context.realtime.settings.apply('realtime-responder.milestoneIntervalMs', '500')).toMatchObject({ ok: true })
    expect(context.realtime.settings.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'speakMilestones', value: false }),
      expect.objectContaining({ field: 'maxSpokenMilestones', value: 1 }),
      expect.objectContaining({ field: 'milestoneIntervalMs', value: 500 }),
    ]))

    // And the next turn honours them: switched off, a step is carried rather than spoken.
    const answer = context.serial('realtime-agent/delegation', request)
    await Promise.resolve()
    context.emit('session/event', { id: 'sess-1' } as never, {
      type: 'tool/call',
      data: { name: 'read_file' },
    } as unknown as never)
    expect(progress).toEqual([{ id: 'item_1', channel: 'thinking', text: 'Reading a file.' }])

    context.emit('session/event', { id: 'sess-1' } as never, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'Staging is green.' }] } },
    } as unknown as never)
    await expect(answer).resolves.toEqual({ text: 'Staging is green.', mode: 'spoken' })

    // A count is a positive whole number, and a refusal names the rule rather than being ignored.
    expect(context.realtime.settings.apply('realtime-responder.maxSpokenMilestones', '0'))
      .toMatchObject({ code: 'INVALID_SETTING', reason: /positive whole number/ })
    expect(context.realtime.settings.apply('realtime-responder.milestoneIntervalMs', 'soon'))
      .toMatchObject({ code: 'INVALID_SETTING' })
  })

  it('refuses a value its own rules reject, naming the rule', async () => {
    const { context, controller } = harness()
    apply(context, Config({ sessionId: 'sess-1' }) as RealtimeResponderConfig)

    expect(context.realtime.settings.apply('realtime-responder.sessionId', '')).toEqual({
      ok: false,
      key: 'realtime-responder.sessionId',
      code: 'INVALID_SETTING',
      reason: '"realtime-responder.sessionId" refused the change: sessionId must be non-empty',
    })
    expect(context.realtime.settings.apply('realtime-responder.answerTimeoutMs', '0'))
      .toMatchObject({ code: 'INVALID_SETTING', reason: /positive whole number of milliseconds/ })
    expect(context.realtime.settings.apply('realtime-responder.maxPromptChars', 'soon'))
      .toMatchObject({ code: 'INVALID_SETTING' })

    // Nothing was applied, so the next turn still goes where it did before.
    void context.serial('realtime-agent/delegation', request)
    await Promise.resolve()
    expect(controller.prompted.at(-1)).toMatchObject({ sessionId: 'sess-1' })
  })

  it('learns a new redaction secret at the moment it is set, not at the next boot', async () => {
    // The window this closes: a secret that becomes redactable only after a restart is one the journal
    // can write in the clear in between. Derived at runtime, never written — see `redact.spec.ts`.
    const nextSecret = Buffer.from(Uint8Array.from({ length: 32 }, (_unused, index) => (index * 7 + 3) % 256)).toString('base64url')
    const { context, controller, journal } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)
    controller.refusal = `upgrade refused for token ${nextSecret}`

    expect(context.realtime.settings.apply('realtime-responder.redactSecrets', JSON.stringify([nextSecret])))
      .toEqual({ ok: true, key: 'realtime-responder.redactSecrets', value: undefined })

    const answer = await context.serial('realtime-agent/delegation', request) as { readonly text: string }

    expect(answer.text).not.toContain(nextSecret)
    expect(answer.text).toContain('[redacted]')
    expect(answer.text).toContain('upgrade refused for token')
    const refused = journal.snapshot().find(entry => entry.kind === 'prompt.refused')
    expect(refused?.detail.reason).not.toContain(nextSecret)
    // The change is recorded by key, never by value.
    expect(JSON.stringify(journal.snapshot())).not.toContain(nextSecret)
  })

  it('withdraws its settings with the fiber that registered them', async () => {
    const { context } = harness()
    apply(context, Config({ sessionId: 'sess-1' }) as RealtimeResponderConfig)
    // Held before disposal: disposing the fiber unmounts the seam itself, so the surface has to be
    // reached through the reference rather than through the context.
    const settings = context.realtime.settings
    await context.fiber.dispose()
    ctx = undefined
    expect(settings.list()).toEqual([])
  })

  it('offers the live sessions as a picker’s candidates, read when the surface is asked', () => {
    // The headline control. The candidates come from the harness's own session store, which this plugin
    // reaches for *optionally*: a missing enhancement must never stop the responder answering, which is
    // why it is `ctx.get` rather than an `inject`.
    const { context } = harness()
    let ids = ['session-a', 'session-b']
    class FakeSessions extends Service {
      constructor(context: Context) { super(context, 'sessions') }
      list(): readonly { readonly id: string }[] { return ids.map(id => ({ id })) }
    }
    new FakeSessions(context)
    apply(context, Config({ sessionId: 'sess-1' }) as RealtimeResponderConfig)

    expect(context.realtime.settings.get('realtime-responder.sessionId')?.choices).toEqual(['session-a', 'session-b'])
    // Read at the moment it is asked, like every other live value here: a session created a second ago is
    // in the list, and no copy of it was taken when the plugin applied.
    ids = ['session-c']
    expect(context.realtime.settings.get('realtime-responder.sessionId')?.choices).toEqual(['session-c'])
  })
})
