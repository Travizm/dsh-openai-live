import { describe, expect, it } from 'vitest'
import { Journal } from 'dsh-realtime'
import type { RealtimeSessionRequestOutcome, RealtimeVoiceStatus } from 'dsh-realtime-agent'
import { createControlHandler, parseControlFrame, type ControlDeps } from '../src/control.ts'

/** A frame's reply, read back as the client half will read it. */
const replyOf = async (deps: ControlDeps, frame: string): Promise<Record<string, unknown>> =>
  JSON.parse(await createControlHandler(deps)(frame)) as Record<string, unknown>

const voice: RealtimeVoiceStatus = { open: true, provider: 'openai-live', model: 'gpt-live-1', voice: 'marin', sessionId: 'sess-1' }

/**
 * The deps, with every edge injectable.
 *
 * A settings surface with one live string setting (`sessionId`), one live number and one frozen boolean —
 * enough to exercise every path a verb can take, including both frozen classes.
 */
function deps(over: Partial<ControlDeps> = {}) {
  const held = { sessionId: 'sess-1', budget: 1_000 }
  const journal = new Journal()
  journal.record('socket.accepted', { clients: '1' })
  const settings = {
    list: () => [
      { key: 'realtime-responder.sessionId', owner: 'realtime-responder', field: 'sessionId', kind: 'string' as const, scope: 'live' as const, value: held.sessionId },
      { key: 'realtime-responder.answerTimeoutMs', owner: 'realtime-responder', field: 'answerTimeoutMs', kind: 'number' as const, scope: 'live' as const, value: held.budget },
      { key: 'realtime-agent.autoStart', owner: 'realtime-agent', field: 'autoStart', kind: 'boolean' as const, scope: 'restart' as const, value: false },
    ],
    apply: (key: string, text: string) => {
      if (key === 'realtime-responder.sessionId') {
        if (text.length === 0) return { ok: false as const, key, code: 'INVALID_SETTING' as const, reason: 'sessionId must be non-empty' }
        held.sessionId = text
        return { ok: true as const, key, value: held.sessionId }
      }
      if (key === 'realtime-responder.answerTimeoutMs') {
        const value = Number(text)
        if (!Number.isFinite(value)) return { ok: false as const, key, code: 'INVALID_SETTING' as const, reason: 'answerTimeoutMs must be a number' }
        held.budget = value
        return { ok: true as const, key, value }
      }
      return { ok: false as const, key, code: 'FROZEN_SETTING' as const, reason: `"${key}" is claimed when the plugin loads — restart to change it` }
    },
  }
  const base: ControlDeps = {
    settings,
    journal,
    path: '/dsh-realtime/audio',
    clients: () => 1,
    voice: () => Promise.resolve(voice),
    request: (verb) => Promise.resolve<RealtimeSessionRequestOutcome>({
      ok: true,
      voice: verb === 'start' ? voice : { open: false, provider: 'openai-live', model: 'gpt-live-1' },
    }),
    ...over,
  }
  return { deps: base, held }
}

describe('parseControlFrame', () => {
  it('reads the three verbs that take no argument', () => {
    for (const verb of ['status', 'start', 'stop'] as const) {
      expect(parseControlFrame(verb)).toEqual({ ok: true, verb })
    }
  })

  it('tolerates the line ending and leading whitespace, and nothing else', () => {
    // A frame is a line, and a console or a shell may hand one over with either; the value is not
    // whitespace-normalised, because these are two different requests and only one of them is intended.
    expect(parseControlFrame('  status\n')).toEqual({ ok: true, verb: 'status' })
    expect(parseControlFrame('set realtime-responder.sessionId= 5')).toEqual({
      ok: true,
      verb: 'set',
      key: 'realtime-responder.sessionId',
      value: ' 5',
    })
  })

  it('reads steer with its session id', () => {
    expect(parseControlFrame('steer session-ea70184a')).toEqual({ ok: true, verb: 'steer', sessionId: 'session-ea70184a' })
  })

  it('reads set, splitting on the first = and keeping the rest whole', () => {
    // A value may contain `=`, and splitting on the last one would silently cut a session id in half.
    expect(parseControlFrame('set realtime-responder.sessionId=a=b')).toEqual({
      ok: true,
      verb: 'set',
      key: 'realtime-responder.sessionId',
      value: 'a=b',
    })
    expect(parseControlFrame('set    k=v   ')).toEqual({ ok: true, verb: 'set', key: 'k', value: 'v   ' })
  })

  it('refuses a verb it does not have, and names the ones it does', () => {
    const refusal = parseControlFrame('frobnicate')
    expect(refusal).toMatchObject({ ok: false, verb: 'frobnicate', code: 'UNKNOWN_VERB' })
    // The vocabulary, in the reason: a typo answered with silence is how a user concludes the feature
    // does not exist.
    expect((refusal as { reason: string }).reason).toContain('status, start, stop, steer, set')
    expect(parseControlFrame('STATUS')).toMatchObject({ code: 'UNKNOWN_VERB' })
    expect(parseControlFrame('')).toMatchObject({ code: 'UNKNOWN_VERB' })
  })

  it('refuses an argument where none belongs', () => {
    const refusal = parseControlFrame('status now')
    expect(refusal).toMatchObject({ ok: false, verb: 'status', code: 'INVALID_CONTROL' })
    expect((refusal as { reason: string }).reason).toBe('"status" takes no argument, received "now"')
  })

  it('redacts what it quotes back, so a stray credential does not return for display', () => {
    const planted = ['sk', 'control', 'sentinelmustneverappear'].join('-')
    const refusal = parseControlFrame(`status ${planted}`)
    expect((refusal as { reason: string }).reason).not.toContain('sentinelmustneverappear')
    expect((refusal as { reason: string }).reason).toContain('[redacted]')
  })

  it('refuses a malformed steer or set, rather than guessing what was meant', () => {
    expect(parseControlFrame('steer')).toMatchObject({ ok: false, verb: 'steer', code: 'INVALID_CONTROL' })
    expect(parseControlFrame('steer   ')).toMatchObject({ ok: false, verb: 'steer', code: 'INVALID_CONTROL' })
    expect(parseControlFrame('set')).toMatchObject({ ok: false, verb: 'set', code: 'INVALID_CONTROL' })
    expect(parseControlFrame('set nope')).toMatchObject({ ok: false, verb: 'set', code: 'INVALID_CONTROL' })
    expect(parseControlFrame('set =5')).toMatchObject({ ok: false, verb: 'set', code: 'INVALID_CONTROL' })
  })
})

describe('status', () => {
  it('reports this route, the voice, every setting and the journal tail', async () => {
    const { deps: harness } = deps()
    const reply = await replyOf(harness, 'status')

    expect(reply.ok).toBe(true)
    expect(reply.audio).toEqual({ path: '/dsh-realtime/audio', clients: 1 })
    expect(reply.voice).toEqual(voice)
    expect(reply.settings).toHaveLength(3)
    expect(reply.journal).toMatchObject({ size: 1, oldestSeq: 1, last: { kind: 'socket.accepted', seq: 1 } })
  })

  it('says `null` for the voice when nothing answers the query, which is not the same as closed', async () => {
    // No agent row mounted. `null` is "nobody answered"; `{open: false}` is "asked, and it is not open" —
    // and a status that collapsed those two would be the same class of report this project exists to replace.
    const { deps: harness } = deps({ voice: () => Promise.resolve(undefined) })
    expect((await replyOf(harness, 'status')).voice).toBeNull()
  })

  it('refuses the whole verb when the query fails, rather than reporting a partial status', async () => {
    // A status that silently omitted whether voice is live reads as a healthy one. The refusal is the only
    // honest answer; the reason names the class and never the message.
    const { deps: harness } = deps({ voice: () => Promise.reject(new TypeError('the provider refused key')) })
    expect(await replyOf(harness, 'status')).toEqual({
      ok: false,
      verb: 'status',
      code: 'CONTROL_FAILED',
      reason: 'the voice status query failed: TypeError',
    })
  })

  it('reports an empty journal as empty rather than as unknown', async () => {
    const { deps: harness } = deps({ journal: new Journal() })
    expect((await replyOf(harness, 'status')).journal).toEqual({ size: 0, last: null })
  })
})

describe('start and stop', () => {
  it('answers with the session that opened, not with an acknowledgement that it asked', async () => {
    const { deps: harness } = deps()
    expect(await replyOf(harness, 'start')).toEqual({ ok: true, verb: 'start', voice })
  })

  it('answers a stop with the state afterwards', async () => {
    const { deps: harness } = deps()
    expect(await replyOf(harness, 'stop')).toEqual({
      ok: true,
      verb: 'stop',
      voice: { open: false, provider: 'openai-live', model: 'gpt-live-1' },
    })
  })

  it('carries the refusal when the request did not achieve what it asked for', async () => {
    const { deps: harness } = deps({
      request: () => Promise.resolve({
        ok: false,
        voice: { open: false, provider: 'openai-live', model: 'gpt-live-1' },
        refusal: { code: 'NOT_CONFIGURED', remedy: 'Set OPENAI_LIVE_API_KEY, then try again.' },
      }),
    })
    expect(await replyOf(harness, 'start')).toEqual({
      ok: false,
      verb: 'start',
      voice: { open: false, provider: 'openai-live', model: 'gpt-live-1' },
      refusal: { code: 'NOT_CONFIGURED', remedy: 'Set OPENAI_LIVE_API_KEY, then try again.' },
    })
  })

  it('says the agent is missing rather than pretending the request was made', async () => {
    // `undefined` from the dispatch means no listener: the row is absent or has not loaded. Naming that is
    // the difference between a profile missing a row and a plugin that is broken.
    const { deps: harness } = deps({ request: () => Promise.resolve(undefined) })
    expect(await replyOf(harness, 'start')).toEqual({
      ok: false,
      verb: 'start',
      code: 'CONTROL_FAILED',
      reason: 'nothing answered the start request — is a realtime agent mounted in this profile?',
    })
  })

  it('refuses rather than dropping the frame when the request throws', async () => {
    const { deps: harness } = deps({ request: () => Promise.reject(new RangeError('nope')) })
    expect(await replyOf(harness, 'stop')).toMatchObject({
      ok: false,
      verb: 'stop',
      code: 'CONTROL_FAILED',
      reason: 'the stop request failed: RangeError',
    })
  })
})

describe('steer', () => {
  it('changes the setting that declares a live sessionId', async () => {
    const { deps: harness, held } = deps()
    expect(await replyOf(harness, 'steer session-ea70184a')).toEqual({
      ok: true,
      verb: 'steer',
      key: 'realtime-responder.sessionId',
      value: 'session-ea70184a',
    })
    expect(held.sessionId).toBe('session-ea70184a')
  })

  it('refuses when nothing declares one, and says what to use instead', async () => {
    const { deps: harness } = deps({
      settings: {
        list: () => [],
        apply: () => ({ ok: false as const, key: 'x', code: 'UNKNOWN_SETTING' as const, reason: 'no' }),
      },
    })
    expect(await replyOf(harness, 'steer sess-1')).toMatchObject({ ok: false, code: 'NO_STEER_TARGET' })
  })

  it('refuses when several declare one, and names them', async () => {
    const { deps: harness } = deps({
      settings: {
        list: () => [
          { key: 'a.sessionId', owner: 'a', field: 'sessionId', kind: 'string' as const, scope: 'live' as const, value: 'x' },
          { key: 'b.sessionId', owner: 'b', field: 'sessionId', kind: 'string' as const, scope: 'live' as const, value: 'y' },
        ],
        apply: () => ({ ok: true as const, key: 'a.sessionId', value: 'z' }),
      },
    })
    const reply = await replyOf(harness, 'steer sess-1')
    expect(reply).toMatchObject({ ok: false, code: 'AMBIGUOUS_STEER_TARGET' })
    expect(reply.reason).toBe('2 plugins declare a sessionId (a.sessionId, b.sessionId) — use set <key>=<value>')
  })
})

describe('set', () => {
  it('applies the change and reports the value the setting now holds', async () => {
    const { deps: harness, held } = deps()
    expect(await replyOf(harness, 'set realtime-responder.answerTimeoutMs=90000')).toEqual({
      ok: true,
      verb: 'set',
      key: 'realtime-responder.answerTimeoutMs',
      value: 90_000,
    })
    expect(held.budget).toBe(90_000)
  })

  it('carries a frozen field’s refusal, with the key and the reason', async () => {
    const { deps: harness } = deps()
    expect(await replyOf(harness, 'set realtime-agent.autoStart=true')).toEqual({
      ok: false,
      verb: 'set',
      key: 'realtime-agent.autoStart',
      code: 'FROZEN_SETTING',
      reason: '"realtime-agent.autoStart" is claimed when the plugin loads — restart to change it',
    })
  })

  it("carries the setting's own refusal, which is the constraint a caller can act on", async () => {
    const { deps: harness } = deps()
    expect(await replyOf(harness, 'set realtime-responder.sessionId=')).toEqual({
      ok: false,
      verb: 'set',
      key: 'realtime-responder.sessionId',
      code: 'INVALID_SETTING',
      reason: 'sessionId must be non-empty',
    })
  })
})

describe('the handler’s guarantees', () => {
  it('answers every frame it is given, including one it cannot parse', async () => {
    const { deps: harness } = deps()
    for (const frame of ['status', 'nonsense', 'set', 'steer', '']) {
      const text = await createControlHandler(harness)(frame)
      expect(() => JSON.parse(text) as unknown).not.toThrow()
      expect(JSON.parse(text)).toHaveProperty('ok')
    }
  })

  it('refuses rather than rejecting when one of its own edges throws', async () => {
    // The caller writes the reply into a socket and has no one to catch a rejection, so this has to be a
    // refusal: a control frame that produces nothing at all is indistinguishable from one never sent.
    const { deps: harness } = deps({
      clients: () => { throw new Error('the route is gone') },
    })
    expect(await replyOf(harness, 'status')).toEqual({
      ok: false,
      verb: '',
      code: 'CONTROL_FAILED',
      reason: 'the control handler failed: Error',
    })
  })

  it('names what was thrown when it is not an Error at all', async () => {
    // A rejection that is not an Error still has to be nameable — `undefined is not a function` in a
    // reason is a bug report; `string` is a starting point.
    const { deps: harness } = deps({ voice: () => Promise.reject('the agent gave up') })
    expect(await replyOf(harness, 'status')).toEqual({
      ok: false,
      verb: 'status',
      code: 'CONTROL_FAILED',
      reason: 'the voice status query failed: string',
    })
    const { deps: broken } = deps({ clients: () => { throw 7 } })
    expect(await replyOf(broken, 'status')).toMatchObject({ reason: 'the control handler failed: number' })
  })
})
