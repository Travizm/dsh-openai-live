/**
 * The control channel, end to end.
 *
 * S2 story 2's acceptance: the plugin can be re-steered **without a console**, over the socket the client
 * already holds. Nothing here is a stub of the thing under test — the seam, the agent, the responder and
 * the audio route are the shipped plugins, mounted against substitutes only for the harness services they
 * inject, and the frames go over a real WebSocket handshake to a real `node:http` server.
 *
 * The two properties worth reading the rows for:
 *
 * - **A change on this channel reaches the next use.** The `steer` row changes the session mid-life and
 *   then asserts where the *next* delegation was admitted, which is the difference between a setting that
 *   is stored and one that is honoured.
 * - **The widening did not cost the audio path.** The socket still carries PCM16 in both directions, and
 *   a text frame is still never audio — the contract changed, and the frames that were there before are
 *   unchanged.
 */

import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import WebSocket from 'ws'
import RealtimeRuntime, {
  RealtimeAdapter,
  type Journal,
  type RealtimeSession,
  type RealtimeSessionHandlers,
  type RealtimeSessionOptions,
} from 'dsh-realtime'
import { Config as AgentConfig, apply as applyAgent, type RealtimeAgentConfig } from 'dsh-realtime-agent'
import { Config as ResponderConfig, apply as applyResponder, type RealtimeResponderConfig } from 'dsh-realtime-responder'
import { Config as AudioConfig, apply as applyAudio, type RealtimeAudioWsConfig } from 'dsh-realtime-audio-ws'

/** A session controller that records where each turn was admitted. */
class FakeController extends Service {
  readonly admitted: string[] = []

  constructor(context: Context) {
    super(context, 'sessionController')
  }

  prompt(request: { readonly sessionId: string }): Promise<{ accepted: true }> {
    this.admitted.push(request.sessionId)
    return Promise.resolve({ accepted: true })
  }
}

/** The tools service, with just enough shape for the agent to register its voice tools against. */
class FakeTools extends Service {
  constructor(context: Context) {
    super(context, 'tools')
  }

  register(): () => void {
    return () => undefined
  }
}

/** The two registration doors the audio route claims. */
class FakeWebServer extends Service {
  readonly upgrades = new Map<string, (req: unknown, socket: unknown, head: unknown) => unknown>()
  readonly routes = new Map<string, (req: unknown, res: unknown) => unknown>()
  readonly config = { port: 19387, host: '127.0.0.1' }

  constructor(context: Context) {
    super(context, 'webServer')
  }

  registerUpgrade(route: { path: string; handler: (req: never, socket: never, head: never) => unknown }): () => void {
    this.upgrades.set(route.path, route.handler as unknown as (req: unknown, socket: unknown, head: unknown) => unknown)
    return () => { this.upgrades.delete(route.path) }
  }

  register(route: { path: string; handler: (req: never, res: never) => unknown }): () => void {
    this.routes.set(route.path, route.handler as unknown as (req: unknown, res: unknown) => unknown)
    return () => { this.routes.delete(route.path) }
  }
}

/** The connection service, whose verdict door the audio route consults. Always unobjectionable here. */
class FakeConnection extends Service {
  constructor(context: Context) {
    super(context, 'connection')
  }

  requestRejection(): undefined {
    return undefined
  }
}

/** A provider that opens on demand, records what reached it, and says nothing until told to. */
class FakeProvider extends RealtimeAdapter {
  readonly audio: Uint8Array[] = []
  handlers: RealtimeSessionHandlers | undefined
  opened = 0

  session(options: RealtimeSessionOptions): Promise<RealtimeSession> {
    // Wired exactly as a real adapter wires them: a substitute that dropped the handlers would make every
    // injected event vanish, and these rows would then be testing this file.
    this.handlers = options.handlers
    this.opened += 1
    const provider = this
    return Promise.resolve({
      id: 'sess-voice',
      started: {
        provider: 'fake',
        model: 'gpt-live-1',
        voice: 'marin',
        inputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
        outputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
      },
      sendAudio(pcm16: Uint8Array): void { provider.audio.push(pcm16) },
      muteInput(): void {},
      unmuteInput(): void {},
      appendCommentary: () => Promise.resolve(),
      appendThinking: () => Promise.resolve(),
      appendInstructions: () => Promise.resolve(),
      close: () => {
        provider.handlers?.onClosed?.()
        return Promise.resolve()
      },
    })
  }
}

interface Mounted {
  readonly context: Context
  readonly provider: FakeProvider
  readonly controller: FakeController
  readonly journal: Journal
  readonly client: WebSocket
  /** Send one control frame and return its reply, as the client half will. */
  readonly ask: (frame: string) => Promise<Record<string, unknown>>
}

let cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

/**
 * Mount the bundle and attach one authenticated socket.
 * @returns the mounted pieces, the socket, and the frame helper.
 */
async function mount(): Promise<Mounted> {
  const context = new Context()
  const seam = new RealtimeRuntime(context)
  const controller = new FakeController(context)
  const web = new FakeWebServer(context)
  new FakeTools(context)
  new FakeConnection(context)
  const provider = new FakeProvider()
  context.realtime.registerAdapter(['fake'], provider)

  applyAgent(context, AgentConfig({ provider: 'fake' }) as RealtimeAgentConfig)
  applyResponder(context, ResponderConfig({ sessionId: 'sess-1', answerTimeoutMs: 45_000 }) as RealtimeResponderConfig)
  applyAudio(context, AudioConfig({}) as RealtimeAudioWsConfig)
  // The audio route's `ctx.inject` lands on a microtask once the services it named are visible.
  await Promise.resolve()
  await Promise.resolve()

  const table: Array<{ name: string; value: { path: string; token: string } }> = []
  ;(context.emit as unknown as (name: string, emitted: unknown[]) => void)('webserver/index-inject', table)
  const row = table[0]!.value

  const server: Server = createServer()
  server.on('upgrade', (req, socket, head) => {
    const handler = web.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) { socket.destroy(); return }
    void handler(req, socket, head)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as { port: number }

  // Connecting is what asks the agent to open the session, so the voice is live by the time the first
  // frame is sent — the same path a microphone takes.
  const client = new WebSocket(`ws://127.0.0.1:${String(port)}${row.path}?t=${row.token}`)
  await once(client, 'open')
  await new Promise((resolve) => { setTimeout(resolve, 20) })

  cleanups.push(async () => {
    client.terminate()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await context.fiber.dispose()
  })

  return {
    context,
    provider,
    controller,
    journal: seam.journal,
    client,
    ask: async (frame: string): Promise<Record<string, unknown>> => {
      const reply = once(client, 'message')
      client.send(frame)
      const [data] = await reply
      return JSON.parse(String(data)) as Record<string, unknown>
    },
  }
}

describe('status', () => {
  it('reports the live voice, every setting, and what this route is carrying', async () => {
    const { ask, provider } = await mount()
    const reply = await ask('status')

    expect(reply).toMatchObject({
      ok: true,
      verb: 'status',
      audio: { path: '/dsh-realtime/audio', clients: 1 },
      voice: { open: true, provider: 'fake', model: 'gpt-live-1', voice: 'marin', sessionId: 'sess-voice' },
    })
    expect(provider.opened).toBe(1)
    const settings = reply.settings as Array<{ key: string; scope: string }>
    expect(settings.map(entry => entry.key)).toContain('realtime-responder.sessionId')
    expect(settings.map(entry => entry.key)).toContain('realtime-agent.autoStart')
  })
})

describe('a change over the channel', () => {
  it('steers the voice at another session, and the next turn goes there', async () => {
    const { ask, controller, provider, journal } = await mount()

    expect(await ask('steer session-ea70184a')).toEqual({
      ok: true,
      verb: 'steer',
      key: 'realtime-responder.sessionId',
      value: 'session-ea70184a',
    })
    expect(journal.snapshot().map(entry => entry.detail.key)).toContain('realtime-responder.sessionId')

    // The point of the channel: the change reaches the next *use*, not the next boot.
    provider.handlers?.onTranscript?.({ kind: 'input', text: 'is staging ok?', final: true })
    provider.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(controller.admitted).toEqual(['session-ea70184a'])
  })

  it('applies a shorter answer window to the next turn', async () => {
    const { ask, controller, provider, journal, context } = await mount()
    const settled: string[] = []
    context.on('realtime-agent/delegation-settled', (settlement: { readonly outcome: string }) => { settled.push(settlement.outcome) })

    expect(await ask('set realtime-responder.answerTimeoutMs=5')).toMatchObject({ ok: true, value: 5 })

    provider.handlers?.onTranscript?.({ kind: 'input', text: 'is staging ok?', final: true })
    provider.handlers?.onDelegation?.({ id: 'item_1', target: 'client', offsetMs: 0 })
    await new Promise((resolve) => { setTimeout(resolve, 80) })

    // Admitted, and nothing answered inside five milliseconds — so the turn went quiet, the channel's
    // change is what made it quiet, and the journal says which kind of quiet it was.
    expect(controller.admitted).toHaveLength(1)
    expect(settled).toEqual(['timeout'])
    expect(journal.snapshot().map(entry => entry.kind)).toEqual(
      expect.arrayContaining(['prompt.admitted', 'window.elapsed']),
    )
  })

  it('refuses a frozen field with the reason, on the same channel', async () => {
    const { ask } = await mount()
    expect(await ask('set realtime-agent.autoStart=true')).toEqual({
      ok: false,
      verb: 'set',
      key: 'realtime-agent.autoStart',
      code: 'FROZEN_SETTING',
      reason: '"realtime-agent.autoStart" is claimed when the plugin loads — restart to change it',
    })
  })

  it('refuses a verb it does not have, and names the ones it does', async () => {
    const { ask } = await mount()
    expect(await ask('frobnicate')).toMatchObject({ ok: false, code: 'UNKNOWN_VERB' })
  })
})

describe('start and stop over the channel', () => {
  it('stops the live session and opens it again, reporting which happened', async () => {
    const { ask, provider } = await mount()

    expect(await ask('stop')).toMatchObject({ ok: true, verb: 'stop', voice: { open: false } })
    expect(await ask('status')).toMatchObject({ voice: { open: false } })
    expect(await ask('start')).toMatchObject({ ok: true, verb: 'start', voice: { open: true, sessionId: 'sess-voice' } })
    // Idempotent, like the tool: a second ask must not leave two sessions nobody can see.
    expect(await ask('start')).toMatchObject({ ok: true, voice: { open: true } })
    expect(provider.opened).toBe(2)
  })
})

describe('the audio path it widened', () => {
  it('still carries binary frames to the session, and never a text frame', async () => {
    const { client, ask, provider } = await mount()

    client.send(new Uint8Array([1, 2, 3]))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(provider.audio.map(frame => Array.from(frame))).toEqual([[1, 2, 3]])

    // A control frame is answered and is not audio: the two are told apart by the frame's own type, which
    // is why the widening cost the audio path nothing.
    await ask('status')
    expect(provider.audio).toHaveLength(1)
  })
})
