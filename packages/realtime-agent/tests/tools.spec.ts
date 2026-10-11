import { describe, expect, it } from 'vitest'
import type { JournalEntry, RealtimeSession } from 'dsh-realtime'
import { voiceToolDefinitions, type JournalToolAnswer, type VoiceToolDeps } from '../src/tools.ts'

/** The execute bodies under test never touch the execution context, so a placeholder is honest here. */
const EXEC = {} as never

interface Recorder {
  stopped: number
}

/** Only the id is read: the tool surface reports which session it opened, not what was said in it. */
const sessionOf = (): RealtimeSession => ({ id: 'sess-1' } as unknown as RealtimeSession)

/** One entry as the journal holds it. Real kinds, because the filter keys off one of them. */
const entry = (seq: number, kind: JournalEntry['kind'], detail: Record<string, string> = {}): JournalEntry =>
  ({ seq, at: 1_000 + seq, kind, detail })

/** A journal whose last few entries are the playout frames that, measured, are 90% of a real one. */
const withFrames = (before: JournalEntry[], frames: number): JournalEntry[] => [
  ...before,
  ...Array.from({ length: frames }, (_, i) => entry(100 + i, 'speech.sent', { bytes: '4800' })),
]

function build(overrides: Partial<VoiceToolDeps> = {}): { recorder: Recorder; tools: ReturnType<typeof voiceToolDefinitions> } {
  const recorder: Recorder = { stopped: 0 }
  const tools = voiceToolDefinitions({
    session: () => sessionOf(),
    start: () => Promise.resolve(sessionOf()),
    stop: () => {
      recorder.stopped += 1
      return Promise.resolve()
    },
    journal: () => [],
    journalEntries: () => 25,
    ...overrides,
  })
  return { recorder, tools }
}

const tool = (tools: ReturnType<typeof voiceToolDefinitions>, name: string) => {
  const found = tools.find(definition => definition.name === name)
  if (found === undefined) throw new Error(`no tool named ${name}`)
  return found
}

describe('voiceToolDefinitions', () => {
  it('publishes the two session controls and the one that reads the record', () => {
    const { tools } = build()
    expect(tools.map(definition => definition.name)).toEqual(['voice_start', 'voice_stop', 'voice_journal'])
    for (const definition of tools) {
      expect(definition.description.length).toBeGreaterThan(0)
      expect(definition.output.schema).toBeDefined()
    }
  })

  it('renders its output as JSON text the model can read', () => {
    const { tools } = build()
    const rendered = tool(tools, 'voice_start').output.render(undefined, { sessionId: 'sess-1' })
    expect(rendered).toEqual([{ type: 'text', text: '{"sessionId":"sess-1"}' }])
  })

  it('starts a session and reports which one', async () => {
    const { tools } = build()
    expect(await tool(tools, 'voice_start').execute({}, EXEC)).toEqual({ sessionId: 'sess-1' })
  })

  it('says it closed nothing rather than failing, when nothing was open', async () => {
    // Stopping a session that is not running has achieved what the caller asked for. Reporting it as
    // a failure would invite a retry loop over a condition that is already satisfied.
    const { recorder, tools } = build({ session: () => undefined })
    expect(await tool(tools, 'voice_stop').execute({}, EXEC)).toEqual({ closed: false })
    expect(recorder.stopped).toBe(1)
  })

  it('reports a session closed', async () => {
    const { recorder, tools } = build()
    expect(await tool(tools, 'voice_stop').execute({}, EXEC)).toEqual({ closed: true })
    expect(recorder.stopped).toBe(1)
  })

  describe('voice_journal', () => {
    /** One call, with the answer named once: `ToolDefinition.execute` is declared to return `unknown`. */
    const ask = async (
      entries: JournalEntry[],
      args: { count?: number; includeFrames?: boolean } = {},
      ceiling = 25,
    ): Promise<JournalToolAnswer> =>
      await tool(build({ journal: () => entries, journalEntries: () => ceiling }).tools, 'voice_journal')
        .execute(args, EXEC) as JournalToolAnswer

    it('answers what happened, oldest first, from the end of the record', async () => {
      // The question the tool exists for, and the shape that answers it: the newest entries are the ones
      // that explain the session that has just gone wrong.
      const entries = [entry(1, 'session.opened'), entry(2, 'transcript.input', { chars: '12', final: 'false' }), entry(3, 'session.closed')]
      const result = await ask(entries, {}, 2)
      expect(result.entries.map(e => e.kind)).toEqual(['transcript.input', 'session.closed'])
      expect(result.entries[0]?.detail).toEqual({ chars: '12', final: 'false' })
    })

    it('returns the deployment ceiling when the caller names no count', async () => {
      const entries = Array.from({ length: 9 }, (_, i) => entry(i + 1, 'session.opened'))
      expect((await ask(entries, {}, 3)).entries).toHaveLength(3)
    })

    it('caps a count larger than the ceiling, because the deployment decides the size of an answer', async () => {
      const entries = Array.from({ length: 9 }, (_, i) => entry(i + 1, 'session.opened'))
      expect((await ask(entries, { count: 500 }, 4)).entries).toHaveLength(4)
    })

    it('never returns more than one entry for a count below one', async () => {
      // The floor is not politeness. `slice(-0)` is `slice(0)`, which returns the *entire* record — so a
      // naive clamp at zero would answer a request for nothing with everything the journal holds.
      const entries = Array.from({ length: 9 }, (_, i) => entry(i + 1, 'session.opened'))
      const result = await ask(entries, { count: 0 })
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0]?.seq).toBe(9)
    })

    it('leaves out the per-frame audio accounting, and says how much it left out', async () => {
      // Measured on a real journal: this one kind was 7,412 of 8,011 rows, so an unfiltered "last N"
      // answers a question about the voice with N copies of a byte count. The frames stay visible as a
      // number rather than as the answer.
      const entries = withFrames([entry(1, 'session.opened'), entry(2, 'session.closed')], 40)
      const result = await ask(entries, { count: 3 })
      expect(result.entries.map(e => e.kind)).toEqual(['session.opened', 'session.closed'])
      expect(result.skippedFrames).toBe(40)
    })

    it('returns the frames when they are asked for', async () => {
      const entries = withFrames([entry(1, 'session.opened')], 3)
      const result = await ask(entries, { count: 3, includeFrames: true })
      expect(result.entries.map(e => e.kind)).toEqual(['speech.sent', 'speech.sent', 'speech.sent'])
      expect(result.skippedFrames).toBe(0)
    })

    it('answers an empty record with an empty answer rather than an error', async () => {
      const result = await ask([])
      expect(result).toEqual({ entries: [], skippedFrames: 0 })
    })

    it('returns copies, so a caller cannot mutate the journal through a tool result', async () => {
      const held = [entry(1, 'session.opened', { plugin: 'dsh-realtime-agent' })]
      const result = await ask(held)
      result.entries[0]!.detail.plugin = 'tampered'
      expect(held[0]?.detail).toEqual({ plugin: 'dsh-realtime-agent' })
    })
  })
})
