import { describe, expect, it } from 'vitest'
import type { JournalEntry, RealtimeSession } from 'dsh-realtime'
import { voiceToolDefinitions, type DiagnoseAnswer, type JournalToolAnswer, type VoiceToolDeps } from '../src/tools.ts'
import type { RealtimeVoiceStatus } from '../src/types.ts'

/** The execute bodies under test never touch the execution context, so a placeholder is honest here. */
const EXEC = {} as never

interface Recorder {
  stopped: number
}

/** Only the id is read: the tool surface reports which session it opened, not what was said in it. */
const sessionOf = (): RealtimeSession => ({ id: 'sess-1' } as unknown as RealtimeSession)

/** A status as the plugin reports it with nothing open: the route a start *would* use. */
const CLOSED: RealtimeVoiceStatus = { open: false, provider: 'openai-live', model: 'gpt-live-1' }

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
    status: () => CLOSED,
    steering: () => [],
    providers: () => [],
    transports: () => [],
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
  it('publishes the two session controls, the two that read the app, and the diagnosis', () => {
    const { tools } = build()
    expect(tools.map(definition => definition.name))
      .toEqual(['voice_start', 'voice_stop', 'voice_status', 'voice_diagnose', 'voice_journal'])
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

  describe('voice_status', () => {
    it('reports an open session as the plugin holds it, field for field', async () => {
      const open: RealtimeVoiceStatus = {
        open: true, provider: 'openai-live', model: 'gpt-live-1', voice: 'marin', sessionId: 'sess-1',
      }
      const { tools } = build({ status: () => open })
      expect(await tool(tools, 'voice_status').execute({}, EXEC)).toEqual({ ...open, steering: [] })
    })

    it('reports what a start would use when nothing is open', async () => {
      // "No session, and it would be openai-live" is a different answer from an absence, and it is the one
      // that lets a caller tell a wrong configuration from a closed session.
      const { tools } = build()
      expect(await tool(tools, 'voice_status').execute({}, EXEC)).toEqual({ ...CLOSED, steering: [] })
    })

    it('reports which sessions plugins are steering, so the answer names the conversation', async () => {
      // The doc's third question. An empty list is itself the answer to "would a delegation be answered".
      const claims = [{ owner: 'realtime-responder', sessionId: 'session-a' }]
      const { tools } = build({ steering: () => claims })
      expect(await tool(tools, 'voice_status').execute({}, EXEC)).toMatchObject({ steering: claims })
    })

    it('copies the claims, so a caller cannot mutate the registry through a tool result', async () => {
      const claims = [{ owner: 'realtime-responder', sessionId: 'session-a' }]
      const { tools } = build({ steering: () => claims })
      const answer = await tool(tools, 'voice_status').execute({}, EXEC)
      ;(answer as { steering: Array<{ owner: string }> }).steering[0]!.owner = 'tampered'
      expect(claims[0]?.owner).toBe('realtime-responder')
    })

    it('reads the status at the moment it is called, not when the tools were built', async () => {
      // A snapshot taken at registration would describe the session that existed then, and would answer
      // "closed" for ever after the first start.
      let open = false
      const { tools } = build({ status: () => ({ open, provider: 'openai-live', model: 'gpt-live-1' }) })
      const first = await tool(tools, 'voice_status').execute({}, EXEC)
      open = true
      const second = await tool(tools, 'voice_status').execute({}, EXEC)
      expect(first).toMatchObject({ open: false })
      expect(second).toMatchObject({ open: true })
    })
  })

  describe('voice_diagnose', () => {
    const at = (seq: number, kind: JournalEntry['kind']): JournalEntry => ({ seq, at: 1_000 + seq, kind, detail: {} })
    const OPEN: RealtimeVoiceStatus = { open: true, provider: 'openai-live', model: 'gpt-live-1' }
    const CLAIM = [{ owner: 'realtime-responder', sessionId: 'session-a' }]
    /** A route that says it is configured, and a transport with a client on it: the passing baseline. */
    const ROUTE = [{ id: 'openai-live', name: 'OpenAI Live', configured: true }]
    const ATTACHED = [{ path: '/dsh-realtime/audio', clients: 1 }]
    const judge = async (over: Partial<VoiceToolDeps> = {}): Promise<DiagnoseAnswer> =>
      await tool(build({
        status: () => OPEN, steering: () => CLAIM, providers: () => ROUTE, transports: () => ATTACHED, ...over,
      }).tools, 'voice_diagnose').execute({}, EXEC) as DiagnoseAnswer

    it('passes when a session is open, something steers, and the last turn was answered', async () => {
      const answer = await judge({ journal: () => [at(1, 'delegation.seen'), at(2, 'prompt.admitted'), at(3, 'answer.received')] })
      expect(answer.verdict).toBe('pass')
      expect(answer.checks.map(check => check.name)).toEqual(['key', 'route', 'session', 'delegation', 'turn'])
      expect(answer.checks.every(check => check.state === 'pass')).toBe(true)
    })

    it('fails on the closed session that has no responder behind it', async () => {
      // The two faults a caller can act on without reading anything else, reported together rather than one
      // at a time: a closed session and an unsteered delegation are independent, and fixing one leaves the
      // other.
      const answer = await judge({ status: () => CLOSED, steering: () => [] })
      expect(answer.verdict).toBe('fail')
      expect(answer.checks.find(check => check.name === 'session')?.detail).toContain('no session is open')
      expect(answer.checks.find(check => check.name === 'delegation')?.detail).toContain('answered by nobody')
    })

    it('fails the credential check when the route that would open reports nothing configured', async () => {
      // The failure with no other symptom: from outside, a route with no credential and a provider that is
      // down produce the same refusal.
      const answer = await judge({ providers: () => [{ id: 'openai-live', name: 'OpenAI Live', configured: false }] })
      expect(answer.checks.find(check => check.name === 'key')).toMatchObject({ state: 'fail' })
      expect(answer.checks.find(check => check.name === 'key')?.detail).toContain('NOT_CONFIGURED')
      expect(answer.verdict).toBe('fail')
    })

    it('waits on a route that does not report whether it is configured', async () => {
      // Not a pass. An adapter that says nothing has told us nothing, and a two-valued check would have to call
      // that fine — which is the check becoming one that cannot fail.
      const answer = await judge({ providers: () => [{ id: 'openai-live', name: 'OpenAI Live' }] })
      expect(answer.checks.find(check => check.name === 'key')).toMatchObject({ state: 'waiting' })
      expect(answer.verdict).toBe('partial')
    })

    it('fails when no adapter is registered for the route a session would use', async () => {
      const answer = await judge({ providers: () => [] })
      expect(answer.checks.find(check => check.name === 'key')?.detail).toContain('no adapter is registered')
    })

    it('fails the route check when nothing declares a transport', async () => {
      const answer = await judge({ transports: () => [] })
      expect(answer.checks.find(check => check.name === 'route')?.detail).toContain('no audio transport is declared')
      expect(answer.verdict).toBe('fail')
    })

    it('fails the route check when a transport has nothing attached', async () => {
      const answer = await judge({ transports: () => [{ path: '/dsh-realtime/audio', clients: 0 }] })
      expect(answer.checks.find(check => check.name === 'route')?.detail).toContain('has nothing attached')
    })

    it('names the transports that are attached, and not the ones that are not', async () => {
      const answer = await judge({
        transports: () => [{ path: '/quiet', clients: 0 }, { path: '/busy', clients: 2 }],
      })
      const route = answer.checks.find(check => check.name === 'route')
      expect(route).toMatchObject({ state: 'pass' })
      expect(route?.detail).toContain('/busy with 2 client(s)')
      expect(route?.detail).not.toContain('/quiet')
    })

    it('says nothing has been delegated yet rather than judging a turn that never happened', async () => {
      // The distinction a two-valued check would lose: not a pass, because the path is unproven; not a
      // failure, because the user may simply not have asked anything.
      const answer = await judge()
      expect(answer.verdict).toBe('partial')
      expect(answer.checks.find(check => check.name === 'turn')).toMatchObject({ state: 'waiting' })
    })

    it('names the session that is quiet when a turn was admitted and never answered', async () => {
      // The fault that reads as a broken voice and is really a busy session — the detail has to say which.
      const answer = await judge({ journal: () => [at(1, 'delegation.seen'), at(2, 'prompt.admitted'), at(3, 'window.elapsed')] })
      expect(answer.checks.find(check => check.name === 'turn')).toMatchObject({ state: 'fail' })
      expect(answer.checks.find(check => check.name === 'turn')?.detail).toContain('the session that is quiet')
    })

    it('distinguishes a refused delegation from an unanswered one', async () => {
      const answer = await judge({ journal: () => [at(1, 'delegation.seen'), at(2, 'prompt.refused')] })
      expect(answer.checks.find(check => check.name === 'turn')?.detail).toContain('refused')
    })

    it('waits on a delegation nothing has come of yet, and differs from one that is running', async () => {
      // Two ways to be waiting, and the detail tells them apart: a turn the responder never touched is a
      // different thing from one it admitted and is still working on.
      const answer = await judge({ journal: () => [at(1, 'delegation.seen')] })
      expect(answer.checks.find(check => check.name === 'turn')).toMatchObject({ state: 'waiting' })
      expect(answer.checks.find(check => check.name === 'turn')?.detail).toContain('nothing has come of it')
    })

    it('waits while an admitted turn is still running', async () => {
      const answer = await judge({ journal: () => [at(1, 'delegation.seen'), at(2, 'prompt.admitted')] })
      expect(answer.checks.find(check => check.name === 'turn')).toMatchObject({ state: 'waiting' })
    })

    it('judges the last delegation, not the first one that failed', async () => {
      // A turn that went wrong an hour ago is history. The question is what happened to the last one, so a
      // failure before the most recent delegation must not decide the verdict.
      const answer = await judge({
        journal: () => [
          at(1, 'delegation.seen'), at(2, 'window.elapsed'),
          at(3, 'delegation.seen'), at(4, 'prompt.admitted'), at(5, 'answer.received'),
        ],
      })
      expect(answer.verdict).toBe('pass')
    })
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
