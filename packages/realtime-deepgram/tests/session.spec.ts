import { describe, expect, it } from 'vitest'
import { REALTIME_ERROR_CODES, RealtimeError } from 'dsh-realtime'
import type { RealtimeSessionHandlers } from 'dsh-realtime'
import { buildSettings, openSession } from '../src/index.ts'
import type { DeepgramTransport, ServerFrame } from '../src/index.ts'

const settings = () => buildSettings({ think: { model: 'gpt-4o-mini', prompt: 'You are a probe.' } })

function transport(): DeepgramTransport & { frames: unknown[]; audio: Uint8Array[]; closes: number } {
  const frames: unknown[] = []
  const audio: Uint8Array[] = []
  const state = { closes: 0 }
  return {
    frames, audio,
    get closes() { return state.closes },
    send(frame) { frames.push(frame) },
    sendAudio(bytes) { audio.push(bytes) },
    async close() { state.closes += 1 },
  }
}

const recorder = (): RealtimeSessionHandlers & { transcripts: unknown[]; errors: RealtimeError[] } => {
  const transcripts: unknown[] = []
  const errors: RealtimeError[] = []
  return {
    transcripts, errors,
    onTranscript: transcript => { transcripts.push(transcript) },
    onError: error => { errors.push(error as RealtimeError) },
  }
}

/** Timers that never fire, so an acknowledgement can only be settled by a frame. */
const quietTimers = { schedule: () => 1, cancel: () => {} }
/** Timers that fire on the next microtask, so the acknowledgement bound can be tested without sleeping. */
const eagerTimers = { schedule: (fn: () => void) => { void Promise.resolve().then(fn); return 1 }, cancel: () => {} }

describe('openSession', () => {
  it('sends Settings immediately, because nothing else is legal until it is applied', () => {
    const wire = transport()
    openSession({ provider: 'deepgram', settings: settings(), transport: wire, handlers: recorder() })
    expect(wire.frames[0]).toMatchObject({ type: 'Settings' })
  })

  it('reports what it requested in `started`, and says so rather than implying the provider echoed it', () => {
    const session = openSession({ provider: 'deepgram-voice-agent', settings: settings(), transport: transport(), handlers: recorder() })
    expect(session.started).toEqual({
      provider: 'deepgram-voice-agent',
      model: 'gpt-4o-mini',
      voice: 'aura-2-thalia-en',
      inputAudio: { sampleRate: 16_000, channels: 1, encoding: 'pcm16' },
      outputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
    })
    expect(session.id).toBe('deepgram-voice-agent:gpt-4o-mini')
  })

  it('routes an utterance to onTranscript, marked final', () => {
    const handlers = recorder()
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers })
    session.receive({ type: 'ConversationText', role: 'user', content: 'hello' })
    expect(handlers.transcripts).toEqual([{ kind: 'input', text: 'hello', final: true }])
  })

  it('routes a latency report to onLatency, which the seam has no slot for', () => {
    const latencies: unknown[] = []
    const session = openSession({
      provider: 'd', settings: settings(), transport: transport(), handlers: recorder(),
      onLatency: latency => { latencies.push(latency) },
    })
    session.receive({ type: 'LatencyReport', total_latency: 0.5 })
    expect(latencies).toEqual([{ totalMs: 500 }])
    // Without the callback the report is simply not surfaced — it is not an error.
    openSession({ provider: 'd', settings: settings(), transport: transport(), handlers: recorder() })
      .receive({ type: 'LatencyReport', total_latency: 0.5 })
  })

  it('reports a refusal as an error, because a refused narration is a fact worth journalling', () => {
    const handlers = recorder()
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers })
    session.receive({ type: 'InjectionRefused', message: 'agent is speaking' })
    expect(handlers.errors[0]?.message).toBe('agent is speaking')
    expect(handlers.errors[0]?.code).toBe(REALTIME_ERROR_CODES.PROVIDER_ERROR)
  })

  it('reports a provider Error with its own description', () => {
    const handlers = recorder()
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers })
    session.receive({ type: 'Error', description: 'Check the agent.listen.provider.type field' })
    expect(handlers.errors[0]?.message).toContain('agent.listen.provider.type')
  })

  it('ignores frames it has no seam-level use for', () => {
    const handlers = recorder()
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers })
    for (const type of ['Welcome', 'SettingsApplied', 'UserStartedSpeaking', 'History', 'EndOfTurn']) session.receive({ type })
    expect(handlers.transcripts).toHaveLength(0)
    expect(handlers.errors).toHaveLength(0)
  })

  it('refuses appendThinking by code, because the provider declares it cannot', () => {
    // The alternative — speaking the text — would put the application's progress notes into the user's ear.
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers: recorder() })
    return expect(session.appendThinking('a step')).rejects.toMatchObject({ code: REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED })
  })

  it('speaks commentary by injecting an agent message', async () => {
    const wire = transport()
    const session = openSession({ provider: 'd', settings: settings(), transport: wire, handlers: recorder() })
    await session.appendCommentary('one moment')
    expect(wire.frames.at(-1)).toEqual({ type: 'InjectAgentMessage', message: 'one moment' })
  })

  it('refuses an empty or oversized append locally, rather than halfway through a conversation', async () => {
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers: recorder() })
    await expect(session.appendCommentary('   ')).rejects.toMatchObject({ code: REALTIME_ERROR_CODES.INVALID_APPEND })
    await expect(session.appendCommentary('x'.repeat(5000))).rejects.toMatchObject({ code: REALTIME_ERROR_CODES.INVALID_APPEND })
  })

  it('resolves appendInstructions only on the acknowledgement, not on the write', async () => {
    // P1 proved a turn started before `PromptUpdated` runs under the old prompt, so resolving on the write would
    // let a caller believe a rule was in force while the next turn ignored it.
    const wire = transport()
    const session = openSession({ provider: 'd', settings: settings(), transport: wire, handlers: recorder(), timers: quietTimers })
    let settled = false
    const pending = session.appendInstructions('be terse').then(() => { settled = true })
    await Promise.resolve()
    expect(wire.frames.at(-1)).toEqual({ type: 'UpdatePrompt', prompt: 'be terse' })
    expect(settled).toBe(false)
    session.receive({ type: 'PromptUpdated' })
    await pending
    expect(settled).toBe(true)
  })

  it('fails an append whose acknowledgement never arrives, rather than assuming it landed', async () => {
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers: recorder(), ackTimeoutMs: 50, timers: eagerTimers })
    await expect(session.appendInstructions('be terse')).rejects.toMatchObject({ code: REALTIME_ERROR_CODES.PROVIDER_TIMEOUT })
  })

  it('treats a completed utterance as an acknowledgement too, since the update applied', async () => {
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers: recorder(), timers: quietTimers })
    const pending = session.appendInstructions('be terse')
    session.receive({ type: 'AgentAudioDone' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('drops microphone audio while muted and resumes after unmute', () => {
    const wire = transport()
    const session = openSession({ provider: 'd', settings: settings(), transport: wire, handlers: recorder() })
    session.sendAudio(new Uint8Array([1]))
    session.muteInput()
    session.sendAudio(new Uint8Array([2]))
    session.unmuteInput()
    session.sendAudio(new Uint8Array([3]))
    expect(wire.audio).toHaveLength(2)
  })

  it('refuses audio after close with a coded error', () => {
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers: recorder() })
    void session.close()
    expect(() => session.sendAudio(new Uint8Array([1]))).toThrow(RealtimeError)
    try { session.sendAudio(new Uint8Array([1])) } catch (error) {
      expect((error as RealtimeError).code).toBe(REALTIME_ERROR_CODES.SESSION_CLOSED)
    }
  })

  it('closes the transport once and rejects an update still waiting for its ack', async () => {
    const wire = transport()
    const session = openSession({ provider: 'd', settings: settings(), transport: wire, handlers: recorder(), timers: quietTimers })
    const pending = session.appendInstructions('be terse')
    await session.close()
    await session.close()
    await expect(pending).rejects.toMatchObject({ code: REALTIME_ERROR_CODES.SESSION_CLOSED })
    expect(wire.closes).toBe(1)
  })

  it('ignores its own timeout when the acknowledgement already arrived', async () => {
    // The one guard that is reachable: a timer that fires after the ack must not reject a settled promise, or a
    // slow timer turns a working update into an unhandled rejection.
    const callbacks: (() => void)[] = []
    const capturing = { schedule: (fn: () => void) => { callbacks.push(fn); return 1 }, cancel: () => {} }
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers: recorder(), timers: capturing })
    const pending = session.appendInstructions('be terse')
    session.receive({ type: 'PromptUpdated' })
    await expect(pending).resolves.toBeUndefined()
    expect(() => callbacks.forEach(fn => fn())).not.toThrow()
  })

  it('uses the real clock and real timers when none are injected', async () => {
    // Both defaults are the production path; a suite that always injects timers leaves the shipped behaviour
    // unexercised. This one resolves on the ack, so the real 5 s bound is cleared rather than waited on.
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers: recorder() })
    const pending = session.appendInstructions('be terse')
    session.receive({ type: 'PromptUpdated' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('accepts a frame it does not understand without throwing', () => {
    const session = openSession({ provider: 'd', settings: settings(), transport: transport(), handlers: recorder() })
    expect(() => session.receive({ type: 'SomethingNew' } as ServerFrame)).not.toThrow()
  })
})
