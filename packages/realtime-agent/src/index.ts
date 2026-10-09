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
import type { RealtimeDelegation, RealtimeDelegationProgress, RealtimeDelegationSettlement, RealtimeSession, RealtimeSessionHandlers, RealtimeTranscript } from 'dsh-realtime'
import { REALTIME_ERROR_CODES, RealtimeError } from 'dsh-realtime'
import { answerDelegation, type DelegationAppend, type DelegationAsker } from './bridge.ts'
import { voiceToolDefinitions } from './tools.ts'
import { TranscriptBuffer } from './transcript.ts'
import type { DelegationAnswer, DelegationRequest, RealtimeAgentConfig, RealtimeSessionRefusal, RealtimeSessionRequestOutcome, RealtimeVoiceStatus } from './types.ts'

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
     * One step of a delegated turn, on its way to an ear or to the model's own context.
     *
     * Emitted by whichever application is running the turn, as the steps happen — it is the only thing that
     * knows what the turn is doing. This plugin appends it, because it holds the session: `commentary` is
     * spoken aloud, `thinking` is carried silently, and the choice is the emitter's.
     *
     * A step for a delegation this plugin is **not** waiting on is dropped rather than appended: the
     * provider only accepts an append for a delegation it knows, and a finished turn's words must not be
     * spoken into a conversation that has moved on.
     */
    'realtime-agent/delegation-progress'(progress: RealtimeDelegationProgress): void
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
     *
     * Returns the request's **outcome** so a caller that is waiting for the answer can have it —
     * `ctx.serial` from the control channel — while the transport, which only *emits*, is unaffected.
     */
    'realtime-agent/start'(): RealtimeSessionRequestOutcome | undefined | Promise<RealtimeSessionRequestOutcome | undefined>
    /**
     * Close the voice session.
     *
     * Emitted by a transport when its last client goes away, including when the transport itself is
     * disposed — a session outliving the microphone that asked for it is a socket nobody is listening to.
     * Returns the outcome, for the same reason `realtime-agent/start` does.
     */
    'realtime-agent/stop'(): RealtimeSessionRequestOutcome | undefined | Promise<RealtimeSessionRequestOutcome | undefined>
    /**
     * The voice session's state — a **query**, so nothing emits it.
     *
     * `undefined` means no listener answered, which is the honest answer for a composition with no agent
     * row: it is distinguishable from a session that is merely closed, because the agent that is mounted
     * always answers.
     */
    'realtime-agent/status'(): RealtimeVoiceStatus | undefined | Promise<RealtimeVoiceStatus | undefined>
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
  /**
   * Bound on waiting for one, read at the moment the delegation is answered.
   *
   * An accessor because `delegationTimeoutMs` is a **live** field: the window the voice model waits in
   * can be changed while the plugin runs, and the change must apply to the next delegation rather than
   * to the next boot.
   */
  readonly timeoutMs: () => number
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
  /**
   * Called once a delegation arrives, before it is answered, with the session it is being answered on — so
   * a caller can tell which turns are still waiting, and *where* each one is waiting.
   */
  readonly onDelegationStarted?: (delegationId: string, session: RealtimeSession) => void
  /** Called once a delegation has finished, however it ended. */
  readonly onDelegationSettled?: (delegationId: string) => void
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
      // Marked waiting before the answer is dispatched, so a step that arrives while the turn is running is
      // appended rather than dropped for having beaten this line.
      deps.onDelegationStarted?.(delegation.id, session)
      // Handlers are synchronous, so the answer is dispatched rather than awaited. A rejection is
      // reported rather than thrown: an unanswered delegation is already the failure path.
      void answerDelegation(
        session,
        delegation,
        deps.transcript.lines(),
        deps.ask,
        deps.timeoutMs(),
        deps.onAcknowledged,
      ).catch(deps.onSessionError).finally(() => { deps.onDelegationSettled?.(delegation.id) })
    },
    onAudio: (pcm16: Uint8Array): void => { deps.onAudio(pcm16) },
    onClosed: (): void => { deps.onClosed() },
    onError: (error: Error): void => { deps.onSessionError(error) },
  }
}

/**
 * A count this plugin can actually be run with: a whole, positive number.
 *
 * Local to the plugin rather than shared from the seam, deliberately: the reason text is part of this
 * plugin's own onboarding, and the seam has no business knowing that this plugin measures a timeout in
 * milliseconds and a transcript in characters.
 * @param field - the setting's own name, for the reason.
 * @param value - the proposed value.
 * @returns the value, when it is usable.
 */
function requireCount(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RealtimeError(`${field} must be a positive whole number`, REALTIME_ERROR_CODES.INVALID_SETTING)
  }
  return value
}

/**
 * Hold a session and bridge what the voice model delegates.
 * @param ctx - the Cordis context, which must already provide the `realtime` service.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: RealtimeAgentConfig): void {
  const journal = ctx.realtime.journal

  // What this plugin resolved, recorded so a journal can be read without the profile beside it — the question
  // that cost an evening was exactly "which voice did this ask for, and would it have opened on its own".
  // `instructions` is deliberately absent: it is authored text of unbounded length, and the journal records
  // what happened rather than copying the configuration into itself.
  journal.record('config.resolved', {
    plugin: 'dsh-realtime-agent',
    provider: config.provider,
    model: config.model,
    ...config.voice === undefined ? {} : { voice: config.voice },
    autoStart: String(config.autoStart),
    delegationTimeoutMs: String(config.delegationTimeoutMs),
    maxTranscriptChars: String(config.maxTranscriptChars),
  })

  /**
   * The two fields this plugin reads at the moment of use.
   *
   * `autoStart` is deliberately **not** here as a changeable value. Its only read site is the boot
   * below, so a running process has nothing that could honour a change; the gate was corrected to say
   * so, and it is registered below as restart-bound — which is what makes that correction bite rather
   * than merely being written down.
   */
  const live = { delegationTimeoutMs: config.delegationTimeoutMs, maxTranscriptChars: config.maxTranscriptChars }

  const transcript = new TranscriptBuffer(() => live.maxTranscriptChars)
  let session: RealtimeSession | undefined

  // The live fields `docs/control-plane-fields.md` lists for this plugin, plus the one it reclassified:
  // `autoStart` is registered without a setter, so a change to it is refused with the restart it needs
  // instead of being accepted and quietly ignored.
  ctx.effect(function* () {
    const release = ctx.realtime.settings.register(name, [
      {
        field: 'delegationTimeoutMs',
        kind: 'number',
        scope: 'live',
        describe: 'How long the voice model waits for a responder',
        get: () => live.delegationTimeoutMs,
        set: (value: number) => { live.delegationTimeoutMs = requireCount('delegationTimeoutMs', value) },
      },
      {
        field: 'maxTranscriptChars',
        kind: 'number',
        scope: 'live',
        describe: 'Character budget for the transcript carried on a delegation',
        get: () => live.maxTranscriptChars,
        set: (value: number) => { live.maxTranscriptChars = requireCount('maxTranscriptChars', value) },
      },
      {
        field: 'autoStart',
        kind: 'boolean',
        scope: 'restart',
        describe: 'Open a session as soon as the plugin mounts',
        get: () => config.autoStart,
      },
    ])
    yield () => { release() }
  }, 'realtime-agent.settings')

  /**
   * The one place an acknowledgement can honestly be recorded: the seam's appends resolve on the provider's
   * confirmation, not on the send. Note what is deliberately absent beside it — no entry anywhere claims the
   * audio was heard, which is the pair invariant 6 exists to keep apart. Shared with the narration path, so
   * a spoken step and an answer are accounted for by the same rule.
   */
  const onAcknowledged = (append: DelegationAppend, delegationId: string): void => {
    journal.record('append.acknowledged', { append, delegationId })
  }

  /**
   * The delegations still waiting for an answer, with the session each one is being answered on.
   *
   * The session is stored *with* the id rather than read back from the plugin when a step arrives, and that
   * is not a micro-optimisation: it collapses two conditions into one. "Nothing is waiting on this" and
   * "there is no session to speak into" cannot drift apart into two guards, one of which — the session
   * dropped while its id is still waiting — no sequence of events can actually produce.
   */
  const waiting = new Map<string, RealtimeSession>()

  const handlers = createHandlers({
    transcript,
    session: () => session,
    ask: request => ctx.serial('realtime-agent/delegation', request),
    timeoutMs: () => live.delegationTimeoutMs,
    onClosed: () => {
      session = undefined
      waiting.clear()
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
    onDelegationStarted: (delegationId, current) => { waiting.set(delegationId, current) },
    onDelegationSettled: (delegationId) => { waiting.delete(delegationId) },
    onAcknowledged,
  })

  /**
   * Narrate a delegated turn's steps, on the session that is running it.
   *
   * A contribution like any other, so the fiber that registered it releases it. The emitter decides whether
   * a step is spoken or silent — this half only carries it, because the session belongs here and nowhere
   * else does.
   *
   * A failed append is a **dropped step**, not a broken turn: it is recorded so it is not silent, and it
   * must not be confused with an answer that never arrived.
   */
  ctx.effect(function* () {
    const dispose = ctx.on('realtime-agent/delegation-progress', (progress: RealtimeDelegationProgress) => {
      // One condition, not two: the session a turn is waiting on *is* the authorisation to speak into it, and
      // it travels with the delegation. A step for anything else has nowhere to go — the provider refuses an
      // append for an id it does not know, and a finished turn's words must not be spoken into the next one.
      const current = waiting.get(progress.id)
      if (current === undefined) return
      const append = progress.channel === 'commentary'
        ? current.appendCommentary(progress.text, progress.id)
        : current.appendThinking(progress.text, progress.id)
      void append
        .then(() => { onAcknowledged(progress.channel, progress.id) })
        .catch(() => { journal.record('progress.dropped', { id: progress.id, channel: progress.channel }) })
    })
    yield () => { dispose() }
  }, 'realtime-agent.progress')

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

  /**
   * The session's state, as only this plugin can report it.
   *
   * With nothing open it answers with what a start *would* use, rather than with nothing: "no session,
   * and it would be `openai-live`/`gpt-live-1`" is a different — and more useful — answer than an
   * absence, and it is the one a status surface needs to render a sensible control.
   */
  const status = (): RealtimeVoiceStatus => {
    const current = session
    if (current === undefined) {
      return {
        open: false,
        provider: config.provider,
        model: config.model,
        ...config.voice === undefined ? {} : { voice: config.voice },
      }
    }
    return {
      open: true,
      provider: current.started.provider,
      model: current.started.model,
      ...current.started.voice === undefined ? {} : { voice: current.started.voice },
      sessionId: current.id,
    }
  }

  /**
   * Classify a failed request, carrying what a caller can act on and never the message.
   *
   * A seam failure carries its machine code and the remedy written to be relayed; anything else carries
   * its **class** alone. The message is deliberately dropped: a provider error is exactly where a key
   * turns up, and this plugin holds no credential to redact against — the same reason its journal
   * records the class of a session failure rather than the text.
   * @param error - whatever the attempt threw.
   * @returns the structured refusal.
   */
  const refusalFor = (error: unknown): RealtimeSessionRefusal => {
    if (error instanceof RealtimeError) {
      return {
        code: error.code,
        ...error.detail?.remedy === undefined ? {} : { remedy: error.detail.remedy },
      }
    }
    return { class: error instanceof Error ? error.name : typeof error }
  }

  /**
   * Run a session request and report what it produced.
   *
   * The result is **returned as well as** reported on the bus, because a caller may be waiting for it:
   * the control channel dispatches these with `serial`, so `start` can answer with the session that
   * opened rather than with an acknowledgement that it asked. The failure still goes onto the bus, so a
   * transport that merely emits keeps the behaviour it always had.
   * @param attempt - the request to run.
   * @returns whether it achieved what it asked for, and the state afterwards.
   */
  const requestSession = async (attempt: () => Promise<unknown>, trigger?: string): Promise<RealtimeSessionRequestOutcome> => {
    // The ask is recorded by whoever asks: one that arrived as an event carries an asker that has already
    // recorded it, and one this plugin decided on its own has only this place to be seen. `trigger` is set
    // only for the second — an ask recorded twice reads as two requests.
    if (trigger !== undefined) journal.record('session.requested', { trigger })
    try {
      await attempt()
      return { ok: true, voice: status() }
    } catch (error) {
      ctx.emit('realtime-agent/error', error as Error)
      // The class, never the message, for the reason the provider's own error path gives: a provider error can
      // carry the key it refused, and this plugin holds no credential to redact against. Until this entry
      // existed, a refusal decided *before* the provider was ever called left no trace — the outcome was
      // returned to a caller that discarded it, so "asked to and could not" read exactly like "never asked".
      journal.record('session.failed', {
        class: error instanceof Error ? error.name : typeof error,
        ...trigger === undefined ? {} : { trigger },
      })
      return { ok: false, voice: status(), refusal: refusalFor(error) }
    }
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
  // agent owns the session, so one event is the whole of the wiring between them. Each listener returns
  // its outcome: `emit` ignores it, `serial` waits for it, and that is how the control channel can
  // answer *what happened* rather than *that it was asked*.
  ctx.effect(function* () {
    const disposers = [
      ctx.on('realtime-agent/start', () => requestSession(() => open())),
      ctx.on('realtime-agent/stop', () => requestSession(() => stop())),
      // A query, and the only listener that answers one. A mounted agent always answers, so a caller
      // that gets `undefined` from the dispatch learns the agent row is absent rather than guessing.
      ctx.on('realtime-agent/status', () => status()),
    ]
    yield () => { for (const dispose of disposers) dispose() }
  }, 'realtime-agent.session-requests')

  if (config.autoStart) {
    // `apply` is synchronous, so a failed open cannot be thrown from it — it is reported on the bus
    // instead. The plugin stays valid and a later start may succeed. Routed through `requestSession` so that
    // a boot-time refusal is *recorded* as well as emitted: this was a second path an open could fail on
    // without leaving an entry, and the one a restart lands on.
    void requestSession(() => open(), 'autostart')
  }
}
