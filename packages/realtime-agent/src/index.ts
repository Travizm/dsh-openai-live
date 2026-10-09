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
import type { RealtimeDelegation, RealtimeDelegationSettlement, RealtimeSession, RealtimeSessionHandlers, RealtimeTranscript } from 'dsh-realtime'
import { answerDelegation, type DelegationAppend, type DelegationAsker } from './bridge.ts'
import { voiceToolDefinitions } from './tools.ts'
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
    /**
     * A delegated turn settled **without** an answer, and why.
     *
     * Emitted by whichever application attempted the turn, so a turn that went quiet is described
     * rather than merely counted: `declined` (there was nothing to ask), `refused` (the session
     * controller rejected the admission, and `reason` is what it said — already redacted, because
     * this is the first text the plugin relays that it did not author) or `timeout` (admitted, and
     * nothing came back inside the bound).
     *
     * An **answered** turn is not settled here: the answer is its own report. This is the seam the
     * diagnostics layer reads from — it exists so that a refusal can reach a journal, a route or a
     * user's ear without any of them re-deriving why the turn produced nothing.
     */
    'realtime-agent/delegation-settled'(settlement: RealtimeDelegationSettlement): void
    /**
     * Output audio: PCM16 in the session's declared output format.
     *
     * Emitted once per provider delta, in order, with no buffering. A consumer that cannot keep up is
     * expected to drop frames rather than queue them — a queue that grows while nothing drains it
     * presents first as latency and then as an unbounded allocation.
     */
    'realtime-agent/audio'(pcm16: Uint8Array): void
    /**
     * Input audio: capture frames to write to the open session.
     *
     * The host-side half of the microphone path. A capture device belongs in a client half, which
     * cannot reach this context directly, so frames arrive here as an event and the agent keeps the
     * only object that can write them. Emitted with no session open, this is dropped — not buffered.
     */
    'realtime-agent/mic'(pcm16: Uint8Array): void
    /**
     * Open the voice session.
     *
     * Emitted by a transport when an authenticated client arrives, so that connecting a microphone is
     * enough to be heard — with no profile option and no dependence on a model choosing to call
     * `voice_start`. The session belongs to the agent, so the transport asks rather than opens one itself.
     */
    'realtime-agent/start'(): void
    /**
     * Close the voice session.
     *
     * Emitted by a transport when its last client goes away, including when the transport itself is
     * disposed — a session outliving the microphone that asked for it is a socket nobody is listening to.
     */
    'realtime-agent/stop'(): void
  }
}

export * from './types.ts'
export { answerDelegation, boundAppend, UNANSWERED_NOTICE, type DelegationAsker } from './bridge.ts'
export { TranscriptBuffer } from './transcript.ts'
export { voiceToolDefinitions, type VoiceToolDeps } from './tools.ts'

/** Plugin name, as it appears in Loader diagnostics. */
export const name = 'realtime-agent'

/** This plugin drives the realtime seam and publishes tools, so it waits for both. */
export const inject = ['realtime', 'tools']

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
  /** Where output audio is delivered. Called once per provider delta. */
  readonly onAudio: (pcm16: Uint8Array) => void
  /**
   * Where an accepted append is reported.
   *
   * An acknowledgement, not a delivery: it says the provider took the append, and nothing about
   * whether a speaker ever rendered it. See the seam's session contract and invariant 6.
   */
  readonly onAcknowledged: (append: DelegationAppend, delegationId: string) => void
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
      void answerDelegation(
        session,
        delegation,
        deps.transcript.lines(),
        deps.ask,
        deps.timeoutMs,
        deps.onAcknowledged,
      ).catch(deps.onSessionError)
    },
    onAudio: (pcm16: Uint8Array): void => { deps.onAudio(pcm16) },
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
  // This plugin owns the session, so it is the only one that can honestly write these entries. The audio
  // route emits a *request* to open a session and deliberately records nothing for it: recording a
  // request as an event is how a journal starts lying.
  const journal = ctx.realtime.journal
  let session: RealtimeSession | undefined

  const handlers = createHandlers({
    transcript,
    session: () => session,
    ask: request => ctx.serial('realtime-agent/delegation', request),
    timeoutMs: config.delegationTimeoutMs,
    onClosed: () => {
      session = undefined
      journal.record('session.closed', {})
    },
    onSessionError: (error) => {
      ctx.emit('realtime-agent/error', error)
      // The class, never the message. A provider error can carry the key it refused, and this plugin
      // holds no credential to redact against — so it records the category and leaves the text to the
      // plugin that does. Naming the setting instead of repeating the value, applied to a log line.
      journal.record('session.failed', { class: error.name })
    },
    onAudio: (pcm16) => {
      ctx.emit('realtime-agent/audio', pcm16)
      // Handed to the transport: all the host can observe, and no more (invariant 6).
      journal.record('speech.sent', { bytes: String(pcm16.byteLength) })
    },
    onAcknowledged: (append, delegationId) => {
      // The one place an acknowledgement can honestly be recorded: the seam's appends resolve on the
      // provider's confirmation, not on the send. Note what is deliberately absent beside it — no entry
      // anywhere claims the audio was heard, which is the pair invariant 6 exists to keep apart.
      journal.record('append.acknowledged', { append, delegationId })
    },
  })

  /**
   * Open a session, or return the one already open.
   *
   * Idempotent on purpose: `voice_start` is safe to call repeatedly, and a model that calls it twice
   * must not end up with two live sessions it cannot see.
   */
  const open = async (): Promise<RealtimeSession> => {
    const current = session
    if (current !== undefined) return current
    const opened = await ctx.realtime.session({
      provider: config.provider,
      model: config.model,
      ...config.voice === undefined ? {} : { voice: config.voice },
      ...config.instructions === undefined ? {} : { instructions: config.instructions },
      handlers,
    })
    session = opened
    journal.record('session.opened', { provider: config.provider, model: config.model })
    return opened
  }

  /**
   * Close the session, dropping the reference first.
   *
   * Dropping it before the close settles means a delegation arriving during teardown is ignored rather
   * than answered into a transport that is going away.
   */
  const stop = async (): Promise<void> => {
    const current = session
    session = undefined
    await current?.close()
  }

  // Tools are an effect, like every other contribution this plugin makes: the fiber that mounted them
  // releases them, so there is no separate teardown path to forget.
  ctx.effect(function* () {
    const disposers = voiceToolDefinitions({ session: () => session, start: open, stop })
      .map(definition => ctx.tools.register(definition))
    yield () => { for (const dispose of disposers) dispose() }
  }, 'realtime-agent.tools')

  // The microphone seam. Output audio leaves through a handler the adapter already calls; input had no
  // such route, because the object that captures it — a client half — cannot reach this context. So the
  // frames arrive as an event, and the agent keeps the only object that can write them.
  ctx.effect(function* () {
    const dispose = ctx.on('realtime-agent/mic', (pcm16: Uint8Array) => {
      const current = session
      // No session: a capture device that starts before `voice_start` must not throw from inside a
      // listener, and must not buffer either — see the event's own contract.
      if (current === undefined) return
      try {
        current.sendAudio(pcm16)
      } catch (error) {
        // A write into a session that closed a moment ago is a race, not a fault, and the adapter's own
        // close handler decides what it means. Reporting beats throwing from a listener, which is the
        // worst place to raise one.
        ctx.emit('realtime-agent/error', error as Error)
      }
    })
    yield () => { dispose() }
  }, 'realtime-agent.mic')

  // Session requests from the transport. The route knows when an authenticated client connects and the
  // agent owns the session, so one event is the whole of the wiring between them.
  ctx.effect(function* () {
    const disposers = [
      ctx.on('realtime-agent/start', () => {
        // Fire-and-forget for the same reason `autoStart` is: a listener has no caller to catch a
        // rejection, and the failure is reported on the bus rather than thrown into one.
        void open().catch((error: Error) => { ctx.emit('realtime-agent/error', error) })
      }),
      ctx.on('realtime-agent/stop', () => {
        void stop().catch((error: Error) => { ctx.emit('realtime-agent/error', error) })
      }),
    ]
    yield () => { for (const dispose of disposers) dispose() }
  }, 'realtime-agent.session-requests')

  if (config.autoStart) {
    // `apply` is synchronous, so a failed open cannot be thrown from it — it is reported on the bus
    // instead. The plugin stays valid and a later start may succeed.
    void open().catch((error: Error) => { ctx.emit('realtime-agent/error', error) })
  }
}
