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
