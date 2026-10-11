import { defineTool, type InferValue, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JournalEntry, RealtimeSession } from 'dsh-realtime'

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
