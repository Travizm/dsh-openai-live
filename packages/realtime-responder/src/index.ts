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
 * ## What a turn that produced no answer now says
 *
 * A settlement is emitted on `realtime-agent/delegation-settled` for every turn that is not answered:
 * *declined*, *refused* (with the controller's own reason, redacted) or *timeout*. That event is the
 * seam the diagnostics layer reads from — the journal, the route and the spoken failure all consume it
 * rather than re-deriving why a turn went quiet. The reason is redacted **as it is emitted**, because
 * this is the first string the plugin relays that it did not author.
 *
 * **A refusal is also spoken.** It is the one failure the controller gives words for, so its reason is
 * returned as the answer and the voice model says it; *declined* and *timeout* carry nothing to say and
 * keep the agent's own notice. Redaction applies to what is spoken exactly as it does to the bus: the
 * shape arm always, and the value arm for every secret the profile names in `redactSecrets`.
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
import type { RealtimeDelegationSettlement } from 'dsh-realtime'
import { redact, type Journal } from 'dsh-realtime'
import type { DelegationAnswer, DelegationRequest } from 'dsh-realtime-agent'
import { createTurnRunner, type TurnOutcome } from './turn.ts'
import type { RealtimeResponderConfig, SessionEventLike } from './types.ts'

export * from './types.ts'
export { answerText, createTurnRunner, promptFrom, type TurnDeps, type TurnOutcome } from './turn.ts'

/** Character ceiling on a reason carried on the bus, so a controller error cannot flood a consumer. */
const MAX_REASON_CHARS = 500

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
export const inject = ['sessionController', 'realtime']

/** Validated configuration. */
export const Config = Schema.object({
  sessionId: Schema.string().description('DSH session the voice conversation is attached to'),
  maxPromptChars: Schema.number().default(4_000).description('Character budget for the prompt handed to the agent'),
  answerTimeoutMs: Schema.number().default(45_000).description('How long to wait for the agent before declining'),
  redactSecrets: Schema.array(Schema.string()).default([]).description('Values that must never be spoken or carried on the bus'),
})

/**
 * One turn's settlement, as the bus carries it.
 *
 * Redacted and bounded **at emission** rather than by a later pass: the controller's reason is the
 * first text this plugin relays that it did not author, so it is safe by construction from the moment
 * it exists. A turn that was answered is not settled — the answer is its own report.
 * @param request - the delegation that was asked about.
 * @param outcome - how the turn ended; never `answered`, which the caller handles.
 * @param secrets - values that must not travel, whatever their spelling.
 * @returns the settlement to emit.
 */
function settlementFor(
  request: DelegationRequest,
  outcome: TurnOutcome,
  secrets: readonly string[],
): RealtimeDelegationSettlement {
  const settled = { id: request.id, sessionId: request.sessionId, outcome: outcome.kind }
  if (outcome.kind !== 'refused') return settled
  return { ...settled, reason: boundedReason(outcome.reason, secrets) }
}

/**
 * The controller's reason, redacted and bounded, exactly as it will be spoken.
 *
 * **No framing is added, on purpose.** The requirement is that the user hears *the reason* rather than
 * the model's flat refusal — putting a sentence of our own in front of it would be a second voice's
 * prose standing where the controller's words belong, and would make the useful part the second thing
 * heard. The agent's `boundAppend` applies the provider's own token cap on top of this character bound.
 * @param reason - the controller's own words.
 * @param secrets - values that must not be spoken, whatever their spelling.
 * @returns the text to speak: redacted first, then bounded, so a secret cannot survive truncation.
 */
function boundedReason(reason: string, secrets: readonly string[]): string {
  return redact(reason, secrets).slice(0, MAX_REASON_CHARS)
}

/**
 * Journal one turn's outcome, in the seam's own vocabulary.
 *
 * Deliberately more than one entry per turn where the turn did more than one thing. A `timeout` is
 * recorded as *admitted* and then *window elapsed*, because those are two facts and the difference
 * between them is the one a reader needs: an admission that produced nothing used to be
 * indistinguishable from a controller refusing outright, which is the silence this layer removes.
 * @param journal - the seam's journal, shared with every other plugin in the bundle. Typed as the
 *   public surface this plugin uses rather than as the class: `Journal` exists as two declarations in
 *   this repo (built `lib/` and `src/`), and a class with private members is nominally typed, so the
 *   two are not assignable to each other even though they are the same code.
 * @param request - the delegation the turn was for.
 * @param outcome - how the turn ended.
 */
function recordOutcome(
  journal: Pick<Journal, 'record'>,
  request: DelegationRequest,
  outcome: TurnOutcome,
): void {
  const id = { id: request.id }
  switch (outcome.kind) {
    case 'answered':
      journal.record('prompt.admitted', id)
      journal.record('answer.received', { ...id, chars: String(outcome.text.length) })
      return
    case 'refused':
      journal.record('prompt.refused', { ...id, reason: outcome.reason })
      return
    case 'declined':
      journal.record('prompt.declined', id)
      return
    case 'timeout':
      journal.record('prompt.admitted', id)
      journal.record('window.elapsed', id)
  }
}

/**
 * Register the responder on the delegation bus.
 * @param ctx - the Cordis context, which must provide `sessionController`.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: RealtimeResponderConfig): void {
  const controller = (ctx as unknown as { sessionController: SessionControllerLike }).sessionController
  const journal = ctx.realtime.journal
  // The responder is the plugin that holds the provider key, so it is the one that can name it. The
  // journal applies the shape arm on write regardless; this is the arm no pattern can perform.
  journal.addSecrets(config.redactSecrets)

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
        journal.record('delegation.seen', { id: request.id, sessionId: request.sessionId })
        const outcome = await run(request)
        recordOutcome(journal, request, outcome)
        if (outcome.kind === 'answered') return { text: outcome.text, mode: 'spoken' }
        // Not answered. The reason is reported rather than dropped, and — the whole of S1 story 3 —
        // it is now also spoken. A failure the user cannot hear is one they describe as "it did not
        // work", which is the report this layer exists to replace.
        ctx.emit('realtime-agent/delegation-settled', settlementFor(request, outcome, config.redactSecrets))
        // Only a refusal has words to say. A declined or timed-out turn carries nothing, so it returns
        // undefined and the agent speaks its own notice — inventing a reason for those would be worse
        // than the honest silence they already had.
        if (outcome.kind !== 'refused') return undefined
        return { text: boundedReason(outcome.reason, config.redactSecrets), mode: 'spoken' }
      },
    )
    yield () => { dispose() }
  }, 'realtime-responder.delegation')
}
