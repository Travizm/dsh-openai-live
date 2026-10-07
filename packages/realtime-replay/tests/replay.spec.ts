import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OpenAiLiveAdapter } from 'dsh-realtime-openai'
import type { RealtimeSessionHandlers } from 'dsh-realtime'
import { parseRecording } from '../src/recording.ts'
import { REPLAY_CREDENTIAL } from '../src/index.ts'
import { ReplayTransportFactory } from '../src/transport.ts'

/**
 * The payoff: the **recorded live session** replayed through the **shipping adapter and session**.
 *
 * Nothing here is a stand-in except the origin of the bytes. The handshake, the translation, the
 * append correlation and the teardown are the code that ships, driven by what a real `gpt-live-1`
 * session actually sent on 2026-10-07 — with no key and no network.
 *
 * The recording is shared with the adapter's suite rather than duplicated: it is one artefact, and a
 * second copy would be a second thing to drift.
 */
const W1_RECORDING = new URL('../../realtime-openai/tests/fixtures/live-session.jsonl', import.meta.url)

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function replayAdapter(recording: ReturnType<typeof parseRecording>) {
  const transports = new ReplayTransportFactory(recording)
  const adapter = new OpenAiLiveAdapter({
    apiKey: REPLAY_CREDENTIAL,
    baseURL: 'wss://replay.invalid/v1/live/sessions',
    provider: 'replay',
    model: 'gpt-live-1',
    voice: 'marin',
    appendAckTimeoutMs: 2000,
    establishTimeoutMs: 2000,
  }, transports)
  return { adapter, transports }
}

describe('replaying the recorded live session', () => {
  it('drives the real adapter and session through the whole conversation', async () => {
    const recording = parseRecording(readFileSync(W1_RECORDING, 'utf8'), 'w1-live-session')
    const { adapter } = replayAdapter(recording)

    const transcripts: Array<{ kind: string; text: string }> = []
    const delegations: Array<{ id: string; target: string }> = []
    const usage: number[] = []
    let audioBytes = 0
    const handlers: RealtimeSessionHandlers = {
      onTranscript: t => transcripts.push({ kind: t.kind, text: t.text }),
      onDelegation: d => delegations.push({ id: d.id, target: d.target }),
      onUsage: u => usage.push(u.seconds),
      onAudio: pcm => { audioBytes += pcm.length },
    }

    const session = await adapter.session({ provider: 'replay', model: 'gpt-live-1', handlers })
    await tick()
    await tick()

    // The facts come from the recording, not from the request.
    expect(session.started).toMatchObject({ provider: 'replay', model: 'gpt-live-1', voice: 'marin' })
    expect(session.started.inputAudio).toEqual({ sampleRate: 24_000, channels: 1, encoding: 'pcm16' })

    // Both directions of the transcript, and real audio decoded to bytes.
    expect(transcripts.filter(t => t.kind === 'input').map(t => t.text).join(''))
      .toContain('deployment status of the staging environment')
    expect(transcripts.filter(t => t.kind === 'output').length).toBeGreaterThan(0)
    expect(audioBytes).toBeGreaterThan(0)

    // The delegation the recorded session raised, with its target and no invented task text.
    expect(delegations).toHaveLength(1)
    expect(delegations[0]?.target).toBe('client')
    expect(usage).toContain(7)
  })

  it('carries the client half of the conversation: the opening frame and the delegated result', async () => {
    const recording = parseRecording(readFileSync(W1_RECORDING, 'utf8'), 'w1-live-session')
    const { adapter, transports } = replayAdapter(recording)

    const delegations: Array<{ id: string }> = []
    const session = await adapter.session({
      provider: 'replay',
      model: 'gpt-live-1',
      handlers: { onDelegation: d => delegations.push({ id: d.id }) },
    })
    await tick()
    await tick()

    // A placeholder credential, and visibly not a secret: the transport never transmits it.
    expect(transports.headers[0]).toEqual({ Authorization: `Bearer ${REPLAY_CREDENTIAL}` })

    const sent = transports.sent.map(frame => JSON.parse(frame) as Record<string, unknown>)
    expect(sent[0]).toMatchObject({
      type: 'session.start',
      session: { model: 'gpt-live-1', delegation: { type: 'client' } },
    })

    // The recorded provider frames cannot contain an answer to a request that had not been made yet,
    // so the replay server answers appends itself — which is what lets this half be tested at all.
    const delegationId = delegations[0]?.id
    expect(delegationId).toBeDefined()
    await session.appendCommentary('staging is healthy', delegationId)
    await session.appendThinking('checked at 20:15')

    const after = transports.sent.map(frame => JSON.parse(frame) as Record<string, unknown>)
    expect(after.at(-2)).toMatchObject({
      type: 'session.commentary.append',
      content: 'staging is healthy',
      delegation_id: delegationId,
    })
    expect(after.at(-1)).toMatchObject({ type: 'session.thinking.append', delegation_id: null })
  })

  it('replays a recorded close and releases the transport', async () => {
    const recording = parseRecording(readFileSync(new URL('./fixtures/mini-session.jsonl', import.meta.url), 'utf8'), 'mini')
    const { adapter, transports } = replayAdapter(recording)

    const reasons: Array<string | undefined> = []
    const usage: number[] = []
    const session = await adapter.session({
      provider: 'replay',
      model: 'gpt-live-1',
      handlers: { onClosed: r => reasons.push(r), onUsage: u => usage.push(u.seconds) },
    })
    await tick()
    await tick()

    expect(reasons).toEqual(['completed'])
    // Usage is cumulative, so the same figure arriving on `session.closed` after `usage.updated` is
    // idempotent rather than additive — and surfacing both is faithful to what the provider sent.
    expect(usage).toEqual([2, 2])
    expect(transports.closed).toBe(true)
    // The frame after the recorded close is not delivered: a transport that has gone stays gone.
    expect(usage).not.toContain(3)
    await session.close()
  })
})
