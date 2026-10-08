/**
 * The responder: answers what the voice model delegates, by asking the agent.
 *
 * An **application**, in the seam's vocabulary. `dsh-realtime-agent` publishes a delegation and asks the
 * bus for an answer; this plugin answers by admitting a turn to a real DSH session and returning the
 * agent's reply for the voice model to speak. Without a listener the model says, out loud, that it
 * cannot take care of the request — which is honest and useless.
 *
 * Per the harness convention it named-exports `name` / `inject` / `Config` / `apply` and has **no
 * default export**.
 *
 * ## The bound, stated plainly
 *
 * A DSH agent turn can run for minutes. The delegation asking for the answer is bounded (the agent's
 * `delegationTimeoutMs`), and so is this responder's `answerTimeoutMs`. **The smaller bound decides what
 * is heard.** Waiting for a long turn therefore means raising both — the voice model waits in silence
 * meanwhile — or the follow-up this plugin does not yet do: acknowledge immediately and speak the result
 * when it lands. The primitives exist (`appendThinking` for silent progress, `commentary.append` for
 * speech, both against the same delegation id); what is unverified is whether the provider holds a
 * delegation open long enough for a late append.
 *
 * @module dsh-realtime-responder
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { DelegationAnswer, DelegationRequest } from 'dsh-realtime-agent'
import { createTurnRunner } from './turn.ts'
import type { RealtimeResponderConfig, SessionEventLike } from './types.ts'

export * from './types.ts'
export { answerText, createTurnRunner, promptFrom, type TurnDeps } from './turn.ts'

/**
 * The slice of the session controller this plugin uses, described structurally rather than imported.
 *
 * Importing the controller package would augment `Context` with its own declaration for the same
 * property, and two declarations of one property with different types is a compile error — a
 * dependency taken purely to borrow a type, in exchange for a collision. This plugin needs four fields
 * of one method; it states those four fields and takes no dependency.
 */
interface SessionControllerLike {
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }): Promise<{ readonly accepted: true }>
}

/** Plugin name, as it appears in Loader diagnostics. */
export const name = 'realtime-responder'

/**
 * This plugin answers by admitting a turn, so it needs the session controller. Declared rather than
 * probed: a responder with no door is a plugin that loads and silently never answers, which is worse
 * than one that visibly waits for the service it named.
 */
export const inject = ['sessionController']

/** Validated configuration. */
export const Config = Schema.object({
  sessionId: Schema.string().description('DSH session the voice conversation is attached to'),
  maxPromptChars: Schema.number().default(4_000).description('Character budget for the prompt handed to the agent'),
  answerTimeoutMs: Schema.number().default(45_000).description('How long to wait for the agent before declining'),
})

/**
 * Register the responder on the delegation bus.
 * @param ctx - the Cordis context, which must provide `sessionController`.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: RealtimeResponderConfig): void {
  const controller = (ctx as unknown as { sessionController: SessionControllerLike }).sessionController

  const run = createTurnRunner({
    sessionId: config.sessionId,
    maxPromptChars: config.maxPromptChars,
    answerTimeoutMs: config.answerTimeoutMs,
    admit: async (text: string): Promise<void> => {
      await controller.prompt({
        requestId: `realtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: config.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
    },
    // `session/event` listeners are called with `(session, event)` — the event is the second argument,
    // which is only discoverable from the harness's own listener type.
    subscribe: (listener) => ctx.on('session/event', (_session: unknown, event: unknown) => {
      listener(event as SessionEventLike)
    }),
  })

  // A listener is a contribution like any other: the fiber that registered it releases it, so there is
  // no separate teardown path to forget.
  ctx.effect(function* () {
    const dispose = ctx.on(
      'realtime-agent/delegation',
      async (request: DelegationRequest): Promise<DelegationAnswer | undefined> => {
        const text = await run(request)
        return text === undefined ? undefined : { text, mode: 'spoken' }
      },
    )
    yield () => { dispose() }
  }, 'realtime-responder.delegation')
}
