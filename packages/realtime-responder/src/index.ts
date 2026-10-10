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
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { RealtimeDelegationSettlement } from 'dsh-realtime'
import { REALTIME_ERROR_CODES, RealtimeError, redact, type Journal } from 'dsh-realtime'
import type { DelegationAnswer, DelegationRequest } from 'dsh-realtime-agent'
import { createTurnRunner, phraseTable, type MilestonePolicy, type TurnOutcome } from './turn.ts'
import type { RealtimeResponderConfig, SessionEventLike } from './types.ts'

export * from './types.ts'
export { answerText, createTurnRunner, promptFrom, type TurnDeps, type TurnOutcome } from './turn.ts'

/** Character ceiling on a reason carried on the bus, so a controller error cannot flood a consumer. */
const MAX_REASON_CHARS = 500

/**
 * The slice of the session controller this plugin uses, described structurally rather than imported.
 *
 * It **borrows the real type** instead of restating one, and that is a correction with a body count. This
 * used to declare its own four-field shape of `prompt` — with a **single** parameter, while the real method
 * takes two, the second a required `AbortSignal` that the harness reads before it will consider the request.
 * The result was `Cannot read properties of undefined (reading 'throwIfAborted')` on **every** delegation,
 * in production, for two releases: a hand-written structural type cannot disagree with the thing it
 * describes, because it never talks to it. A `Pick` of the real method makes the call site the compiler's
 * business instead of the author's memory.
 *
 * The collision this comment used to warn about does not apply, and never did. Importing the controller
 * package *does* augment `Context` with its own `sessionController` declaration — but this plugin never
 * declares that property; it reads the controller through the cast below, so there is no second declaration
 * for it to collide with. The warning was written from reasoning rather than from a compile error, and it
 * cost more than the collision would have.
 *
 * Type-only, and erased: no runtime dependency is taken, and the harness package remains the host's.
 */
type SessionControllerLike = Pick<SessionController, 'prompt'>

/**
 * The request the real method takes, derived from the method rather than imported by name.
 *
 * `Parameters<…>[0]` rather than `SessionPromptRequest`, `SessionId` and `SessionRequestId`: the package
 * re-exports its types unevenly, and names that are not exported cannot be borrowed. Deriving from the
 * signature means this file tracks whatever the harness actually declares — which is the entire point of
 * borrowing the type in the first place.
 */
type SessionPromptRequestLike = Parameters<SessionController['prompt']>[0]

/**
 * The slice of the session store this plugin reads: every session the harness currently has live.
 *
 * Structural, and reached for with `ctx.get` rather than declared in `inject`. That is deliberate: a
 * profile without this service is one where the session picker offers a text field instead of a list, not
 * one where the responder should wait — and an unsatisfied `inject` is silence, so a missing *enhancement*
 * must never be able to stop the plugin answering.
 */
interface SessionStoreLike {
  list(): readonly { readonly id: string }[]
}

/** Plugin name, as it appears in Loader diagnostics. */
export const name = 'realtime-responder'

/**
 * This plugin answers by admitting a turn, so it needs the session controller. Declared rather than
 * probed: a responder with no door is a plugin that loads and silently never answers, which is worse
 * than one that visibly waits for the service it named.
 */
export const inject = ['sessionController', 'realtime']

/**
 * The preamble this plugin puts in front of a relayed request.
 *
 * The relayed text is a spoken conversation with both sides flattened into it and nothing that says where
 * it came from. Live evidence for why that is not enough: the session's own reasoning had to infer the
 * provenance ("apparently from a voice session"), and it answered in chat prose — markdown, a file link,
 * a fenced json block — which was then appended for speech and read out verbatim, link and all.
 *
 * So the frame does two jobs and both are deliberate: it says what the text is, and it names the shape of
 * answer that suits an ear. It is config (`promptFrame`) rather than a constant because it is this
 * plugin's own prose, and prose is something a deployment may want to word differently — the same
 * judgement that makes `milestonePhrases` configuration instead of a table in the source.
 */
export const DEFAULT_PROMPT_FRAME = 'Relayed from the voice conversation: the lines below are a spoken exchange, what the user said and what was said back. Treat the last line as the live request and answer it in plain prose that can be read aloud — one or two short sentences, no markdown, no links, no code blocks.'

/** Validated configuration. */
export const Config = Schema.object({
  sessionId: Schema.string().description('DSH session the voice conversation is attached to'),
  maxPromptChars: Schema.number().default(4_000).description('Character budget for the prompt handed to the agent'),
  answerTimeoutMs: Schema.number().default(45_000).description('How long to wait for the agent before declining'),
  redactSecrets: Schema.array(Schema.string()).default([]).description('Values that must never be spoken or carried on the bus'),
  promptFrame: Schema.string().default(DEFAULT_PROMPT_FRAME).description('Preamble put in front of a relayed request, so the session knows what it is answering'),
  // Narration. The words are content — this plugin's own prose, keyed by the tool's name — and the three
  // fields under them are operational and live. `milestonePhrases` is deliberately **not** a live setting:
  // a phrase table is prose a user edits in `cordis.yml` beside `instructions`, and a text box in a call
  // panel is the wrong control for it.
  //
  // Flat `tool=phrase` strings rather than a nested object schema, because a schema containing an object
  // cannot be *named* by the declaration this package emits (`TS2883`: the inferred type reaches
  // schemastery's `Dict` through cosmokit) — and a config shape that cannot be published is not a config
  // shape. See `phraseTable` for what a malformed entry does.
  milestonePhrases: Schema.array(Schema.string()).default([
    'read_file=Reading a file.',
    'write_file=Writing a file.',
    'patch=Editing a file.',
    'search_files=Searching the files.',
    'terminal=Running a command.',
    'bash=Running a command.',
    'execute_code=Running some code.',
    'web_search=Looking that up.',
    'web_extract=Reading a page.',
    'delegate_task=Working on that.',
  ]).description('Spoken phrase for each tool, written `tool=phrase` — e.g. `read_file=Reading a file.`'),
  milestoneFallback: Schema.string().default('Working on it.').description('Spoken phrase for a tool the phrase table does not name'),
  milestoneIntervalMs: Schema.number().default(4_000).description('Shortest gap between two spoken milestones'),
  maxSpokenMilestones: Schema.number().default(3).description('Most milestones spoken aloud in one turn'),
  speakMilestones: Schema.boolean().default(true).description('Speak a step aloud as the agent works, rather than only carrying it'),
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
 * The values this plugin reads at the moment of use, and the only copy a change can reach.
 *
 * Deliberately not the resolved config: the config is the *initial* state, written once when the row
 * loads, and reading it per turn is what made every one of these fields look live while only some of
 * them were. This object is what the readers below actually consult, so "a change takes effect on the
 * next use" is a property of the code rather than a claim about it.
 */
interface LiveValues {
  sessionId: string
  maxPromptChars: number
  answerTimeoutMs: number
  redactSecrets: readonly string[]
  /** The preamble put in front of a relayed request, as configured. */
  promptFrame: string
  /** The narration phrase table as written in config, and the three operational fields beside it. */
  milestonePhrases: readonly string[]
  milestoneFallback: string
  milestoneIntervalMs: number
  maxSpokenMilestones: number
  speakMilestones: boolean
}

/**
 * A count a turn can actually be run with: a whole, positive number.
 *
 * Refused here rather than clamped, because a budget silently changed under the caller is a bug that
 * presents as a wrong answer somewhere else. The unit is spelled out in the reason so the person
 * reading it knows which field they got wrong without opening this file.
 * @param field - the setting's own name, for the reason.
 * @param unit - what the number counts, for the reason.
 * @param value - the proposed value.
 * @returns the value, when it is usable.
 */
function requireCount(field: string, unit: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RealtimeError(`${field} must be a positive whole number of ${unit}`, REALTIME_ERROR_CODES.INVALID_SETTING)
  }
  return value
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

  const live: LiveValues = {
    sessionId: config.sessionId,
    maxPromptChars: config.maxPromptChars,
    answerTimeoutMs: config.answerTimeoutMs,
    redactSecrets: config.redactSecrets,
    promptFrame: config.promptFrame,
    milestonePhrases: [...config.milestonePhrases],
    milestoneFallback: config.milestoneFallback,
    milestoneIntervalMs: config.milestoneIntervalMs,
    maxSpokenMilestones: config.maxSpokenMilestones,
    speakMilestones: config.speakMilestones,
  }

  // What this plugin resolved, recorded so the journal can be read without the profile beside it — and, for
  // the field at the end, so a **stale steering pin is visible**. A session id outlives the session it names:
  // the profile pins one, that session ends, and the next boot steers a conversation that is not there until
  // somebody steers it again. That is invisible without this entry, and it has already made a working relay
  // look broken once — the delegation fired, went to a session nobody was in, and the voice spoke a refusal.
  //
  // The id is an identifier and not a credential: the same class of value the audio route records as its
  // path. A recorder that produces a shareable artifact elides ids at that boundary; this file is the
  // process's own record, and the field is read at use rather than copied from config so a steer shows here
  // as the value the plugin now holds.
  journal.record('config.resolved', {
    plugin: 'dsh-realtime-responder',
    sessionId: live.sessionId,
    maxPromptChars: String(live.maxPromptChars),
    answerTimeoutMs: String(live.answerTimeoutMs),
  })

  /**
   * The narration policy as it stands for the next turn.
   *
   * The phrase is chosen from the **tool's name** and nothing else. A tool's arguments are the model's own
   * words, and the one path this plugin lets model-authored text take to a user's ear is the answer, which
   * is redacted on the way out — so no phrase is ever derived from them, however tempting the detail in
   * them looks.
   */
  const milestonePolicy = (): MilestonePolicy => {
    const table = phraseTable(live.milestonePhrases)
    return {
      phrase: (toolName: string) => table.get(toolName) ?? live.milestoneFallback,
      intervalMs: live.milestoneIntervalMs,
      maxSpoken: live.maxSpokenMilestones,
      speak: live.speakMilestones,
    }
  }

  /**
   * The sessions a picker can offer, read at the moment it is asked.
   *
   * Empty when the session store is not mounted, and empty is a legitimate answer: the strip renders a
   * text field for an empty list rather than a picker with nothing in it, so an absent service degrades
   * the control instead of breaking it.
   */
  const sessionChoices = (): readonly string[] => {
    const store = ctx.get('sessions') as SessionStoreLike | undefined
    return store === undefined ? [] : store.list().map(session => session.id)
  }

  // The four fields `docs/control-plane-fields.md` classifies as live for this plugin, declared on the
  // seam's surface so a running conversation can be re-steered without a restart — which is the field
  // whose boot-time constant cost two restarts and a false lead.
  ctx.effect(function* () {
    const release = ctx.realtime.settings.register(name, [
      {
        field: 'sessionId',
        kind: 'string',
        scope: 'live',
        describe: 'The DSH session the voice conversation steers',
        choices: sessionChoices,
        get: () => live.sessionId,
        set: (value: string) => {
          // No default and no empty: a responder pointed at the wrong session speaks another
          // conversation's reply, and one pointed at nothing answers nobody. The refusal names the
          // rule, and the surface carries it back to whoever tried.
          if (value.length === 0) {
            throw new RealtimeError('sessionId must be non-empty', REALTIME_ERROR_CODES.INVALID_SETTING)
          }
          live.sessionId = value
        },
      },
      {
        field: 'answerTimeoutMs',
        kind: 'number',
        scope: 'live',
        describe: 'How long one turn waits for the agent before declining',
        get: () => live.answerTimeoutMs,
        set: (value: number) => { live.answerTimeoutMs = requireCount('answerTimeoutMs', 'milliseconds', value) },
      },
      {
        field: 'maxPromptChars',
        kind: 'number',
        scope: 'live',
        describe: 'Character budget for the prompt handed to the agent',
        get: () => live.maxPromptChars,
        set: (value: number) => { live.maxPromptChars = requireCount('maxPromptChars', 'characters', value) },
      },
      {
        field: 'redactSecrets',
        kind: 'string-list',
        scope: 'live',
        secret: true,
        describe: 'Values that must never be spoken or carried on the bus',
        get: () => live.redactSecrets,
        set: (value: readonly string[]) => {
          live.redactSecrets = [...value]
          // Additive, and applied at the moment the plugin learns the value rather than at the next
          // boot: a secret that becomes redactable only after a restart is one the journal can write
          // in the clear in between, which is the window this whole mechanism exists to close.
          journal.addSecrets(value)
        },
      },
      {
        field: 'speakMilestones',
        kind: 'boolean',
        scope: 'live',
        describe: 'Speak a step aloud as the agent works, rather than only carrying it silently',
        get: () => live.speakMilestones,
        set: (value: boolean) => { live.speakMilestones = value },
      },
      {
        field: 'maxSpokenMilestones',
        kind: 'number',
        scope: 'live',
        describe: 'Most steps spoken aloud in one turn',
        get: () => live.maxSpokenMilestones,
        set: (value: number) => { live.maxSpokenMilestones = requireCount('maxSpokenMilestones', 'steps', value) },
      },
      {
        field: 'milestoneIntervalMs',
        kind: 'number',
        scope: 'live',
        describe: 'Shortest gap between two spoken steps',
        get: () => live.milestoneIntervalMs,
        set: (value: number) => { live.milestoneIntervalMs = requireCount('milestoneIntervalMs', 'milliseconds', value) },
      },
    ])
    yield () => { release() }
  }, 'realtime-responder.settings')

  const run = createTurnRunner({
    // Accessors, not values: see `LiveValues`. This is the change that makes the resolved config an
    // initial state rather than the state.
    sessionId: () => live.sessionId,
    maxPromptChars: () => live.maxPromptChars,
    frame: () => live.promptFrame,
    answerTimeoutMs: () => live.answerTimeoutMs,
    admit: async (text: string): Promise<void> => {
      // A signal per admission. The controller **requires** one — it reads `signal.throwIfAborted()` before it
      // considers the request — so calling `prompt` with a single argument throws
      // `Cannot read properties of undefined (reading 'throwIfAborted')` on *every* delegation, before the
      // prompt is reached at all. That is what this did for two releases, and the interface above declared one
      // parameter and hid it: a hand-written structural type cannot disagree with the thing it describes
      // unless somebody runs it. The live journal is what ran it.
      const abort = new AbortController()
      // Two brands, cast at the one boundary where they belong. A session id reaches this plugin as **text**
      // out of a profile's YAML and can never be a branded type; and the request id is *minted here*, which
      // the harness's own docstring calls "client-minted identity". These casts are the opposite of the one
      // this file used to hide behind — that one silenced a real mismatch between two signatures, whereas
      // this is the point at which a string genuinely becomes an identity.
      await controller.prompt({
        requestId: `realtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as SessionPromptRequestLike['requestId'],
        sessionId: live.sessionId as SessionPromptRequestLike['sessionId'],
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, abort.signal)
    },
    // `session/event` listeners are called with `(session, event)`. The owning session is the FIRST
    // argument and the event carries no session id of its own, so the scope is forwarded from here. This
    // adapter used to discard the session and hand the listener the bare event, which made every answer
    // unmatchable in a real composition while a hand-built test event passed.
    subscribe: (listener) => ctx.on(
      'session/event',
      (session: { readonly id?: unknown } | undefined, event: unknown) => {
        listener(event as SessionEventLike, typeof session?.id === 'string' ? session.id : '')
      },
    ),
    // Narration. A step is *emitted* rather than appended here: the agent holds the session, and the bus is
    // how the two halves of this bundle already talk — the settlement of a failed turn travels the same way.
    milestone: milestonePolicy,
    onStep: (step) => {
      ctx.emit('realtime-agent/delegation-progress', { id: step.id, channel: step.channel, text: step.text })
    },
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
        ctx.emit('realtime-agent/delegation-settled', settlementFor(request, outcome, live.redactSecrets))
        // Only a refusal has words to say. A declined or timed-out turn carries nothing, so it returns
        // undefined and the agent speaks its own notice — inventing a reason for those would be worse
        // than the honest silence they already had.
        if (outcome.kind !== 'refused') return undefined
        return { text: boundedReason(outcome.reason, live.redactSecrets), mode: 'spoken' }
      },
    )
    yield () => { dispose() }
  }, 'realtime-responder.delegation')
}
