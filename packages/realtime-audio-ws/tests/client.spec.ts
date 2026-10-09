import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CAPTURE_BUFFER,
  GLOBAL_KEY,
  STRIP_ELEMENT_ID,
  apply,
  createAudioClient,
  defaultDeps,
  float32FromPcm16,
  mountStrip,
  pcm16FromFloat32,
  renderStrip,
  socketUrl,
  stripRoot,
  type ClientAudioDeps,
  type ContextLike,
  type ControlReplyLike,
  type ScopeLike,
  type SettingLike,
  type SocketLike,
  type StripElement,
  type StripEvent,
} from '../src/client/index.ts'

// ---- doubles -------------------------------------------------------------------------------------------

/**
 * A socket that records what it was asked to do.
 *
 * `ready` resolves when the client installs its LAST handler (`onerror`), because `start` awaits the
 * microphone before it touches a socket at all: a test that fires `onopen` any earlier is firing into
 * nothing, which is exactly how the first version of this file failed.
 */
type HandlerName = 'onopen' | 'onmessage' | 'onerror' | 'onclose'

function fakeSocket() {
  const sent: (Uint8Array | string)[] = []
  let closes = 0
  let markReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => { markReady = resolve })
  const handlers: Record<HandlerName, ((event: { data: unknown }) => void) | null> = {
    onopen: null, onmessage: null, onerror: null, onclose: null,
  }
  const socket = {
    binaryType: '',
    send: (data: Uint8Array | string) => { sent.push(data) },
    close: () => { closes += 1 },
    get onopen(): typeof handlers.onopen { return handlers.onopen },
    set onopen(handler: typeof handlers.onopen) { handlers.onopen = handler },
    get onmessage(): typeof handlers.onmessage { return handlers.onmessage },
    set onmessage(handler: typeof handlers.onmessage) { handlers.onmessage = handler },
    get onerror(): typeof handlers.onerror { return handlers.onerror },
    set onerror(handler: typeof handlers.onerror) { handlers.onerror = handler; markReady() },
    get onclose(): typeof handlers.onclose { return handlers.onclose },
    set onclose(handler: typeof handlers.onclose) { handlers.onclose = handler },
  } as unknown as SocketLike
  const fire = (event: HandlerName, data?: unknown): void => {
    handlers[event]?.({ data })
  }
  return { socket, sent, fire, closes: (): number => closes, ready }
}

function fakeGraph(options: { sampleRate?: number } = {}) {
  const started: { at: number; frames: number }[] = []
  const disconnects: string[] = []
  const trackStops: number[] = []
  let contextCloses = 0
  let refuseClose = false
  let clock = 0
  let capture: ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null = null
  let lastFrames = 0
  /** What the graph was asked for when the capture node was built, so the quantum is pinned by a test. */
  let captureArgs: number[] = []
  /** The gain objects the client set, so the no-feedback zero is pinned rather than assumed. */
  const gainValues: { value: number }[] = []

  const node = (name: string) => ({ connect: () => {}, disconnect: () => { disconnects.push(name) } })
  const context = {
    get sampleRate(): number { return options.sampleRate ?? 24_000 },
    get currentTime(): number { return clock },
    destination: {},
    createMediaStreamSource: () => node('source'),
    createScriptProcessor: (...args: number[]) => {
      captureArgs = args
      return {
        ...node('processor'),
        set onaudioprocess(handler: typeof capture) { capture = handler },
      }
    },
    createGain: () => {
      const gain = { value: 1 }
      gainValues.push(gain)
      return { ...node('gain'), gain }
    },
    createBuffer: (_channels: number, frames: number, rate: number) => {
      lastFrames = frames
      return { duration: frames / rate, getChannelData: () => new Float32Array(frames) }
    },
    createBufferSource: () => ({
      buffer: undefined as unknown,
      connect: () => {},
      start: (at?: number) => { started.push({ at: at ?? 0, frames: lastFrames }) },
    }),
    close: () => {
      contextCloses += 1
      return refuseClose ? Promise.reject(new Error('already gone')) : Promise.resolve()
    },
  } as unknown as ContextLike

  return {
    context,
    started,
    disconnects,
    trackStops,
    gainValues,
    captureArgs: (): number[] => captureArgs,
    contextCloses: (): number => contextCloses,
    refuseClose: (): void => { refuseClose = true },
    setClock: (seconds: number): void => { clock = seconds },
    /** Play the capture callback the way the audio graph would. */
    capture: (samples: number[]): void => {
      capture?.({ inputBuffer: { getChannelData: () => Float32Array.from(samples) } })
    },
  }
}

const stream = (trackStops: number[]) => ({ getTracks: () => [{ stop: () => { trackStops.push(1) } }] })

function harness(over: Partial<ClientAudioDeps> = {}) {
  const socket = fakeSocket()
  const graph = fakeGraph()
  const urls: string[] = []
  const deps: ClientAudioDeps = {
    location: { protocol: 'http:', host: '127.0.0.1:19387' },
    getUserMedia: () => Promise.resolve(stream(graph.trackStops)),
    createAudioContext: () => graph.context,
    createSocket: (url) => { urls.push(url); return socket.socket },
    injected: undefined,
    ...over,
  }
  return {
    ...socket,
    ...graph,
    urls,
    deps,
    client: createAudioClient(deps),
    /** Start, wait until the client has installed its handlers, and hand back the pending result. */
    up: async (): Promise<Promise<unknown>> => {
      const pending = createAudioClient(deps).start()
      return pending
    },
  }
}

/** Bring a client live: start it, wait for its handlers, open the socket. */
async function live(over: Partial<ClientAudioDeps> = {}) {
  const h = harness(over)
  const pending = h.client.start()
  await h.ready
  h.fire('onopen')
  await expect(pending).resolves.toEqual({ kind: 'live' })
  return h
}

// ---- pure helpers --------------------------------------------------------------------------------------

describe('socketUrl', () => {
  it('carries the page scheme, so an https page never asks for a blocked ws://', () => {
    expect(socketUrl({ protocol: 'http:', host: 'h:1' }, '/dsh-realtime/audio')).toBe('ws://h:1/dsh-realtime/audio')
    expect(socketUrl({ protocol: 'https:', host: 'h:1' }, '/x')).toBe('wss://h:1/x')
  })

  it('returns nothing when the page cannot host a socket', () => {
    expect(socketUrl(undefined, '/x')).toBeUndefined()
    expect(socketUrl({ protocol: 'http:', host: '' }, '/x')).toBeUndefined()
  })
})

describe('pcm16FromFloat32', () => {
  it('clamps rather than wraps, so a loud peak is not turned into noise', () => {
    expect(Array.from(pcm16FromFloat32(Float32Array.from([2, -2, 1, -1]))))
      .toEqual([32767, -32768, 32767, -32768])
  })

  it('scales the two signs by their own extremes', () => {
    expect(Array.from(pcm16FromFloat32(Float32Array.from([0.5, -0.5])))).toEqual([16384, -16384])
    expect(Array.from(pcm16FromFloat32(Float32Array.from([])))).toEqual([])
  })
})

describe('float32FromPcm16', () => {
  it('reads a frame back', () => {
    const bytes = new Uint8Array(Int16Array.from([0, 32767, -32768]).buffer)
    expect(Array.from(float32FromPcm16(bytes))).toEqual([0, 32767 / 32768, -1])
  })
})

// ---- the client ----------------------------------------------------------------------------------------

describe('createAudioClient', () => {
  it('goes live once the socket opens, and ships captured audio as PCM16', async () => {
    const h = await live()
    expect(h.socket.binaryType).toBe('arraybuffer')
    expect(h.urls).toEqual(['ws://127.0.0.1:19387/dsh-realtime/audio'])
    h.capture([0, 0.5, -0.5])
    expect(h.sent).toHaveLength(1)
    expect(Array.from(new Int16Array((h.sent[0] as Uint8Array).buffer))).toEqual([0, 16384, -16384])
  })

  it('keeps the input stream alive: every quantum ships, silence included', async () => {
    // The reason this is a test rather than a comment. The provider's session timeline advances with the
    // audio this client sends, and a context append is placed only while that timeline is advancing — so
    // dropping silent blocks (an obvious-looking saving, and the most damaging single change anyone could
    // make here) freezes the session and silently loses every append after it. Measured, with the mechanism,
    // in `docs/usable-window.md`.
    const h = await live()
    // The quantum, at the 2^10 floor the API allows, and one channel in and out.
    expect(h.captureArgs()).toEqual([CAPTURE_BUFFER, 1, 1])
    // A zero-gain node is what keeps the processor firing without routing the microphone to the speakers.
    expect(h.gainValues[0]?.value).toBe(0)

    // Ten quanta of pure silence — what an open microphone sends when nobody is speaking.
    const silent = new Array<number>(CAPTURE_BUFFER).fill(0)
    for (let i = 0; i < 10; i += 1) h.capture(silent)

    expect(h.sent).toHaveLength(10)
    for (const frame of h.sent) {
      const bytes = frame as Uint8Array
      // A real frame at the session's declared width — a skipped beat would be a shorter one, or none.
      expect(bytes.byteLength).toBe(CAPTURE_BUFFER * 2)
      expect(Array.from(new Int16Array(bytes.buffer))).toEqual(silent)
    }

    // And it stops with the microphone, rather than shipping into a released socket.
    h.client.stop()
    h.capture(silent)
    expect(h.sent).toHaveLength(10)
  })

  it('plays what comes back, advancing the playhead so frames queue in order', async () => {
    const h = await live()
    const frame = new Uint8Array(Int16Array.from([0, 100]).buffer)
    h.fire('onmessage', frame.buffer)
    h.fire('onmessage', frame.buffer)
    expect(h.started).toHaveLength(2)
    expect(h.started[0]!.at).toBe(0)
    // The second frame starts where the first ends, rather than on top of it.
    expect(h.started[1]!.at).toBeCloseTo(2 / 24_000, 9)
  })

  it('ignores a text frame and an empty frame', async () => {
    const h = await live()
    h.fire('onmessage', 'not a frame')
    h.fire('onmessage', new Uint8Array(0).buffer)
    expect(h.started).toEqual([])
  })

  it('drops speech that is already late instead of queueing it behind', async () => {
    const h = await live()
    // A one-second frame pushes the playhead a second into the future.
    h.fire('onmessage', Int16Array.from({ length: 24_000 }, () => 1).buffer)
    expect(h.started).toHaveLength(1)
    // The graph's clock now sits further behind the playhead than the bound allows — the case a growing
    // queue would never recover from.
    h.setClock(0)
    h.fire('onmessage', Int16Array.from([5]).buffer)
    expect(h.started).toHaveLength(1)
  })

  it('releases the device, the graph and the socket on stop, and ignores frames after it', async () => {
    const h = await live()
    h.client.stop()
    expect(h.closes()).toBe(1)
    expect(h.trackStops).toHaveLength(1)
    expect(h.contextCloses()).toBe(1)
    expect(h.disconnects).toEqual(['processor', 'gain'])
    expect(h.client.state()).toEqual({ kind: 'idle' })
    h.fire('onmessage', Int16Array.from([1]).buffer)
    expect(h.started).toEqual([])
  })

  it('survives the audio graph refusing to close', async () => {
    const h = await live()
    h.refuseClose()
    expect(() => { h.client.stop() }).not.toThrow()
  })

  it('goes back to idle when the host closes the socket', async () => {
    const h = await live()
    h.fire('onclose')
    expect(h.client.state()).toEqual({ kind: 'idle' })
  })

  it('reports the state it is already in rather than starting twice', async () => {
    const h = await live()
    await expect(h.client.start()).resolves.toEqual({ kind: 'live' })
    expect(h.urls).toHaveLength(1)
  })

  it('fails with a reason when the page lacks a location, a microphone, audio or a socket', async () => {
    // A page with no location and nothing injected has no authority to open a socket against; the reason
    // says that rather than blaming the location, which was the old and less useful wording.
    await expect(harness({ location: undefined }).client.start())
      .resolves.toEqual({
        kind: 'failed',
        reason: 'no authority for the audio socket: this page has none of its own and the host injected none',
      })
    await expect(harness({ getUserMedia: undefined }).client.start())
      .resolves.toEqual({ kind: 'failed', reason: 'this page has no microphone API' })
    await expect(harness({ createAudioContext: undefined }).client.start())
      .resolves.toEqual({ kind: 'failed', reason: 'this page has no audio API' })
    await expect(harness({ createSocket: undefined }).client.start())
      .resolves.toEqual({ kind: 'failed', reason: 'this page has no WebSocket API' })
  })

  it('reports a refused microphone, whatever the refusal throws', async () => {
    await expect(harness({ getUserMedia: () => Promise.reject(new Error('Permission denied')) }).client.start())
      .resolves.toEqual({ kind: 'failed', reason: 'Permission denied' })
    await expect(harness({ getUserMedia: () => Promise.reject('nope') }).client.start())
      .resolves.toEqual({ kind: 'failed', reason: 'nope' })
  })

  it('refuses to run rather than mislabel the sample rate', async () => {
    // 48 kHz samples declared as 24 kHz arrive at half speed and read as a provider fault.
    const socket = fakeSocket()
    const graph = fakeGraph({ sampleRate: 48_000 })
    const client = createAudioClient({
      location: { protocol: 'http:', host: 'h' },
      getUserMedia: () => Promise.resolve(stream(graph.trackStops)),
      createAudioContext: () => graph.context,
      createSocket: () => socket.socket,
      injected: undefined,
    })
    await expect(client.start()).resolves.toEqual({
      kind: 'failed',
      reason: 'the audio graph opened at 48000 Hz, not 24000',
    })
    expect(graph.trackStops).toHaveLength(1)
    // The socket is never created, because the rate is checked before it — so the microphone being released
    // is the whole of the cleanup, and this pins that ordering rather than assuming it.
    expect(socket.closes()).toBe(0)
  })

  it('reports a socket the host refused', async () => {
    const h = harness()
    const pending = h.client.start()
    await h.ready
    h.fire('onerror')
    await expect(pending).resolves.toEqual({ kind: 'failed', reason: 'the host refused the audio socket' })
  })

  it('fails rather than hanging when the graph is gone by the time the socket opens', async () => {
    const h = harness()
    const pending = h.client.start()
    await h.ready
    h.fire('onclose')
    h.fire('onopen')
    await expect(pending).resolves.toEqual({
      kind: 'failed',
      reason: 'the audio graph went away before the socket opened',
    })
  })

  it('honours an injected path over the default', async () => {
    const h = harness({ injected: { path: '/custom/audio' } })
    const pending = h.client.start()
    await h.ready
    expect(h.urls).toEqual(['ws://127.0.0.1:19387/custom/audio'])
    h.fire('onopen')
    await expect(pending).resolves.toEqual({ kind: 'live' })
  })
})

// ---- the plugin ----------------------------------------------------------------------------------------

describe('defaultDeps and apply', () => {
  const scope = globalThis as unknown as Record<string, unknown>
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ['location', 'navigator', 'AudioContext', 'WebSocket']) {
    saved.set(key, Object.getOwnPropertyDescriptor(scope, key))
  }

  /**
   * Define rather than assign: `navigator` is getter-only on Node's globalThis, so a plain assignment
   * throws — and the same mistake in the teardown would turn one failure into two.
   */
  const set = (key: string, value: unknown): void => {
    Object.defineProperty(scope, key, { value, configurable: true, writable: true })
  }

  afterEach(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete scope[key]
      else Object.defineProperty(scope, key, descriptor)
    }
    delete scope[GLOBAL_KEY]
  })

  it('reports each browser API it cannot find, given a bare scope', () => {
    const deps = defaultDeps({} as ScopeLike)
    expect(deps.location).toBeUndefined()
    expect(deps.getUserMedia).toBeUndefined()
    expect(deps.createAudioContext).toBeUndefined()
    expect(deps.createSocket).toBeUndefined()
    expect(deps.injected).toBeUndefined()
  })

  it('drives the real APIs, and releases them when the plugin is disposed', async () => {
    const socket = fakeSocket()
    const graph = fakeGraph()
    set('location', { protocol: 'http:', host: 'h:1' })
    set('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve(stream(graph.trackStops)) } })
    set('AudioContext', function (options: { sampleRate: number }) {
      expect(options.sampleRate).toBe(24_000)
      return graph.context
    })
    set('WebSocket', function (url: string) {
      expect(url).toBe('ws://h:1/dsh-realtime/audio')
      return socket.socket
    })

    const context = new Context()
    apply(context)
    const handle = scope[GLOBAL_KEY] as { start(): Promise<unknown>; stop(): void; state(): unknown }
    expect(handle.state()).toEqual({ kind: 'idle' })

    const pending = handle.start()
    await socket.ready
    socket.fire('onopen')
    await expect(pending).resolves.toEqual({ kind: 'live' })

    // Disposal owns the microphone: the plugin going away must not leave a device held.
    await context.fiber.dispose()
    expect(socket.closes()).toBe(1)
    expect(handle.state()).toEqual({ kind: 'idle' })
    handle.stop()
    expect(graph.trackStops).toHaveLength(1)
  })
})

// ---- the control channel, from the page's side ---------------------------------------------------------

/** Let the request chain start its next link. Frames go out in order, so a test waits for one to leave. */
const sentTick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

describe('request', () => {
  it('sends one frame and resolves with the reply', async () => {
    const h = await live()
    const pending = h.client.request('status')
    await sentTick()
    expect(h.sent).toEqual(['status'])
    h.fire('onmessage', '{"ok":true,"verb":"status","settings":[]}')
    await expect(pending).resolves.toMatchObject({ ok: true, verb: 'status' })
  })

  it('refuses to invent a reply when there is no socket', async () => {
    // Nothing was sent, so there is nothing the channel could have said. Reporting a failure is the only
    // honest answer — a fabricated `{ok:false}` would be indistinguishable from the host refusing.
    const h = harness()
    await expect(h.client.request('status')).rejects.toThrow('not connected: connect the microphone first')
  })

  it('serialises frames, so a reply cannot be paired with the wrong request', async () => {
    const h = await live()
    const first = h.client.request('status')
    const second = h.client.request('set realtime-responder.sessionId=sess-2')
    await sentTick()
    // The second waits: the host answers in arrival order, and two frames in flight would make pairing a
    // guess the moment anything on the host slowed down.
    expect(h.sent).toEqual(['status'])

    h.fire('onmessage', '{"ok":true,"verb":"status"}')
    await expect(first).resolves.toMatchObject({ verb: 'status' })
    await sentTick()
    expect(h.sent).toEqual(['status', 'set realtime-responder.sessionId=sess-2'])

    h.fire('onmessage', '{"ok":true,"verb":"set"}')
    await expect(second).resolves.toMatchObject({ verb: 'set' })
  })

  it('keeps the chain alive after a failure, so one bad frame does not stop the next', async () => {
    const h = harness()
    await expect(h.client.request('status')).rejects.toThrow(/not connected/)
    const pending = h.client.start()
    await h.ready
    h.fire('onopen')
    await expect(pending).resolves.toEqual({ kind: 'live' })

    const next = h.client.request('status')
    await sentTick()
    expect(h.sent).toEqual(['status'])
    h.fire('onmessage', '{"ok":true}')
    await expect(next).resolves.toMatchObject({ ok: true })
  })

  it('fails a request whose answer never comes, rather than leaving the panel waiting for ever', async () => {
    const h = await live()
    const pending = h.client.request('status')
    await sentTick()
    h.fire('onclose')
    await expect(pending).rejects.toThrow('the audio socket closed before the host answered')
  })

  it('fails a reply that is not a reply', async () => {
    const h = await live()
    const pending = h.client.request('status')
    await sentTick()
    h.fire('onmessage', 'this is not JSON')
    await expect(pending).rejects.toThrow('the host answered a control frame with something that is not a reply')
  })

  it('ignores a text frame nobody asked for, and a message that is neither text nor audio', async () => {
    const h = await live()
    expect(() => {
      h.fire('onmessage', '{"ok":true}')
      h.fire('onmessage', 42)
    }).not.toThrow()
    // Neither reached the speaker: only binary frames are audio.
    expect(h.started).toEqual([])
  })
})

// ---- the strip -----------------------------------------------------------------------------------------

/** A setting as `status` reports it. */
const setting = (over: Partial<SettingLike> & { key: string }): SettingLike => ({
  field: over.key.split('.')[1] ?? over.key,
  kind: 'string',
  scope: 'live',
  ...over,
})

/** A reply from the host, minimal but shaped like the real one. */
const statusReply = (over: Partial<ControlReplyLike> = {}): ControlReplyLike => ({
  ok: true,
  verb: 'status',
  audio: { path: '/dsh-realtime/audio', clients: 1 },
  voice: { open: true, provider: 'fake', model: 'gpt-live-1', sessionId: 'sess-voice' },
  settings: [setting({ key: 'realtime-responder.sessionId', value: 'sess-1', choices: ['sess-1', 'sess-2'] })],
  journal: { size: 3, last: { kind: 'socket.accepted' } },
  ...over,
})

/**
 * A fake panel element.
 *
 * Two methods and a string: the panel's logic never touches a real DOM, which is what keeps it out of the
 * injected script and inside the coverage gate.
 */
function fakePanel(inputs: Record<string, string> = {}) {
  const listeners: ((event: StripEvent) => void)[] = []
  let rendered = ''
  let writes = 0
  const element = {
    get innerHTML(): string { return rendered },
    set innerHTML(markup: string) { rendered = markup; writes += 1 },
    addEventListener: (_type: string, listener: (event: StripEvent) => void) => { listeners.push(listener) },
    querySelector: (selector: string) => {
      const key = /\[data-input="(.*)"\]/u.exec(selector)?.[1]
      if (key === undefined || inputs[key] === undefined) return null
      return { innerHTML: '', value: inputs[key], addEventListener: () => {}, querySelector: () => null }
    },
  }
  return {
    element: element as unknown as StripElement,
    /** How many times the panel has rendered. How a test tells "mounted once" from "mounted twice". */
    writes: (): number => writes,
    /** Click one of the panel's buttons, as the page would. */
    click: (dataset: Record<string, string | undefined>): void => {
      for (const listener of listeners) listener({ target: { dataset } })
    },
  }
}

describe('renderStrip', () => {
  it('says there is no answer yet, and what the microphone is doing', () => {
    const markup = renderStrip({ reply: null, notes: {}, notice: '', audio: { kind: 'idle' } })
    expect(markup).toContain('no answer yet')
    expect(markup).toContain('microphone: idle')
    expect(markup).toContain('Connect microphone')
  })

  it('distinguishes a profile with no agent from a session that is closed', () => {
    // `null` is nobody answering the query; a closed session is a session. Collapsing them would put "no
    // agent is mounted" behind a control that looks like a session that happens to be off.
    const withoutAgent = renderStrip({ reply: statusReply({ voice: null }), notes: {}, notice: '', audio: { kind: 'idle' } })
    expect(withoutAgent).toContain('voice: no agent is mounted in this profile')
    const closed = renderStrip({
      reply: statusReply({ voice: { open: false, provider: 'fake', model: 'gpt-live-1' } }),
      notes: {},
      notice: '',
      audio: { kind: 'live' },
    })
    expect(closed).toContain('voice: closed · fake/gpt-live-1')
    expect(closed).toContain('Disconnect microphone')
  })

  it('reports a failed microphone with its reason', () => {
    const markup = renderStrip({
      reply: null,
      notes: {},
      notice: '',
      audio: { kind: 'failed', reason: 'Permission denied' },
    })
    expect(markup).toContain('microphone: failed — Permission denied')
  })

  it('gives a live field a control, a session-bound field a note, and a restart-bound field nothing', () => {
    const markup = renderStrip({
      reply: statusReply({
        settings: [
          setting({ key: 'realtime-responder.sessionId', value: 'sess-1', choices: ['sess-1'] }),
          setting({ key: 'realtime-responder.answerTimeoutMs', kind: 'number', field: 'answerTimeoutMs', value: 45_000 }),
          setting({ key: 'realtime-agent.model', scope: 'session', field: 'model', value: 'gpt-live-1' }),
          setting({ key: 'realtime-agent.autoStart', scope: 'restart', kind: 'boolean', field: 'autoStart', value: false }),
        ],
      }),
      notes: {},
      notice: '',
      audio: { kind: 'idle' },
    })

    expect(markup).toContain('data-scope="live"')
    expect(markup).toContain('data-action="steer"')
    expect(markup).toContain('data-action="set"')
    expect(markup).toContain('fixed when the session opens — reconnect to apply')
    // The gate's third class gets no row at all: no control, and nothing that reads as one.
    expect(markup).not.toContain('realtime-agent.autoStart')
    expect(markup).not.toContain('autoStart')
  })

  it('offers the value in force among the candidates even when it is not one of them', () => {
    // A select that silently showed the first candidate instead of the session actually in force would be
    // lying about the state, which is the one thing a control plane must not do.
    const markup = renderStrip({
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.sessionId', value: 'sess-9', choices: ['sess-1'] })] }),
      notes: {},
      notice: '',
      audio: { kind: 'idle' },
    })
    expect(markup).toContain('<option value="sess-9" selected>sess-9</option>')
    expect(markup).toContain('<option value="sess-1">sess-1</option>')
  })

  it('renders a text field for a setting whose candidate list is empty', () => {
    const markup = renderStrip({
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.sessionId', value: 'sess-1', choices: [] })] }),
      notes: {},
      notice: '',
      audio: { kind: 'idle' },
    })
    expect(markup).toContain('<input data-input="realtime-responder.sessionId" value="sess-1">')
  })

  it('escapes what a plugin wrote, in both a body and an attribute', () => {
    const markup = renderStrip({
      reply: statusReply({
        settings: [setting({
          key: 'realtime-agent.instructions',
          value: '"><script>alert(1)</script>',
          describe: 'Be <brief>',
        })],
      }),
      notes: { 'realtime-agent.instructions': 'refused: <no>' },
      notice: 'the socket closed & went away',
      audio: { kind: 'idle' },
    })
    expect(markup).not.toContain('<script>alert(1)')
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markup).toContain('Be &lt;brief&gt;')
    expect(markup).toContain('the socket closed &amp; went away')
  })

  it('shows a note against the field it belongs to, and a notice with no field', () => {
    const markup = renderStrip({
      reply: statusReply(),
      notes: { 'realtime-responder.sessionId': 'applied' },
      notice: 'voice started',
      audio: { kind: 'idle' },
    })
    expect(markup).toContain('data-note="realtime-responder.sessionId">applied')
    expect(markup).toContain('data-dsh-strip-notice>voice started')
  })

  it('says so when there is nothing to show rather than rendering an empty list', () => {
    const markup = renderStrip({ reply: statusReply({ settings: [] }), notes: {}, notice: '', audio: { kind: 'idle' } })
    expect(markup).toContain('no settings to show')
  })

  it('shows a dash for a write-only setting, which reports no value at all', () => {
    // `redactSecrets` never reports its value; rendering nothing there would read as a broken row.
    const markup = renderStrip({
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.redactSecrets', kind: 'string-list', value: undefined, describe: 'Values that must never be spoken' })] }),
      notes: {},
      notice: '',
      audio: { kind: 'idle' },
    })
    expect(markup).toContain('<input data-input="realtime-responder.redactSecrets" value="—">')
  })

  it('renders a bare voice state without inventing a provider for it', () => {
    // What an agent that answered with nothing booked looks like: three optional fields, none of them set.
    const bare = renderStrip({ reply: statusReply({ voice: { open: true } }), notes: {}, notice: '', audio: { kind: 'idle' } })
    expect(bare).toContain('voice: open · microphone: idle')
    const partial = renderStrip({
      reply: statusReply({ voice: { open: false, provider: 'openai-live' } }),
      notes: {},
      notice: '',
      audio: { kind: 'idle' },
    })
    // A provider with no accepted model reads as `openai-live/?` rather than as a blank.
    expect(partial).toContain('voice: closed · openai-live/?')
  })

  it('renders the route line without a journal entry, when there is nothing to report', () => {
    const markup = renderStrip({
      reply: { ok: true, verb: 'status', settings: [] },
      notes: {},
      notice: '',
      audio: { kind: 'idle' },
    })
    expect(markup).toContain('the audio route · 0 socket(s) · journal 0')
    expect(markup).not.toContain('last ')
  })
})

describe('mountStrip', () => {
  /** A panel wired to a scripted transport. */
  function panel(options: { replies?: ControlReplyLike[]; fail?: unknown; inputs?: Record<string, string> } = {}) {
    const page = fakePanel(options.inputs ?? { 'realtime-responder.sessionId': 'sess-2' })
    const frames: string[] = []
    const replies = [...options.replies ?? []]
    const strip = mountStrip({
      root: page.element,
      request: (frame) => {
        frames.push(frame)
        // Rejected with whatever the test gave: an `Error` and a bare string are both things a transport
        // can fail with, and the panel has to name both.
        if (options.fail !== undefined) return Promise.reject(options.fail)
        return Promise.resolve(replies.shift() ?? { ok: true, verb: 'ok' })
      },
      connect: () => Promise.resolve({ kind: 'live' }),
      disconnect: () => undefined,
      audio: () => ({ kind: 'idle' }),
    })
    return { ...page, frames, strip }
  }

  it('renders a status on refresh, and asks for one first', async () => {
    const { element, frames, strip } = panel({ replies: [statusReply()] })
    await strip.refresh()
    expect(frames).toEqual(['status'])
    expect(element.innerHTML).toContain('voice: open')
    expect(strip.state().reply).toMatchObject({ verb: 'status' })
  })

  it('steers with the picker’s value and reports the outcome against that field', async () => {
    const { frames, strip, click } = panel({ replies: [statusReply(), { ok: true, verb: 'steer', key: 'realtime-responder.sessionId', value: 'sess-2' }, statusReply()] })
    await strip.refresh()
    click({ action: 'steer', key: 'realtime-responder.sessionId' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(frames).toEqual(['status', 'steer sess-2', 'status'])
    expect(strip.state().notes['realtime-responder.sessionId']).toBe('steered')
  })

  it('relays a refusal verbatim, beside the field it belongs to', async () => {
    const { strip, click } = panel({
      replies: [
        statusReply(),
        { ok: false, verb: 'set', key: 'realtime-agent.autoStart', code: 'FROZEN_SETTING', reason: '"x" is claimed when the plugin loads — restart to change it' },
        statusReply(),
      ],
      inputs: { 'realtime-agent.autoStart': 'true' },
    })
    await strip.refresh()
    click({ action: 'set', key: 'realtime-agent.autoStart' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(strip.state().notes['realtime-agent.autoStart'])
      .toBe('FROZEN_SETTING: "x" is claimed when the plugin loads — restart to change it')
  })

  it('sends a set for everything that is not the session picker', async () => {
    const { frames, strip, click } = panel({ inputs: { 'realtime-responder.answerTimeoutMs': '90000' } })
    await strip.refresh()
    click({ action: 'set', key: 'realtime-responder.answerTimeoutMs' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(frames).toEqual(['status', 'set realtime-responder.answerTimeoutMs=90000', 'status'])
  })

  it('starts and stops the voice from the panel, and reports which happened', async () => {
    const { frames, strip, click } = panel({ replies: [statusReply(), { ok: true, verb: 'start' }, statusReply()] })
    await strip.refresh()
    click({ action: 'voice-start' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(frames).toEqual(['status', 'start', 'status'])
    expect(strip.state().notice).toBe('voice started')
  })

  it('connects and disconnects the microphone — the on-switch that used to be a console global', async () => {
    const page = fakePanel()
    let live = false
    const strip = mountStrip({
      root: page.element,
      request: () => Promise.resolve(statusReply({ voice: { open: false, provider: 'fake', model: 'gpt-live-1' } })),
      connect: () => { live = true; return Promise.resolve({ kind: 'live' }) },
      disconnect: () => { live = false },
      audio: () => live ? { kind: 'live' } : { kind: 'idle' },
    })

    page.click({ action: 'connect' })
    await sentTick()
    expect(live).toBe(true)
    expect(page.element.innerHTML).toContain('Disconnect microphone')

    page.click({ action: 'disconnect' })
    await sentTick()
    expect(live).toBe(false)
    expect(page.element.innerHTML).toContain('Connect microphone')
    expect(strip.state().audio).toEqual({ kind: 'idle' })
  })

  it('says why the microphone did not come up, rather than looking like it did', async () => {
    const page = fakePanel()
    const strip = mountStrip({
      root: page.element,
      request: () => Promise.resolve(statusReply()),
      connect: () => Promise.resolve({ kind: 'failed', reason: 'Permission denied' }),
      disconnect: () => undefined,
      audio: () => ({ kind: 'failed', reason: 'Permission denied' }),
    })

    page.click({ action: 'connect' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(strip.state().notice).toBe('Permission denied')
    expect(page.element.innerHTML).toContain('Permission denied')
  })

  it('reports a transport that is not there at all, and one that refuses a frame', async () => {
    const { element, strip, click } = panel({ fail: new Error('not connected: connect the microphone first') })
    await strip.refresh()
    expect(strip.state().notice).toBe('not connected: connect the microphone first')
    expect(element.innerHTML).toContain('not connected')

    click({ action: 'voice-stop' })
    await sentTick()
    expect(strip.state().notice).toBe('not connected: connect the microphone first')
  })

  it('names a failure that is not an Error, rather than reporting nothing at all', async () => {
    const { strip, click } = panel({ fail: 'the tunnel went away' })
    await strip.refresh()
    expect(strip.state().notice).toBe('the tunnel went away')
    // The same on the way out: a frame that could not even be sent is named the same way.
    click({ action: 'voice-stop' })
    await sentTick()
    expect(strip.state().notice).toBe('the tunnel went away')
  })

  it('sends a steer with whatever the picker is holding, including nothing', async () => {
    const { frames, strip, click } = panel({ replies: [statusReply(), { ok: true, verb: 'steer' }, statusReply()], inputs: {} })
    await strip.refresh()
    click({ action: 'steer' })
    await sentTick()
    // The frame is well-formed and the channel answers with its own refusal: a panel that declined to send
    // would be inventing a rule the channel does not have.
    expect(frames).toEqual(['status', 'steer ', 'status'])
  })

  it('relays a refusal that explained itself badly without inventing a reason', async () => {
    const { strip, click } = panel({ replies: [statusReply(), { ok: false, verb: 'set' }, statusReply()], inputs: {} })
    await strip.refresh()
    click({ action: 'set' })
    await sentTick()
    // No key on the button and no input to read: the panel asks anyway, with what it has, and reports what
    // came back — "refused: no reason given" is honest where an invented sentence would not be.
    expect(strip.state().notice).toBe('refused: no reason given')
  })

  it('ignores a click that is not one of its controls', () => {
    const { strip, click } = panel()
    expect(() => { click({}) }).not.toThrow()
    expect(strip.state().reply).toBeNull()
  })

  it('re-reads the status on demand', async () => {
    const { frames, strip, click } = panel({ replies: [statusReply(), statusReply({ audio: { path: '/x', clients: 2 } })] })
    await strip.refresh()
    click({ action: 'refresh' })
    await sentTick()
    expect(frames).toEqual(['status', 'status'])
    expect(strip.state().reply?.audio?.clients).toBe(2)
  })
})

describe('the panel the bundle mounts by itself', () => {
  it('finds the element the injected row provides, and nothing when there is none', () => {
    const page = fakePanel()
    const scope = { document: { getElementById: (id: string) => id === STRIP_ELEMENT_ID ? page.element : null } }
    expect(stripRoot(scope)).toBe(page.element)
    expect(stripRoot({})).toBeNull()
    expect(stripRoot({ document: { getElementById: () => null } })).toBeNull()
  })

  it('mounts from apply when the markup is already there, and mounting again changes nothing', async () => {
    // The bundle reads its element off the page scope, so the test installs one — the same thing the
    // host's own page provides.
    const page = fakePanel()
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', { value: { getElementById: () => page.element }, configurable: true })
    try {
      apply({ effect: (run: () => void) => { void run } })
      await new Promise((resolve) => { setTimeout(resolve, 0) })

      // Mounted by the bundle itself, not only by the injected script: the two orderings are both possible,
      // and whichever lands second finds the panel already there.
      expect(page.element.innerHTML).toContain('no answer yet')
      const exposed = (globalThis as unknown as Record<string, { mount: () => void; state: () => unknown; stop: () => void; request: (frame: string) => Promise<unknown> }>)[GLOBAL_KEY]!
      expect(exposed.mount).toBeTypeOf('function')
      const rendered = page.writes()
      exposed.mount()
      await sentTick()
      expect(page.writes()).toBe(rendered)

      // Driven through the panel's own controls, which is what makes the bundle's mount more than a
      // decoration: this page cannot reach a socket at all, and the panel says so — in the microphone line
      // for the reason, and in the notice for why the status could not be read.
      page.click({ action: 'connect' })
      await sentTick()
      expect(page.element.innerHTML).toContain('microphone: failed — no authority for the audio socket')
      expect(page.element.innerHTML).toContain('not connected: connect the microphone first')
      page.click({ action: 'disconnect' })
      await sentTick()
      expect(exposed.state()).toEqual({ kind: 'idle' })
      // The global is now the seam between the injected markup and this bundle, not the on-switch — but it
      // still answers the calls the bootstrap and a console might make.
      exposed.stop()
      expect(exposed.state()).toEqual({ kind: 'idle' })
      // And the same transport call the panel makes, for anything else that holds this handle.
      await expect(exposed.request('status')).rejects.toThrow('not connected')
    } finally {
      if (saved === undefined) delete (globalThis as Record<string, unknown>).document
      else Object.defineProperty(globalThis, 'document', saved)
    }
  })
})
