import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { DelegationRequest } from 'dsh-realtime-agent'
import * as responder from '../src/index.ts'
import { Config, apply } from '../src/index.ts'
import type { RealtimeResponderConfig } from '../src/types.ts'

/** A session controller that records what was admitted, and can be told to refuse. */
class FakeSessionController extends Service {
  readonly prompted: unknown[] = []
  refuse = false

  constructor(context: Context) {
    super(context, 'sessionController')
  }

  prompt(request: unknown): Promise<{ accepted: true }> {
    this.prompted.push(request)
    if (this.refuse) return Promise.reject(new Error('session/model-unavailable'))
    return Promise.resolve({ accepted: true as const })
  }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** A context with a session controller mounted under the name this plugin injects. */
function harness(): { context: Context; controller: FakeSessionController } {
  const context = new Context()
  const controller = new FakeSessionController(context)
  ctx = context
  return { context, controller }
}

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
    expect(responder.inject).toEqual(['sessionController'])
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
    const { context, controller } = harness()
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
  })

  it('declines when nothing answers in time, so the agent speaks its own notice', async () => {
    const { context } = harness()
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 5 }) as RealtimeResponderConfig)

    await expect(context.serial('realtime-agent/delegation', request)).resolves.toBeUndefined()
  })

  it('declines when the controller refuses the turn, rather than hanging the voice model', async () => {
    const { context, controller } = harness()
    controller.refuse = true
    apply(context, Config({ sessionId: 'sess-1', answerTimeoutMs: 1_000 }) as RealtimeResponderConfig)

    await expect(context.serial('realtime-agent/delegation', request)).resolves.toBeUndefined()
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
