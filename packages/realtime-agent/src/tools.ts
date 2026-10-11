import { defineTool, type InferValue, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {
  JournalEntry,
  RealtimeProviderInfo,
  RealtimeSession,
  RealtimeSettingInfo,
  RealtimeSettings,
  SteeringClaim,
  TransportStatus,
} from 'dsh-realtime'
import type { RealtimeVoiceStatus } from './types.ts'

/**
 * A canonical output declaration rendered as JSON.
 *
 * `defineTool` requires an `output` with a schema **and** a `render` projection, and the harness ships
 * no helper for the common case — where the value is for the model to read rather than for a bespoke
 * presenter. Six lines here rather than a dependency on another plugin's private helper.
 * @param schema - the canonical value's author-facing schema.
 * @returns the output declaration the tool definition wants.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text', text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** The session controls the voice tools act on. */
export interface VoiceToolDeps {
  /** The live session, or `undefined` when none is open. */
  readonly session: () => RealtimeSession | undefined
  /** Open a session, or return the one already open. */
  readonly start: () => Promise<RealtimeSession>
  /** Close the open session, if any. */
  readonly stop: () => Promise<void>
  /**
   * The record, oldest entry first, as the journal holds it at this moment.
   *
   * An accessor rather than a snapshot taken when the tools were built: the point of the tool is to answer
   * "what has happened", and a copy taken at registration would answer that once and then lie.
   */
  readonly journal: () => readonly JournalEntry[]
  /**
   * The live session's state, as the plugin that owns the session is the only one that can report it.
   *
   * An accessor for the same reason the journal is one: a copy taken when the tools were built would
   * describe the session that existed then.
   */
  readonly status: () => RealtimeVoiceStatus
  /**
   * Which sessions plugins are steering, if any.
   *
   * Read from the seam rather than from a settings key: the pairing between a plugin and the conversation it
   * answers into is the seam's fact, and a reader that had to name the responder to find it would be coupled
   * to a plugin it has no other business with.
   */
  readonly steering: () => readonly SteeringClaim[]
  /** The registered routes, so the credential question can be answered without the adapter's help. */
  readonly providers: () => readonly RealtimeProviderInfo[]
  /** What carries audio, as the plugins that own the routes report it. */
  readonly transports: () => readonly TransportStatus[]
  /**
   * The seam's settings registry, which is the only route a live field can be changed by.
   *
   * Taken as the registry's own members rather than restated, so this cannot disagree with the thing it
   * describes about what a change returns or what a refusal carries.
   */
  readonly settings: Pick<RealtimeSettings, 'list' | 'apply'>
  /**
   * Ceiling on how many entries one call may return.
   *
   * A bound is not a limit on what happened — it is the size of one answer, and it is configuration
   * because it is the deployment's journal and the deployment's context budget that decide it.
   */
  readonly journalEntries: () => number
}

/**
 * The one entry kind the journal tool leaves out by default.
 *
 * Measured rather than chosen: in a real journal this kind was **7,412 of 8,011 rows** — 90% of the file,
 * one entry per frame of the output playout track, each carrying a byte count and nothing else. A tool
 * returning "the last N entries" unfiltered would answer a question about the voice with N copies of
 * `{\"bytes\":\"4800\"}`. What it reports instead is how many were left out, so the frames remain visible
 * as a fact without being the whole answer. `includeFrames` is the way to ask for them.
 */
const PLAYOUT_KIND = 'speech.sent'

const STARTED_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: { sessionId: { type: 'string', required: true } },
} as const

const STOPPED_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: { closed: { type: 'boolean', required: true } },
} as const

/**
 * One entry as the journal tool reports it.
 *
 * Declared rather than inferred because {@link ToolDefinition} erases the output type, so a caller — and
 * a test — cannot read it back off the definition. Without this the tool's own suite would have to
 * restate the shape at every call site, which is how two answers to one question start to disagree.
 */
export interface JournalToolEntry {
  readonly seq: number
  readonly at: number
  readonly kind: string
  readonly detail: Record<string, string>
}

/** What one `voice_journal` call answers with. */
export interface JournalToolAnswer {
  readonly entries: JournalToolEntry[]
  /** Entries left out for being per-frame audio accounting. See {@link PLAYOUT_KIND}. */
  readonly skippedFrames: number
}

/**
 /**
  * One setting, as the tool reports it.
  *
  * A `Pick` of the registry's own description rather than a restatement of it, and narrower than the whole
  * thing on purpose: a status surface wants to know what can be changed and what it holds now, not which
  * plugin registered it under which internal name.
  */
 function summariseSetting(setting: RealtimeSettingInfo): {
   key: string
   kind: string
   scope: string
   describe?: string
   choices?: string[]
   value?: ConfigureValue
   } {
   return {
     key: setting.key,
     kind: setting.kind,
     scope: setting.scope,
     ...setting.describe === undefined ? {} : { describe: setting.describe },
    // The legal values, when the owner declared a set worth picking from: a caller deciding what to set has no
    // business guessing at a value the registry could have named.
    ...setting.choices === undefined ? {} : { choices: [...setting.choices] },
     // Omitted rather than sent as nothing, because a **secret** setting reports no value back at all: a
     // surface that echoed one would be the leak the write-only rule exists to prevent.
     //
     // The narrowing is where the registry's `unknown` meets this tool's declared kinds, and it is a narrowing
     // rather than a guess: a setting declares one of string, number, boolean or string-list, so nothing else
     // can be here. Written as a named cast so the one place the two representations meet is visible.
     ...setting.value === undefined ? {} : { value: setting.value as ConfigureValue },
   }
 }

 /**
 * A setting's value as a surface may hold it, and every kind the registry declares.
 *
 * Narrower than the harness's own JSON value and deliberately so: this is a *subset*, which is assignable
 * where a general JSON value is expected without importing the harness's type into a shipped file.
 */
export type ConfigureValue = string | number | boolean | string[] | null

/** What one `voice_configure` call answers with. */
 export interface ConfigureAnswer {
   readonly action: 'read' | 'applied' | 'refused'
   /** One line a person can act on, and for a refusal it is the registry's own reason, relayed verbatim. */
   readonly detail: string
   /** Every setting as it stands **after** the call, so a caller sees the effect rather than the request. */
   readonly settings: Array<{
    key: string
    kind: string
    scope: string
    describe?: string
    choices?: string[]
    value?: ConfigureValue
  }>
 }

 const CONFIGURE_VALUE = {
   type: 'object',
   additionalProperties: false,
   properties: {
     action: { type: 'string', required: true, enum: ['read', 'applied', 'refused'] },
     detail: { type: 'string', required: true },
     settings: {
       type: 'array',
       required: true,
       items: {
         type: 'object',
         additionalProperties: false,
         properties: {
           key: { type: 'string', required: true },
           kind: { type: 'string', required: true },
           scope: { type: 'string', required: true },
           describe: { type: 'string' },
           choices: { type: 'array', items: { type: 'string' } },
           value: { type: 'json' },
         },
       },
     },
   },
 } as const

 /** What one check found, in the vocabulary `scripts/self-test.mjs` already uses.
 *
 * `waiting` is not a hedge: a check with nothing to look at yet — no delegation has been raised — reports
 * that, and a two-valued field would have to call it a pass and become a check that cannot fail.
 */
export interface DiagnoseCheck {
  readonly name: string
  readonly state: 'pass' | 'fail' | 'waiting'
  /** One line a person can act on, which is the only reason to report the check at all. */
  readonly detail: string
}

/** The verdict and the checks behind it. */
export interface DiagnoseAnswer {
  readonly verdict: 'pass' | 'partial' | 'fail'
  readonly checks: DiagnoseCheck[]
}

/**
 * The three ways a relayed turn ends, and only these three end it.
 *
 * Named as a set because the check was first written to stop at *any* entry it recognised — and
 * `prompt.admitted` is an intermediate step, not an ending, so a turn that had already been answered
 * reported as still running. What ends a turn is an answer, a refusal, or a window elapsing with neither.
 */
const TURN_ENDINGS = ['prompt.refused', 'window.elapsed', 'answer.received']

const DIAGNOSE_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', required: true, enum: ['pass', 'partial', 'fail'] },
    checks: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['pass', 'fail', 'waiting'] },
          detail: { type: 'string', required: true },
        },
      },
    },
  },
} as const

const STATUS_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    open: { type: 'boolean', required: true },
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    voice: { type: 'string' },
    sessionId: { type: 'string' },
    steering: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          owner: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
        },
      },
    },
  },
} as const

const JOURNAL_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entries: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'number', required: true },
          at: { type: 'number', required: true },
          kind: { type: 'string', required: true },
          detail: { type: 'json', required: true },
        },
      },
    },
    skippedFrames: { type: 'number', required: true },
  },
} as const

/**
 * Whether the route a session would open on reports having what it needs.
 *
 * Three answers, not two: an adapter that says nothing gets `waiting` rather than a pass. The fault this
 * catches has no other symptom — a route with no credential configured fails every open with a coded error,
 * and from outside that is indistinguishable from a provider that is down.
 * @param current - the session's status, which names the route in question.
 * @param providers - the registered routes.
 * @returns the check, with a detail naming the route.
 */
function credentialCheck(current: RealtimeVoiceStatus, providers: readonly RealtimeProviderInfo[]): DiagnoseCheck {
  const route = providers.find(provider => provider.id === current.provider)
  if (route === undefined) {
    return {
      name: 'key',
      state: 'fail',
      detail: `no adapter is registered for "${current.provider}", so no session can open at all`,
    }
  }
  if (route.configured === false) {
    return {
      name: 'key',
      state: 'fail',
      detail: `the "${current.provider}" route reports nothing configured — opening fails with NOT_CONFIGURED, which names the setting`,
    }
  }
  if (route.configured === true) {
    return { name: 'key', state: 'pass', detail: `the "${current.provider}" route reports what it needs to open` }
  }
  return {
    name: 'key',
    state: 'waiting',
    detail: `the "${current.provider}" route does not report whether it is configured, so this cannot be judged from here`,
  }
}

/**
 * Whether anything can carry audio, and whether anything is.
 *
 * The half of the self-test's route check that is visible from inside: a route exists and a client is
 * attached. Whether the route *refuses* an unauthorised client is a property of a handler and is only proven
 * by probing it, so it is not claimed here.
 * @param transports - what the plugins owning the routes declared.
 * @returns the check, naming the paths and the clients.
 */
function transportCheck(transports: readonly TransportStatus[]): DiagnoseCheck {
  if (transports.length === 0) {
    return {
      name: 'route',
      state: 'fail',
      detail: 'no audio transport is declared, so no microphone can reach the session — the route plugin is not mounted',
    }
  }
  const attached = transports.filter(transport => transport.clients > 0)
  if (attached.length === 0) {
    return {
      name: 'route',
      state: 'fail',
      detail: `${transports.map(transport => transport.path).join(', ')} has nothing attached — the client half has not connected`,
    }
  }
  return {
    name: 'route',
    state: 'pass',
    detail: attached.map(transport => `${transport.path} with ${transport.clients} client(s)`).join('; '),
  }
}

/**
 * Whether a session is open, and on what.
 * @param current - the status the plugin reports.
 * @returns the check.
 */
function sessionCheck(current: RealtimeVoiceStatus): DiagnoseCheck {
  return current.open
    ? { name: 'session', state: 'pass', detail: `open on ${current.provider}/${current.model}` }
    : {
        name: 'session',
        state: 'fail',
        detail: 'no session is open — ask for voice_start, and read the record for why the last one failed',
      }
}

/**
 * Whether a delegated question would be answered, and where.
 *
 * Nothing steering is a fault rather than a quiet state: the delegation still leaves, and nobody answers it,
 * which looks from the outside like a model that cannot do the thing it was asked.
 * @param steering - the claims in force.
 * @returns the check, naming the plugin and the conversation.
 */
function delegationCheck(steering: readonly SteeringClaim[]): DiagnoseCheck {
  return steering.length > 0
    ? {
        name: 'delegation',
        state: 'pass',
        detail: steering.map(claim => `${claim.owner} answers into ${claim.sessionId}`).join('; '),
      }
    : {
        name: 'delegation',
        state: 'fail',
        detail: 'nothing is steering, so a delegated question would be answered by nobody — the responder is not mounted or not loaded',
      }
}

/**
 * How the relayed turn that a delegation began actually ended.
 *
 * Reads the entries *after* the delegation rather than the whole record: a turn that failed an hour ago is
 * history, and the question is what happened to the last one. The first ending kind wins, because the
 * responder stops at one of them — an answer, a refusal, or a window that elapsed with none.
 * @param after - the entries recorded since the delegation was seen.
 * @returns the check, with a detail naming the ending.
 */
function turnCheck(after: readonly JournalEntry[]): DiagnoseCheck {
  const ended = after.find(entry => TURN_ENDINGS.includes(entry.kind))?.kind
  if (ended === 'answer.received') {
    return { name: 'turn', state: 'pass', detail: 'the last delegation was answered' }
  }
  if (ended === 'prompt.refused') {
    return { name: 'turn', state: 'fail', detail: 'the last delegation was refused, so nothing was asked — the refusal entry names the reason' }
  }
  if (ended === 'window.elapsed') {
    return {
      name: 'turn',
      state: 'fail',
      detail: 'the last delegation was admitted and never answered — it is the session that is quiet, not the voice',
    }
  }
  // No ending yet: either the turn is running, or it has not begun to be answered at all. The difference is
  // the one thing a person watching would notice, so it is the one thing the detail names.
  return after.some(entry => entry.kind === 'prompt.admitted')
    ? { name: 'turn', state: 'waiting', detail: 'the last delegation was admitted and has not ended yet' }
    : { name: 'turn', state: 'waiting', detail: 'the last delegation was seen and nothing has come of it yet' }
}

/**
 * The tools that let an agent drive a voice session, and read what happened to it.
 *
 * Deliberately a small surface — two controls and one window onto the record — rather than a chat UI in
 * tool form. Reading what was *said* needs no tool: a delegation already arrives carrying the
 * conversation, which is the whole reason the consumer exists. What a shell cannot reach is the record of
 * a session that is happening now, which is why that is the one thing here that reads.
 * @param deps - the session controls and the record.
 * @returns definitions ready to register on the tools service.
 */
export function voiceToolDefinitions(deps: VoiceToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'voice_start',
      description: 'Open the live voice session so you can be heard. Safe to call when one is already open.',
      parameters: {},
      output: jsonOutput(STARTED_VALUE),
      async execute() {
        const session = await deps.start()
        return { sessionId: session.id }
      },
    }),

    defineTool({
      name: 'voice_stop',
      description: 'End the live voice session. Safe to call when none is open.',
      parameters: {},
      output: jsonOutput(STOPPED_VALUE),
      async execute() {
        // Reported rather than thrown: stopping a session that is not running has achieved what the
        // caller asked for, so it is a success that says it had nothing to do.
        const wasOpen = deps.session() !== undefined
        await deps.stop()
        return { closed: wasOpen }
      },
    }),

    defineTool({
      name: 'voice_status',
      description:
        'Report the live voice session: whether one is open, which provider route and model it is on, the '
        + 'voice it settled on, and the provider\'s own session id while one is open. With nothing open it '
        + 'reports what a start would use, which is the difference between "no session" and "no idea". '
        + 'Also reports which DSH session a plugin is steering, if any: that is the conversation a delegated '
        + 'question is actually asked in, so an empty list means a delegation now would be answered by nobody.',
      parameters: {},
      output: jsonOutput(STATUS_VALUE),
      async execute() {
        // The claims are copied rather than handed out as the registry holds them, for the same reason the
        // journal's entries are: a tool result must not be a handle on a registry's own state.
        return {
          ...deps.status(),
          steering: deps.steering().map(claim => ({ owner: claim.owner, sessionId: claim.sessionId })),
        }
      },
    }),

    defineTool({
      name: 'voice_configure',
      description:
        'Read the voice plugins\' live settings, and change one. Call it with no arguments to list every '
        + 'field with what it holds now and whether a change would take effect; call it with a key and a value '
        + 'to change one. Only fields marked `live` can be changed — a session-bound or restart-bound field is '
        + 'refused with the reason, and the reason is written to be relayed as it stands. The registry is the '
        + 'only route a live change can take, so this is the same path the app\'s own controls use, and a value '
        + 'a plugin clamps is reported as the plugin now holds it rather than as it was asked for.',
      parameters: {
        key: {
          type: 'string',
          description: 'The setting to change, as `<owner>.<field>`. Omit it to read instead of changing anything.',
        },
        value: {
          type: 'string',
          description: 'The new value as text; the registry validates it. Required when a key is given.',
        },
      },
      output: jsonOutput(CONFIGURE_VALUE),
      async execute(args): Promise<ConfigureAnswer> {
        const listed = (): ConfigureAnswer['settings'] => deps.settings.list().map(setting => summariseSetting(setting))

        if (args.key === undefined) {
          const settings = listed()
          return {
            action: 'read',
            detail: `${settings.length} setting(s) declared by the plugins in this bundle`,
            settings,
          }
        }
        // Refused rather than guessed: a key with no value is a change nobody described, and applying the
        // empty string would silently write one — the failure mode a control surface exists to avoid.
        if (args.value === undefined) {
          return {
            action: 'refused',
            detail: `a change needs both a key and a value: "${args.key}" was given without one`,
            settings: listed(),
          }
        }
        const outcome = deps.settings.apply(args.key, args.value)
        return outcome.ok
          ? {
              action: 'applied',
              // The value the plugin *now* holds, not the one that was asked for: a setter may clamp it, and
              // the difference is the whole reason a caller reads back.
              detail: `"${outcome.key}" is now ${JSON.stringify(outcome.value)}`,
              settings: listed(),
            }
          : { action: 'refused', detail: outcome.reason, settings: listed() }
      },
    }),

    defineTool({
      name: 'voice_diagnose',
      description:
        'Answer "is the voice working, and if not which part is wrong" from inside the running app. Reports '
        + 'five checks with one verdict: whether the route has what it needs to open a session at all, whether '
        + 'anything is carrying audio and whether a client is attached, whether a session is open, whether '
        + 'anything is steering — a delegation nobody would answer is the most common fault and it looks like a '
        + 'broken model — and how the last relayed turn actually ended, from the record rather than from '
        + 'anybody\'s recollection. Each check is pass, fail or waiting, and waiting means it could not be '
        + 'judged rather than that it was fine. It cannot check that the route REFUSES an unauthorised client: '
        + 'that is a property only a probe proves, so `pnpm self-test` in the plugin repository makes it.',
      parameters: {},
      output: jsonOutput(DIAGNOSE_VALUE),
      async execute(): Promise<DiagnoseAnswer> {
        const current = deps.status()
        const entries = deps.journal()
        const seen = entries.map(entry => entry.kind).lastIndexOf('delegation.seen')

        // The five checks `scripts/self-test.mjs` makes from outside, in its order, restricted to the ones that
        // can be made from in here: the credential and the transport are the seam's facts, the session, the
        // delegation and the turn are this plugin's own, and the route's refusal half stays with the script.
        const checks = [
          credentialCheck(current, deps.providers()),
          transportCheck(deps.transports()),
          sessionCheck(current),
          delegationCheck(deps.steering()),
          seen === -1
            ? { name: 'turn', state: 'waiting' as const, detail: 'nothing has been delegated yet, so there is no turn to judge' }
            : turnCheck(entries.slice(seen + 1)),
        ]
        const verdict = checks.some(check => check.state === 'fail')
          ? 'fail' as const
          : checks.some(check => check.state === 'waiting')
            ? 'partial' as const
            : 'pass' as const
        return { verdict, checks }
      },
    }),

    defineTool({
      name: 'voice_journal',
      description:
        'Read what the voice plugin recorded, oldest entry first: the last few things that happened to the '
        + 'session, each as a kind, a timestamp and its detail — counts, timings, ids and digests, never the '
        + 'words spoken. Call it when the voice misbehaves: whether the model heard anything, whether it '
        + 'delegated, and how the session ended are all entries here. The per-frame audio accounting is left '
        + 'out unless asked for, because it is one entry per frame and outnumbers everything else.',
      parameters: {
        count: {
          type: 'number',
          description: 'How many entries to return, from the most recent backwards. Capped by the deployment.',
        },
        includeFrames: {
          type: 'boolean',
          description: 'Include the per-frame output-audio accounting, which normally drowns every other entry.',
        },
      },
      output: jsonOutput(JOURNAL_VALUE),
      // `async` for the contract rather than for the work: `execute` is declared to return a promise, and
      // reading the journal is synchronous. The two controls above await a session; this one has nothing to
      // wait for, and says so by being the only body here with no `await` in it.
      async execute(args): Promise<JournalToolAnswer> {
        const ceiling = deps.journalEntries()
        // Clamped where the whole value is emitted rather than trusted from the caller: the caller asks how
        // much of the record it wants to read, the deployment decides how much one answer may carry. The
        // floor of one is deliberate — a request for none is not a question about what happened, and
        // `slice(-0)` is `slice(0)`, which would quietly return the entire record.
        const wanted = args.count === undefined
          ? ceiling
          : Math.min(Math.max(Math.trunc(args.count), 1), ceiling)
        const all = deps.journal()
        const usable = args.includeFrames === true ? all : all.filter(entry => entry.kind !== PLAYOUT_KIND)
        // Copies, so nothing here hands the journal's own objects out through a tool result.
        return {
          entries: usable.slice(-wanted).map(entry => ({
            seq: entry.seq,
            at: entry.at,
            kind: entry.kind,
            detail: { ...entry.detail },
          })),
          skippedFrames: all.length - usable.length,
        }
      },
    }),
  ]
}
