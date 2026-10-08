import { describe, expect, it } from 'vitest'
import type { RealtimeSession } from 'dsh-realtime'
import { voiceToolDefinitions, type VoiceToolDeps } from '../src/tools.ts'

/** The execute bodies under test never touch the execution context, so a placeholder is honest here. */
const EXEC = {} as never

interface Recorder {
  stopped: number
}

/** Only the id is read: the tool surface reports which session it opened, not what was said in it. */
const sessionOf = (): RealtimeSession => ({ id: 'sess-1' } as unknown as RealtimeSession)

function build(overrides: Partial<VoiceToolDeps> = {}): { recorder: Recorder; tools: ReturnType<typeof voiceToolDefinitions> } {
  const recorder: Recorder = { stopped: 0 }
  const tools = voiceToolDefinitions({
    session: () => sessionOf(),
    start: () => Promise.resolve(sessionOf()),
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
  it('publishes exactly the two session controls', () => {
    const { tools } = build()
    expect(tools.map(definition => definition.name)).toEqual(['voice_start', 'voice_stop'])
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
})
