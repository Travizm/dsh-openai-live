import { defineTool, type InferValue, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { RealtimeError, type RealtimeSession } from 'dsh-realtime'

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
}

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

const SAID_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    spoken: { type: 'boolean', required: true },
    characters: { type: 'number', required: true },
  },
} as const

/**
 * The tools that let an agent drive a voice session.
 *
 * Deliberately a small surface with one concern — driving the session — rather than a chat UI in
 * tool form. Reading what was said needs no tool: a delegation already arrives carrying the
 * conversation, which is the whole reason the consumer exists.
 * @param deps - the session controls.
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
      name: 'voice_say',
      description: 'Say something out loud in the live voice session, in your own voice.',
      parameters: { text: { type: 'string', required: true, description: 'What to say aloud.' } },
      output: jsonOutput(SAID_VALUE),
      async execute(args) {
        const session = deps.session()
        // Thrown, not returned as a value. A tool-thrown failure is the registry's own failure
        // channel, and reporting this as a successful result would leave the model believing it had
        // spoken when nothing was said. Typed rather than bare, so the model receives a class and a
        // remedy it can relay instead of a sentence it has to interpret.
        if (session === undefined) {
          throw new RealtimeError(
            'no voice session is open — call voice_start first',
            'NO_SESSION',
            { detail: { retryable: true, remedy: 'call voice_start to open a session, then say it again' } },
          )
        }
        await session.appendCommentary(args.text)
        return { spoken: true, characters: args.text.length }
      },
    }),
  ]
}
