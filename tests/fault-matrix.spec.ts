/**
 * The fault matrix.
 *
 * Five failures a live voice session can suffer, each driven end to end through the **real** seam, the
 * real responder, the real agent and the real audio route, then read back from one journal. Nothing
 * here is a stub of the thing under test: the plugins are the shipped ones, mounted against substitutes
 * only for the harness services they inject.
 *
 * The point is not that each fault is noticed. It is that the five are **distinguishable** — a reader
 * holding only the journal can tell a controller that refused from a responder that never answered, and
 * an append the provider acknowledged from audio anybody heard. A diagnostics layer whose faults all
 * look alike answers "something went wrong" and nothing else, which is the failure mode this sprint
 * exists to remove.
 *
 * Two rows are worth reading before the tests.
 *
 * The **barge-in** row asserts an absence, against the recorded live session rather than against an
 * assumption. The provider's vocabulary carries no interruption event — measured across every type in
 * `live-session.jsonl`, and design invariant 2 forbids the host detecting one for itself, because
 * endpointing belongs to the engine. So there is nothing honest to record, and a matrix that recorded
 * something would be inventing it. Two other checks guard the same claim from outside: the scheduled
 * protocol canary fails the day the live vocabulary grows an interruption event, and the redaction
 * sweep fails if an entry for one ever reaches a sink.
 *
 * The **socket** row mounts a real HTTP server and makes a real WebSocket handshake, because the audio
 * route's producer runs inside an upgrade handler: a fake socket would prove the call happens and say
 * nothing about whether the route accepts, serves and notices a departure.
 */

import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import WebSocket from 'ws'
import RealtimeRuntime, {
  RealtimeAdapter,
  type Journal,
  type RealtimeDelegation,
  type RealtimeDelegationSettlement,
  type RealtimeSession,
  type RealtimeSessionHandlers,
  type RealtimeSessionOptions,
} from 'dsh-realtime'
import {
  Config as AgentConfig,
  apply as applyAgent,
  type RealtimeAgentConfig,
} from 'dsh-realtime-agent'
import {
  Config as ResponderConfig,
  apply as applyResponder,
  type RealtimeResponderConfig,
} from 'dsh-realtime-responder'
import {
  Config as AudioConfig,
  DEFAULT_PATH,
  TOKEN_PARAM,
  apply as applyAudio,
  type RealtimeAudioWsConfig,
} from 'dsh-realtime-audio-ws'

/**
 * The value the controller leaks and the redaction must catch.
 *
 * Deliberately not credential-shaped. The thing that must never escape by this route in production is
 * the route's capability token — 32 random base64url bytes, which match no pattern at all — so a
 * sentinel that looked like a vendor key would be testing an easier case than the one that matters. It
 * is assembled at runtime rather than written as a literal for the same reason a fixture is: the leak
 * scan reads files, and a credential-shaped constant in one is a finding whichever way it reads.
 */
const SECRET = ['route', 'token', 'fault', String(Math.trunc(Math.random() * 1e9)), 'sentinel'].join('.')

/** A delegation as the provider raises one: metadata only, no task text (see the seam's contract). */
const DELEGATION: RealtimeDelegation = { id: 'item_1', target: 'client', offsetMs: 0 }

/** The assistant's reply, as the session controller reports it. */
const ANSWER_EVENT = {
  type: 'assistant/message',
  sessionId: 'sess-1',
  surfaceOp: 'append',
  data: { message: { content: [{ type: 'text', text: 'Staging is green.' }] } },
}

/** The recorded live session — evidence of what the provider actually sends. */
const FIXTURE = fileURLToPath(new URL('../packages/realtime-openai/tests/fixtures/live-session.jsonl', import.meta.url))

/** A session controller that admits turns, and can be told to refuse one with words of its choosing. */
class FakeController extends Service {
  refusal: string | undefined
  readonly prompted: Array<{ readonly sessionId: string; readonly mode: string }> = []

  constructor(context: Context) {
    super(context, 'sessionController')
  }

  prompt(request: { readonly sessionId: string; readonly mode: string }): Promise<{ accepted: true }> {
    this.prompted.push({ sessionId: request.sessionId, mode: request.mode })
    // A refusal is a rejection, which is how the real controller reports one and how the responder
    // distinguishes it from an admission nobody answered.
    if (this.refusal !== undefined) return Promise.reject(new Error(this.refusal))
    return Promise.resolve({ accepted: true })
  }
}

/** The tools service, with just enough shape for the agent to register its voice tools against. */
class FakeTools extends Service {
  readonly registered: string[] = []

  constructor(context: Context) {
    super(context, 'tools')
  }

  register(definition: { readonly name: string }): () => void {
    this.registered.push(definition.name)
    return () => undefined
  }
}

/** The web server, with the two registration doors the audio route uses. */
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

/** A provider that opens on demand and says nothing until a test tells it to. */
class FakeProvider extends RealtimeAdapter {
  readonly appends: Array<{ kind: string; text: string; delegationId: string | undefined }> = []
  handlers: RealtimeSessionHandlers | undefined
  opened = 0
  closed = 0

  session(options: RealtimeSessionOptions): Promise<RealtimeSession> {
    // Wire the handlers exactly as a real adapter does. A substitute that dropped them would make every
    // injected event vanish, and the matrix would then be debugging this file instead of the plugins.
    this.handlers = options.handlers
    this.opened += 1
    const provider = this
    return Promise.resolve({
      id: 'sess-1',
      started: {
        provider: 'fake',
        model: 'gpt-live-1',
        inputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
        outputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
      },
      sendAudio(): void {},
      muteInput(): void {},
      unmuteInput(): void {},
      appendCommentary(text: string, delegationId: string | undefined) {
        provider.appends.push({ kind: 'commentary', text, delegationId })
        return Promise.resolve()
      },
      appendThinking(text: string, delegationId: string | undefined) {
        provider.appends.push({ kind: 'thinking', text, delegationId })
        return Promise.resolve()
      },
      appendInstructions: () => Promise.resolve(),
      close: () => {
        provider.closed += 1
        provider.handlers?.onClosed?.()
        return Promise.resolve()
      },
    })
  }
}

/** Everything a row needs, mounted once. */
interface Mounted {
  readonly context: Context
  readonly provider: FakeProvider
  readonly controller: FakeController
  readonly web: FakeWebServer
  readonly journal: Journal
  readonly token: string
}

/**
 * Mount the whole bundle on one context.
 * @param over - responder configuration for the row, when the row is about the responder.
 * @returns the mounted pieces.
 */
async function harness(
  // Written out rather than taken from `Partial<RealtimeResponderConfig>`: that type's readonly fields
  // are not what the config Schema accepts as input, so the spread does not typecheck.
  over: { responder?: { sessionId?: string; answerTimeoutMs?: number; redactSecrets?: string[] } } = {},
): Promise<Mounted> {
  const context = new Context()
  const seam = new RealtimeRuntime(context)
  const controller = new FakeController(context)
  const tools = new FakeTools(context)
  const web = new FakeWebServer(context)
  const connection = new FakeConnection(context)
  const provider = new FakeProvider()
  // Registered before anything can start a session: an agent with no route for its provider would open
  // nothing, and every row would then pass for the wrong reason.
  context.realtime.registerAdapter(['fake'], provider)

  applyAgent(context, AgentConfig({ provider: 'fake' }) as RealtimeAgentConfig)
  applyResponder(
    context,
    ResponderConfig({ sessionId: 'sess-1', answerTimeoutMs: 45_000, ...over.responder }) as RealtimeResponderConfig,
  )
  applyAudio(context, AudioConfig({}) as RealtimeAudioWsConfig)

  // The `ctx.inject` callbacks land on a microtask once every service they named is visible.
  await Promise.resolve()
  await Promise.resolve()

  // The page's settings row, emitted exactly as the host emits it. The token exists nowhere else, so
  // reading it out of the row is the same thing the client half does.
  const table: Array<{ name: string; value: { token: string } }> = []
  ;(context.emit as unknown as (name: string, emitted: unknown[]) => void)('webserver/index-inject', table)

  void tools
  void connection
  return { context, provider, controller, web, journal: seam.journal, token: table[0]!.value.token }
}

/** The kinds the journal recorded, in order. The thing every row is really asserting about. */
function signature(journal: Journal): string {
  return journal.snapshot().map(entry => entry.kind).join(' > ')
}

/** Resolve when the responder settles a turn, so a row never races a timer. */
function nextSettlement(mounted: Mounted): Promise<RealtimeDelegationSettlement> {
  return new Promise((resolve) => {
    mounted.context.on('realtime-agent/delegation-settled', (settlement: RealtimeDelegationSettlement) => {
      resolve(settlement)
    })
  })
}

/** Open the session the agent owns, which every row but the socket ones needs before a turn can arrive. */
async function start(mounted: Mounted): Promise<void> {
  mounted.context.emit('realtime-agent/start')
  await vi.waitFor(() => {
    expect(mounted.journal.snapshot().some(entry => entry.kind === 'session.opened')).toBe(true)
  })
}

/**
 * Raise one delegation the way a provider does: the words it heard first, then the turn.
 *
 * A delegation carries metadata only — there is deliberately no task text in it — so the responder
 * reconstructs intent from the transcript. A matrix that raised turns with no transcript would have the
 * responder decline for want of a prompt, and every row would then be asserting about the same
 * accidental decline instead of about the fault it names.
 * @param mounted - the composition.
 * @param spoken - what the model heard.
 */
function raised(mounted: Mounted, spoken = 'is staging ok?'): void {
  mounted.provider.handlers?.onTranscript?.({ kind: 'input', text: spoken, final: true })
  mounted.provider.handlers?.onDelegation?.(DELEGATION)
}

/** A controller that refuses a turn, in words that carry a value only the caller knows. */
async function driveRefusal(): Promise<Journal> {
  const mounted = await harness({ responder: { redactSecrets: [SECRET] } })
  mounted.controller.refusal = `upgrade refused for token ${SECRET}`

  const settled = nextSettlement(mounted)
  await start(mounted)
  raised(mounted)
  await settled

  return mounted.journal
}

/** A responder that admits a turn and then never answers it. */
async function driveTimeout(): Promise<Journal> {
  // A window short enough to wait for, and real: the responder's own timer, not a stubbed clock.
  const mounted = await harness({ responder: { answerTimeoutMs: 20 } })

  const settled = nextSettlement(mounted)
  await start(mounted)
  raised(mounted)
  await settled

  return mounted.journal
}

/** A turn answered, appended, and acknowledged — with nothing ever reaching a speaker. */
async function driveAckedWithoutPlayback(): Promise<Journal> {
  const mounted = await harness()

  await start(mounted)
  raised(mounted)
  // Let the responder admit before the answer arrives, so the row is an answered turn and not a race.
  await vi.waitFor(() => {
    expect(mounted.controller.prompted).toHaveLength(1)
  })
  // `session/event` listeners take (session, event); the session is unused here.
  mounted.context.emit('session/event', undefined as never, ANSWER_EVENT as never)
  await vi.waitFor(() => {
    expect(mounted.journal.snapshot().some(entry => entry.kind === 'append.acknowledged')).toBe(true)
  })

  return mounted.journal
}

/** A microphone that connects and then goes away. */
async function driveSocketLoss(): Promise<Journal> {
  const mounted = await harness()
  const server: Server = createServer()
  server.on('upgrade', (req, socket, head) => {
    const handler = mounted.web.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) {
      socket.destroy()
      return
    }
    void handler(req, socket, head)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const client = new WebSocket(`ws://127.0.0.1:${String(port)}${DEFAULT_PATH}?${TOKEN_PARAM}=${mounted.token}`)
  await new Promise((resolve) => { client.on('open', resolve) })
  await vi.waitFor(() => {
    expect(mounted.journal.snapshot().some(entry => entry.kind === 'socket.accepted')).toBe(true)
  })

  const closed = new Promise((resolve) => { client.on('close', resolve) })
  client.close()
  await closed
  await vi.waitFor(() => {
    expect(mounted.journal.snapshot().some(entry => entry.kind === 'socket.closed')).toBe(true)
  })

  client.terminate()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return mounted.journal
}

/** Every `type` string anywhere in the recorded live session. */
function fixtureEventTypes(): string[] {
  const found: string[] = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (typeof value !== 'object' || value === null) return
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'type' && typeof entry === 'string') found.push(entry)
      else walk(entry)
    }
  }
  for (const line of readFileSync(FIXTURE, 'utf8').trim().split('\n')) {
    walk(JSON.parse(line) as unknown)
  }
  return found
}

describe('the fault matrix', () => {
  it('names the failure a controller refused in, without carrying the value it leaked', async () => {
    const journal = await driveRefusal()
    const refused = journal.snapshot().find(entry => entry.kind === 'prompt.refused')

    expect(refused).toBeDefined()
    expect(String(refused?.detail.reason)).toContain('upgrade refused')
    // The whole point of the row: the reason is spoken, and the value inside it is not.
    expect(JSON.stringify(journal.snapshot())).not.toContain(SECRET)
  })

  it('distinguishes a refusal from an admission nobody answered', async () => {
    const refused = signature(await driveRefusal())
    const timedOut = signature(await driveTimeout())

    // A refusal was never admitted; a timeout was admitted and then elapsed. Two facts, told apart.
    expect(refused).toContain('prompt.refused')
    expect(refused).not.toContain('prompt.admitted')
    expect(timedOut).toContain('prompt.admitted')
    expect(timedOut).toContain('window.elapsed')
    expect(timedOut).not.toContain('prompt.refused')
  })

  it('separates an append the provider took from audio anyone heard', async () => {
    const journal = await driveAckedWithoutPlayback()
    const kinds = journal.snapshot().map(entry => entry.kind)

    expect(kinds).toContain('append.acknowledged')
    // The one thing that would make this row a lie. The provider acknowledged the append; no speaker
    // was ever involved, and nothing in the journal says otherwise.
    expect(kinds).not.toContain('speech.sent')
  })

  it('records a socket leaving, rather than trailing off after the accept', async () => {
    const kinds = (await driveSocketLoss()).snapshot().map(entry => entry.kind)

    expect(kinds).toContain('socket.accepted')
    expect(kinds).toContain('socket.closed')
  })

  it('holds no interruption anywhere in the vocabulary the provider actually sends', () => {
    const types = fixtureEventTypes()
    // Sanity: the fixture is the live session, not an empty file that would pass this for free.
    expect(types).toContain('session.started')
    expect(types).toContain('session.delegation.created')

    // A barge-in is real and it matters — it is simply not reported. Recording one would mean the
    // journal claiming to see something no observer has, so the row asserts the absence instead.
    expect(types.filter(type => /interrupt|speech_started|speech_stopped|response\.cancel/.test(type))).toEqual([])
  })

  it('gives every fault a signature of its own', async () => {
    const rows: Record<string, string> = {
      refusal: signature(await driveRefusal()),
      unanswered: signature(await driveTimeout()),
      acknowledgedNotHeard: signature(await driveAckedWithoutPlayback()),
      socketLost: signature(await driveSocketLoss()),
      bargeIn: 'the provider reports no interruption, so there is nothing to record',
    }

    // The matrix's actual claim, in one assertion: five faults, five different records. A reader with
    // only the journal can tell them apart, which is the difference between diagnostics and a log.
    expect(new Set(Object.values(rows)).size).toBe(Object.keys(rows).length)
  })
})
