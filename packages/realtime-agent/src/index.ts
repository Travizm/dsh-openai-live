/**
 * The realtime agent consumer: answers what the voice model delegates.
 *
 * A **function plugin** on the `dsh-realtime` seam. It holds a live session, records the conversation,
 * and when the model raises a delegation it asks the application — over the event bus, with `serial`
 * semantics so the first responder to answer wins — and delivers the result, or says plainly that it
 * cannot be handled.
 *
 * Per the harness convention it named-exports `name` / `inject` / `Config` / `apply` and has **no
 * default export** — adding one makes the Loader discard this plugin's namespace, so the plugin would
 * load and contribute nothing.
 *
 * An application answers by listening:
 *
 * ```ts
 * ctx.on('realtime-agent/delegation', (request) => {
 *   return { text: lookItUp(request.transcript), mode: 'spoken' }
 * })
 * ```
 *
 * @module dsh-realtime-agent
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { RealtimeDelegation, RealtimeSession, RealtimeSessionHandlers, RealtimeTranscript } from 'dsh-realtime'
import { answerDelegation, type DelegationAsker } from './bridge.ts'
import { TranscriptBuffer } from './transcript.ts'
import type { DelegationAnswer, DelegationRequest, RealtimeAgentConfig } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Dispatched when the voice model delegates work, awaited with **serial** semantics: listeners run
     * in order, and the first to return a non-empty answer wins.
     *
     * Return `undefined` to decline and let a later responder try. If every listener declines — or none
     * is registered — the model is told out loud that the request could not be handled.
     */
    'realtime-agent/delegation'(request: DelegationRequest): DelegationAnswer | undefined | Promise<DelegationAnswer | undefined>
    /** A session-scoped failure the adapter contained rather than throwing. */
    'realtime-agent/error'(error: Error): void
  }
}

export * from './types.ts'
export { answerDelegation, boundAppend, UNANSWERED_NOTICE, type DelegationAsker } from './bridge.ts'
export { TranscriptBuffer } from './transcript.ts'

/** Plugin name, as it appears in Loader diagnostics. */
export const name = 'realtime-agent'

/** This plugin drives the realtime seam, so it waits for it. */
export const inject = ['realtime']

/**
 * Validated configuration.
 *
 * `autoStart` defaults to `false`: mounting this plugin must not, by itself, open a socket or spend
 * credit. `voice` and `instructions` are omitted unless set, so the provider default applies rather
 * than an empty string the provider would reject.
 */
export const Config = Schema.object({
  provider: Schema.string().default('openai-live').description('Registered realtime route to open a session on'),
  model: Schema.string().default('gpt-live-1').description('Voice model to request'),
  voice: Schema.string().required(false).description('Output voice; omitted leaves the provider default'),
  instructions: Schema.string().required(false).description('Opening instructions for the live session'),
  autoStart: Schema.boolean().default(false).description('Open a session as soon as the plugin mounts'),
  delegationTimeoutMs: Schema.number().default(10_000).description('Bound on waiting for a responder'),
  maxTranscriptChars: Schema.number().default(6_000).description('Character budget for the delegation transcript'),
})

/** What {@link createHandlers} needs. Injected rather than closed over, so the handlers are testable. */
export interface HandlerDeps {
  /** The conversation recorded so far. */
  readonly transcript: TranscriptBuffer
  /** The live session a handler should act on, or `undefined` when there is none. */
  readonly session: () => RealtimeSession | undefined
  /** How to reach a responder. */
  readonly ask: DelegationAsker
  /** Bound on waiting for one. */
  readonly timeoutMs: number
  /** Called when the session ended, so the caller can drop its reference. */
  readonly onClosed: () => void
  /** Where a session-scoped failure is reported. */
  readonly onSessionError: (error: Error) => void
}

/**
 * Build the session handlers.
 * @param deps - the session, the transcript and the asker.
 * @returns handlers the adapter can invoke for the life of the session.
 */
export function createHandlers(deps: HandlerDeps): RealtimeSessionHandlers {
  return {
    onTranscript: (fragment: RealtimeTranscript): void => {
      deps.transcript.append(fragment.kind, fragment.text, fragment.final)
    },
    onDelegation: (delegation: RealtimeDelegation): void => {
      const session = deps.session()
      // A delegation cannot be answered into a session that is gone. Speaking into a closed transport
      // would be a failure raised from inside a handler, which is the worst place to raise one.
      if (session === undefined) return
      // Handlers are synchronous, so the answer is dispatched rather than awaited. A rejection is
      // reported rather than thrown: an unanswered delegation is already the failure path.
      void answerDelegation(session, delegation, deps.transcript.lines(), deps.ask, deps.timeoutMs)
        .catch(deps.onSessionError)
    },
    onClosed: (): void => { deps.onClosed() },
    onError: (error: Error): void => { deps.onSessionError(error) },
  }
}

/**
 * Hold a session and bridge what the voice model delegates.
 * @param ctx - the Cordis context, which must already provide the `realtime` service.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: RealtimeAgentConfig): void {
  const transcript = new TranscriptBuffer(config.maxTranscriptChars)
  let session: RealtimeSession | undefined

  const handlers = createHandlers({
    transcript,
    session: () => session,
    ask: request => ctx.serial('realtime-agent/delegation', request),
    timeoutMs: config.delegationTimeoutMs,
    onClosed: () => { session = undefined },
    onSessionError: (error) => { ctx.emit('realtime-agent/error', error) },
  })

  if (config.autoStart) {
    // `apply` is synchronous, so a failed open cannot be thrown from it — it is reported on the bus
    // instead. The plugin stays valid and a later start may succeed.
    void ctx.realtime.session({
      provider: config.provider,
      model: config.model,
      ...config.voice === undefined ? {} : { voice: config.voice },
      ...config.instructions === undefined ? {} : { instructions: config.instructions },
      handlers,
    }).then((opened) => { session = opened }, (error: Error) => { ctx.emit('realtime-agent/error', error) })
  }
}
