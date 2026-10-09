import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { DelegationRequest } from 'dsh-realtime-agent'
import RealtimeRuntime, { type Journal, type RealtimeDelegationSettlement } from 'dsh-realtime'
import * as responder from '../src/index.ts'
import { Config, apply } from '../src/index.ts'
import type { RealtimeResponderConfig } from '../src/types.ts'

/** A session controller that records what was admitted, and can be told to refuse — with any message. */
class FakeSessionController extends Service {
  readonly prompted: unknown[] = []
  refusal: string | undefined

  constructor(context: Context) {
    super(context, 'sessionController')
  }

  prompt(request: unknown): Promise<{ accepted: true }> {
    this.prompted.push(request)
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
  // The public surface the assertions use, not the class — see the note in `recordOutcome`: the repo
  // has two `Journal` declarations (built `lib/` and `src/`) and a private member makes them nominally
  // incompatible even though they are the same code.
  journal: Pick<Journal, 'record' | 'snapshot'>
} {
  const context = new Context()
  const controller = new FakeSessionController(context)
  const service = new RealtimeRuntime(context)
  const settled: RealtimeDelegationSettlement[] = []
  // The bus event the diagnostics layer reads from.
  context.on('realtime-agent/delegation-settled', (settlement) => { settled.push(settlement) })
  ctx = context
  return { context, controller, settled, journal: service.journal }
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

  it('defaults both budgets rather than leaving them undefined', () => {
    const resolved = Config({ sessionId: 'sess-1' }) as RealtimeResponderConfig
    expect(resolved.sessionId).toBe('sess-1')
    expect(resolved.maxPromptChars).toBe(4_000)
    expect(resolved.answerTimeoutMs).toBe(45_000)
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
      content: [{ type: 'text', text: 'is staging ok?' }],
    })

    // `session/event` listeners take (session, event); the session is unused here.
    context.emit('session/event', undefined as never, {
      type: 'assistant/message',
      sessionId: 'sess-1',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'Staging is green.' }] } },
    } as unknown as never)

    await expect(answer).resolves.toEqual({ text: 'Staging is green.', mode: 'spoken' })
    // An answered turn is its own report: settling it too would double-report a success.
    expect(settled).toEqual([])
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
    expect(() => context.emit('session/event', undefined as never, {} as unknown as never)).not.toThrow()
  })
})

describe('the settings it declares', () => {
  it('declares the four fields the gate calls live, and nothing else', () => {
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
    // which is what makes steering real rather than merely recorded.
    expect(controller.prompted.at(-1)).toMatchObject({ sessionId: 'sess-2' })
    context.emit('session/event', undefined as never, {
      type: 'assistant/message',
      sessionId: 'sess-1',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'from the old session' }] } },
    } as unknown as never)
    context.emit('session/event', undefined as never, {
      type: 'assistant/message',
      sessionId: 'sess-2',
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
