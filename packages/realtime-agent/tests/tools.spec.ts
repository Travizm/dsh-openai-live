import { describe, expect, it } from 'vitest'
import type { RealtimeSession } from 'dsh-realtime'
import { voiceToolDefinitions, type VoiceToolDeps } from '../src/tools.ts'

/** The execute bodies under test never touch the execution context, so a placeholder is honest here. */
const EXEC = {} as never

interface Recorder {
  appends: string[]
  stopped: number
}

const sessionOf = (recorder: Recorder): RealtimeSession => ({
  id: 'sess-1',
  appendCommentary: (text: string) => {
    recorder.appends.push(text)
    return Promise.resolve()
  },
} as unknown as RealtimeSession)

function build(overrides: Partial<VoiceToolDeps> = {}): { recorder: Recorder; tools: ReturnType<typeof voiceToolDefinitions> } {
  const recorder: Recorder = { appends: [], stopped: 0 }
  const tools = voiceToolDefinitions({
    session: () => sessionOf(recorder),
    start: () => Promise.resolve(sessionOf(recorder)),
    stop: () => {
      recorder.stopped += 1
      return Promise.resolve()
    },
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
  it('publishes exactly the three session controls', () => {
    const { tools } = build()
    expect(tools.map(definition => definition.name)).toEqual(['voice_start', 'voice_stop', 'voice_say'])
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

  it('speaks through the live session', async () => {
    const { recorder, tools } = build()
    expect(await tool(tools, 'voice_say').execute({ text: 'Staging is green.' }, EXEC))
      .toEqual({ spoken: true, characters: 17 })
    expect(recorder.appends).toEqual(['Staging is green.'])
  })

  it('refuses to speak with no session, naming the fix', async () => {
    // Thrown, not returned as a value: a tool-thrown failure is the registry's own failure channel,
    // so the model is told it did not speak rather than being handed a result that looks like it did.
    const { tools } = build({ session: () => undefined })
    await expect(tool(tools, 'voice_say').execute({ text: 'hello' }, EXEC))
      .rejects.toThrow('no voice session is open — call voice_start first')
  })
})
