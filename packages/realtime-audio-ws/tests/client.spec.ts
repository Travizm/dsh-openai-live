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
  type StripState,
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

/** The two budgets, as the running plugins declare them. */
const waitPair = (agent: number, turn: number): SettingLike[] => [
  setting({ key: 'realtime-agent.delegationTimeoutMs', kind: 'number', value: agent }),
  setting({ key: 'realtime-responder.answerTimeoutMs', kind: 'number', value: turn }),
]

/** A panel state, with everything a test is not about filled in. */
const panelState = (over: Partial<StripState> = {}): StripState => ({
  reply: statusReply(),
  notes: {},
  notice: '',
  audio: { kind: 'idle' },
  level: 'collapsed',
  drafts: {},
  connecting: false,
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

describe('the plate — what the collapsed strip shows', () => {
  it('carries the wordmark, the lamp, the meter, where the voice is pointed, and the two controls', () => {
    const markup = renderStrip(panelState())
    // The plate's own name and model, invented: a real manufacturer's trade dress is protected, and an
    // invented plate is what the brief asked for in the first place.
    expect(markup).toContain('REALTIME')
    expect(markup).toContain('DV-1 · DESK VOICE UNIT')
    expect(markup).toContain('data-lamp="live"')
    expect(markup).toContain('>LIVE<')
    expect(markup).toContain('data-meter="idle"')
    expect(markup).toContain('fake/gpt-live-1 · sess-voice')
    expect(markup).toContain('data-action="connect">MIC')
    expect(markup).toContain('SETTINGS ⌃')
  })

  it('is state, not settings: no knob and no registry row appears until it is asked for', () => {
    // The defect the screenshot showed: every setting the plugin has, always visible. The collapsed default
    // is the real fix for a panel in the way — the reposition only makes collapsing cheap.
    const markup = renderStrip(panelState())
    expect(markup).not.toContain('dvr-knobs')
    expect(markup).not.toContain('dvr-srow')
    expect(markup).not.toContain('realtime-agent.autoStart')
  })

  it('lights the lamp green for an open session, amber while connecting, and dark otherwise', () => {
    expect(renderStrip(panelState())).toContain('data-lamp="live"')
    // Amber is real rather than decorative: a connect is a promise that settles, and this is the only thing
    // on the plate that moves without the status having moved.
    const connecting = renderStrip(panelState({ connecting: true }))
    expect(connecting).toContain('data-lamp="connecting"')
    expect(connecting).toContain('>LINK<')
    const closed = renderStrip(panelState({ reply: statusReply({ voice: { open: false } }) }))
    expect(closed).toContain('data-lamp="closed"')
    expect(closed).toContain('>CLOSED<')
  })

  it('sits dark and closed before anything has answered, which is not the same as no agent', () => {
    // Two different absences, kept apart: nothing has been asked yet, and a profile with no agent row
    // mounted. Collapsing them sends a reader to the wrong file.
    const waiting = renderStrip(panelState({ reply: null }))
    expect(waiting).toContain('no status yet')
    expect(waiting).toContain('data-lamp="closed"')
    expect(renderStrip(panelState({ reply: statusReply({ voice: null }) }))).toContain('no agent mounted')
  })

  it('engraves where the voice is pointed, inventing neither a provider nor a session', () => {
    const bare = renderStrip(panelState({ reply: statusReply({ voice: { open: true } }) }))
    expect(bare).toContain('?/?')
    const partial = renderStrip(panelState({ reply: statusReply({ voice: { open: false, provider: 'openai-live' } }) }))
    expect(partial).toContain('openai-live/?')
    const session = renderStrip(panelState({ reply: statusReply({ voice: { open: true, provider: 'fake', model: 'gpt-live-1' } }) }))
    // No session id, so none is shown — not an empty separator.
    expect(session).toContain('>fake/gpt-live-1<')
  })

  it('reports the capture path on the meter, which is state rather than a level', () => {
    // A level needs a repaint loop, and repainting this element destroys whatever is half-typed in it. So
    // the bar carries what changes without a repaint, and says so on the element itself.
    const idle = renderStrip(panelState())
    expect(idle).toContain('data-meter="idle"')
    expect(idle).toContain('title="capture state — not a level"')
    expect(idle).toContain('aria-label="microphone idle"')
    expect(idle).not.toContain('dvr-seg on')

    const live = renderStrip(panelState({ audio: { kind: 'live' } }))
    expect(live).toContain('data-meter="live"')
    expect(live).toContain('<i class="dvr-seg on"></i>')
    expect(live).toContain('<i class="dvr-seg on warm"></i>')

    const failed = renderStrip(panelState({ audio: { kind: 'failed', reason: 'Permission denied' } }))
    expect(failed).toContain('data-meter="failed"')
    // Shown at the top of the scale, where the eye already looks for "something is wrong with the input".
    expect(failed).toContain('<i class="dvr-seg on hot"></i>')
    expect(failed).not.toContain('dvr-seg on warm')
    // And in words, because a lamp is not a reason.
    expect(failed).toContain('microphone: Permission denied')
  })

  it('switches its own label, so a reader can see which way the drill goes', () => {
    expect(renderStrip(panelState({ level: 'controls' }))).toContain('SETTINGS ⌄')
    expect(renderStrip(panelState({ level: 'all' }))).toContain('SETTINGS ⌄')
  })

  it('marks the microphone button as on only when the device is actually open', () => {
    expect(renderStrip(panelState())).toContain('data-action="connect">MIC')
    const live = renderStrip(panelState({ audio: { kind: 'live' } }))
    expect(live).toContain('class="dvr-btn on" data-action="disconnect">MIC')
  })
})

describe('the panel — the few things worth a knob', () => {
  it('gives the two timeouts one control, and names the cap only when the pair diverges', () => {
    // The screenshot's defect: two rows both reading 180000, one of which does nothing when turned. One
    // primary that writes both, the binding value shown, and the capping layer named when it is real.
    const equal = renderStrip(panelState({ level: 'controls', reply: statusReply({ settings: waitPair(45_000, 45_000) }) }))
    expect(equal).toContain('>WAIT<')
    expect(equal).toContain('45 s')
    expect(equal).toContain('data-action="wait" data-key="realtime-agent.delegationTimeoutMs"')
    expect(equal).not.toContain('capped by the')

    const replyCaps = renderStrip(panelState({ level: 'controls', reply: statusReply({ settings: waitPair(10_000, 45_000) }) }))
    expect(replyCaps).toContain('capped by the reply budget')
    expect(replyCaps).toContain('10 s')

    const turnCaps = renderStrip(panelState({ level: 'controls', reply: statusReply({ settings: waitPair(90_000, 45_000) }) }))
    expect(turnCaps).toContain('capped by the turn budget')
    expect(turnCaps).toContain('45 s')
  })

  it('falls back to a plain control when only one layer registered a budget', () => {
    // Zero or one key is a real answer: a profile with no agent row has one budget, not two, and a control
    // that wrote the missing one would be writing a key nothing owns.
    const one = renderStrip(panelState({
      level: 'controls',
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.answerTimeoutMs', kind: 'number', value: 45_000 })] }),
    }))
    expect(one).toContain('data-action="set" data-key="realtime-responder.answerTimeoutMs"')
    expect(one).not.toContain('capped by the')
  })

  it('leaves the knob row out entirely when nothing it drives is registered', () => {
    const none = renderStrip(panelState({ level: 'controls', reply: statusReply({ settings: [] }) }))
    expect(none).not.toContain('dvr-knobs')
    expect(none).toContain('CONTROLS')
  })

  it('reads a knob from the panel’s own scale, and clamps rather than wrapping', () => {
    // The registry declares a kind, not a range, which is why the pointer is a readout and the field is the
    // control. A value beyond the scale clamps: a pointer that wrapped would read backwards.
    const high = renderStrip(panelState({
      level: 'controls',
      reply: statusReply({ settings: [
        ...waitPair(45_000, 45_000),
        setting({ key: 'realtime-responder.maxSpokenMilestones', kind: 'number', field: 'maxSpokenMilestones', value: 9 }),
      ] }),
    }))
    expect(high).toContain('dvr-knob--10')
    const low = renderStrip(panelState({ level: 'controls', reply: statusReply({ settings: waitPair(0, 0) }) }))
    expect(low).toContain('dvr-knob--0')
  })

  it('reads PROMPT and MILESTONES as knobs, labelled short and valued with their unit', () => {
    const markup = renderStrip(panelState({
      level: 'controls',
      reply: statusReply({ settings: [
        setting({ key: 'realtime-responder.maxPromptChars', kind: 'number', field: 'maxPromptChars', value: 4000 }),
        setting({ key: 'realtime-responder.maxSpokenMilestones', kind: 'number', field: 'maxSpokenMilestones', value: 3 }),
      ] }),
    }))
    expect(markup).toContain('>PROMPT<')
    expect(markup).toContain('4000 ch')
    expect(markup).toContain('>MILESTONES<')
    expect(markup).toContain('>3<')
  })

  it('gives the microphone and the session real switches, and every live boolean its own', () => {
    const markup = renderStrip(panelState({
      level: 'controls',
      audio: { kind: 'live' },
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.speakMilestones', kind: 'boolean', field: 'speakMilestones', value: true })] }),
    }))
    expect(markup).toContain('data-action="disconnect" aria-pressed="true"><i class="dvr-led on green"></i><span>MIC</span>')
    expect(markup).toContain('data-action="voice-stop" aria-pressed="true"')
    expect(markup).toContain('data-action="toggle" data-key="realtime-responder.speakMilestones" data-value="false"')
    expect(markup).toContain('<span>SPEAK STEPS</span><b class="dvr-switch-state">ON</b>')
  })

  it('offers the voice switch as a start when there is no session, and a microphone switch that is off', () => {
    const markup = renderStrip(panelState({ level: 'controls', reply: statusReply({ voice: { open: false } }) }))
    expect(markup).toContain('data-action="voice-start" aria-pressed="false"')
    expect(markup).toContain('data-action="connect" aria-pressed="false"')
    // A session that is closed is still a session: the switch says stop, not start.
    const bare = renderStrip(panelState({ level: 'controls', reply: statusReply({ voice: null }) }))
    expect(bare).toContain('data-action="voice-start"')
  })

  it('gives a restart-bound setting no switch at all, whatever its kind', () => {
    // The gate's third class: an affordance the protocol cannot honour teaches the user the plugin is
    // broken, so it is not offered — here or one level down.
    const markup = renderStrip(panelState({
      level: 'controls',
      reply: statusReply({ settings: [setting({ key: 'realtime-agent.autoStart', kind: 'boolean', field: 'autoStart', scope: 'restart', value: false })] }),
    }))
    expect(markup).not.toContain('autoStart')
  })

  it('shows a boolean that is off as off, and offers to turn it on', () => {
    const markup = renderStrip(panelState({
      level: 'controls',
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.speakMilestones', kind: 'boolean', field: 'speakMilestones', value: false })] }),
    }))
    expect(markup).toContain('data-value="true" aria-pressed="false"')
    expect(markup).toContain('<i class="dvr-led"></i>')
    expect(markup).toContain('<span>SPEAK STEPS</span><b class="dvr-switch-state">OFF</b>')
  })

  it('reads a knob for a setting that reported no value as zero, rather than inventing one', () => {
    // The registry still declares the kind, so the control exists and the field is usable; what it writes is
    // the channel's business, and the channel's own refusal is what names the problem.
    const markup = renderStrip(panelState({
      level: 'controls',
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.maxPromptChars', kind: 'number', field: 'maxPromptChars', value: undefined })] }),
    }))
    expect(markup).toContain('0 ch')
    expect(markup).toContain('value="0"')
  })
})

describe('the panel — everything the registry holds, one level down', () => {
  it('shows the raw rows, with the key, the owner’s own prose, and no knob', () => {
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [
        setting({ key: 'realtime-responder.answerTimeoutMs', kind: 'number', value: 45_000, describe: 'How long one turn waits for the agent before declining' }),
      ] }),
    }))
    expect(markup).toContain('data-key="realtime-responder.answerTimeoutMs" data-scope="live"')
    expect(markup).toContain('How long one turn waits for the agent before declining')
    // The mechanism is reachable without being in the way: one control at the level above, the pair here.
    expect(markup).not.toContain('dvr-knobs')
    expect(markup).toContain('ALL SETTINGS')
  })

  it('marks the tab that is showing, and the other one not', () => {
    const all = renderStrip(panelState({ level: 'all' }))
    expect(all).toContain('class="dvr-tab active" data-action="level" data-level="all">ALL SETTINGS')
    expect(all).toContain('class="dvr-tab" data-action="level" data-level="controls">CONTROLS')
    const controls = renderStrip(panelState({ level: 'controls' }))
    expect(controls).toContain('class="dvr-tab active" data-action="level" data-level="controls">CONTROLS')
    expect(controls).toContain('class="dvr-tab" data-action="level" data-level="all">ALL SETTINGS')
  })

  it('keeps the speak-steps switch off the deepest level, where the setting has its own row', () => {
    // The deepest level gives every setting its own control, so the switch there as well would put one
    // setting behind two toggles on one screen — two rows that read identically, in miniature.
    const all = renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.speakMilestones', kind: 'boolean', field: 'speakMilestones', value: true })] }),
    }))
    expect(all.match(/data-action="toggle"/gu)).toHaveLength(1)
    // The controls level has no row for it, so there the switch is the only control it gets.
    const controls = renderStrip(panelState({
      level: 'controls',
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.speakMilestones', kind: 'boolean', field: 'speakMilestones', value: true })] }),
    }))
    expect(controls.match(/data-action="toggle"/gu)).toHaveLength(1)
  })

  it('gives a live field a control, a session-bound field a note, and a restart-bound field nothing', () => {
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [
        setting({ key: 'realtime-responder.sessionId', value: 'sess-1', choices: ['sess-1'] }),
        setting({ key: 'realtime-agent.model', scope: 'session', field: 'model', value: 'gpt-live-1' }),
        setting({ key: 'realtime-agent.autoStart', scope: 'restart', kind: 'boolean', field: 'autoStart', value: false }),
      ] }),
    }))
    expect(markup).toContain('data-scope="live"')
    expect(markup).toContain('data-action="steer"')
    expect(markup).toContain('fixed when the session opens — reconnect to apply')
    expect(markup).not.toContain('autoStart')
  })

  it('sends everything that is not the session picker through `set`', () => {
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [
        setting({ key: 'realtime-responder.sessionId', kind: 'number', field: 'sessionId', value: 7 }),
        setting({ key: 'realtime-agent.instructions', kind: 'string-list', field: 'instructions', value: ['a'] }),
      ] }),
    }))
    // A `sessionId` that is not a string is not the field the steer verb means, so it takes the ordinary
    // route rather than a verb that would refuse it.
    expect(markup).toContain('data-action="set" data-key="realtime-responder.sessionId">Set')
    expect(markup).not.toContain('data-action="steer"')
  })

  it('offers the value in force among the candidates even when it is not one of them', () => {
    // A select that silently showed the first candidate instead of the session actually in force would be
    // lying about the state, which is the one thing a control plane must not do.
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.sessionId', value: 'sess-9', choices: ['sess-1'] })] }),
    }))
    expect(markup).toContain('<option value="sess-9" selected>sess-9</option>')
    expect(markup).toContain('<option value="sess-1">sess-1</option>')
    expect(markup).toContain('data-action="steer"')
  })

  it('renders a text field for a setting whose candidate list is empty', () => {
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.sessionId', value: 'sess-1', choices: [] })] }),
    }))
    expect(markup).toContain('<input class="dvr-input dvr-input--wide" data-input="realtime-responder.sessionId" value="sess-1">')
    expect(markup).not.toContain('<select')
  })

  it('shows a dash for a write-only setting, which reports no value at all', () => {
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [setting({ key: 'realtime-responder.instructions', kind: 'string', value: undefined, describe: 'Be brief' })] }),
    }))
    expect(markup).toContain('value="—"')
  })

  it('labels a boolean nobody gave a short legend by its own field name', () => {
    // A plugin may register a boolean the panel has never heard of; the plate's vocabulary is a convenience,
    // not a closed set, and an unlabelled switch would read as a blank control.
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [setting({ key: 'realtime-agent.narrateTools', kind: 'boolean', field: 'narrateTools', value: true })] }),
    }))
    expect(markup).toContain('<span>narrateTools</span><b class="dvr-switch-state">ON</b>')
  })

  it('shows a note against the field it belongs to, and a notice with no field', () => {
    const markup = renderStrip(panelState({
      level: 'all',
      notes: { 'realtime-responder.sessionId': 'applied' },
      notice: 'voice started',
    }))
    expect(markup).toContain('data-note="realtime-responder.sessionId">applied')
    expect(markup).toContain('data-dsh-strip-notice>voice started')
  })

  it('says so when there is nothing to show rather than rendering an empty panel', () => {
    expect(renderStrip(panelState({ level: 'all', reply: statusReply({ settings: [] }) })))
      .toContain('no settings to show')
    // A profile holding only restart-bound settings is the same emptiness, arrived at differently.
    expect(renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [setting({ key: 'realtime-agent.autoStart', scope: 'restart', kind: 'boolean', field: 'autoStart', value: false })] }),
    }))).toContain('no settings to show')
  })

  it('escapes what a plugin wrote, in both a body and an attribute', () => {
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({
        settings: [setting({
          key: 'realtime-agent.instructions',
          value: '"><script>alert(1)</script>',
          describe: 'Be <brief>',
        })],
      }),
      notes: { 'realtime-agent.instructions': 'refused: <no>' },
      notice: 'the socket closed & went away',
    }))
    expect(markup).not.toContain('<script>alert(1)')
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markup).toContain('Be &lt;brief&gt;')
    expect(markup).toContain('the socket closed &amp; went away')
  })
})

describe('a list gets an editor, not a comma-separated string', () => {
  it('shows every entry the plugin reported, each one removable, with a field to add', () => {
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({
        settings: [setting({
          key: 'realtime-agent.stopWords',
          kind: 'string-list',
          field: 'stopWords',
          value: ['hunter2', 'swordfish'],
        })],
      }),
    }))
    expect(markup).toContain('<span class="dvr-entry-value">hunter2</span>')
    expect(markup).toContain('data-action="list-remove" data-key="realtime-agent.stopWords" data-index="1"')
    expect(markup).toContain('data-action="list-add" data-key="realtime-agent.stopWords">Add')
    // Not a serialisation format leaked into the UI.
    expect(markup).not.toContain('hunter2,swordfish')
    expect(markup).not.toContain('the plugin does not report this value')
  })

  it('keeps what the editor built for a value the plugin refuses to report', () => {
    // `redactSecrets` is write-only, so an editor showing an empty list would read as "the list is empty"
    // rather than "the list is not readable" — and a set replaces the whole list, so the entries the editor
    // is holding are the only record of what it is about to write.
    const entry = setting({
      key: 'realtime-responder.redactSecrets',
      kind: 'string-list',
      field: 'redactSecrets',
      value: undefined,
      describe: 'Values that must never be spoken or carried on the bus',
    })
    const empty = renderStrip(panelState({ level: 'all', reply: statusReply({ settings: [entry] }) }))
    expect(empty).toContain('the plugin does not report this value — this list replaces whatever is set')

    const drafted = renderStrip(panelState({
      level: 'all',
      reply: statusReply({ settings: [entry] }),
      drafts: { 'realtime-responder.redactSecrets': ['hunter2'] },
    }))
    expect(drafted).toContain('<span class="dvr-entry-value">hunter2</span>')
  })

  it('keeps only the strings of a list that reported something else in it', () => {
    // The kind is declared, but the value comes from a plugin: a non-string in the array is dropped rather
    // than rendered as `[object Object]` in an editor that writes it straight back.
    const markup = renderStrip(panelState({
      level: 'all',
      reply: statusReply({
        settings: [setting({ key: 'realtime-agent.mixed', kind: 'string-list', field: 'mixed', value: ['a', 3] })],
      }),
    }))
    expect(markup).toContain('>a<')
    expect(markup).not.toContain('>3<')
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
    expect(element.innerHTML).toContain('fake/gpt-live-1')
    expect(strip.state().level).toBe('collapsed')
    expect(strip.state().reply).toMatchObject({ verb: 'status' })
  })

  it('opens the drill-through, and closes it again, without another status', async () => {
    const { frames, strip, click, element } = panel({ replies: [statusReply()] })
    await strip.refresh()
    click({ action: 'level', level: 'controls' })
    await sentTick()
    expect(strip.state().level).toBe('controls')
    expect(element.innerHTML).toContain('dvr-panel')

    click({ action: 'level', level: 'all' })
    await sentTick()
    expect(strip.state().level).toBe('all')
    expect(element.innerHTML).toContain('ALL SETTINGS')

    click({ action: 'level', level: 'collapsed' })
    await sentTick()
    expect(element.innerHTML).not.toContain('dvr-panel')

    // A button carrying no level closes it rather than opening a level nothing named.
    click({ action: 'level', level: undefined })
    await sentTick()
    expect(strip.state().level).toBe('collapsed')
    expect(frames).toEqual(['status'])
  })

  it('writes both wait budgets and reports the pair the registry confirms', async () => {
    // One intent, two frames. The note is the pair as re-read, never the value that was asked for: a setter
    // may clamp, and a half-applied pair has to be visible as a pair.
    const { frames, strip, click, element } = panel({
      replies: [statusReply({ settings: waitPair(10_000, 45_000) }), { ok: true, verb: 'set' }, { ok: true, verb: 'set' }, statusReply({ settings: waitPair(90_000, 90_000) })],
      inputs: { 'realtime-agent.delegationTimeoutMs': '90000' },
    })
    await strip.refresh()
    click({ action: 'level', level: 'controls' })
    await sentTick()
    click({ action: 'wait', key: 'realtime-agent.delegationTimeoutMs' })
    await sentTick()

    expect(frames).toEqual([
      'status',
      'set realtime-agent.delegationTimeoutMs=90000',
      'set realtime-responder.answerTimeoutMs=90000',
      'status',
    ])
    expect(strip.state().notes['realtime-agent.delegationTimeoutMs']).toBe('waits up to 90 s — 90000 / 90000 ms')
    // The panel shows what the registry confirmed rather than what was asked for: the pair came back equal,
    // so the knob reads the confirmed value and no layer is named as the cap.
    expect(element.innerHTML).toContain('value="90000"')
    expect(element.innerHTML).toContain('90 s')
  })

  it('stops at the first refusal rather than writing the rest of the pair', async () => {
    const { frames, strip, click } = panel({
      replies: [
        statusReply({ settings: waitPair(10_000, 45_000) }),
        { ok: false, verb: 'set', code: 'UNKNOWN_SETTING', reason: 'no setting is registered under that key' },
        statusReply({ settings: waitPair(10_000, 45_000) }),
      ],
      inputs: { 'realtime-agent.delegationTimeoutMs': '90000' },
    })
    await strip.refresh()
    click({ action: 'wait', key: 'realtime-agent.delegationTimeoutMs' })
    await sentTick()

    expect(frames).toEqual(['status', 'set realtime-agent.delegationTimeoutMs=90000', 'status'])
    expect(strip.state().notes['realtime-agent.delegationTimeoutMs'])
      .toBe('UNKNOWN_SETTING: no setting is registered under that key')
  })

  it('says so when the wait pair is gone by the time the write is re-read', async () => {
    // The plugins can unload between the click and the confirmation, and `min` of nothing is not a number
    // a panel may print.
    const { strip, click } = panel({
      replies: [statusReply({ settings: waitPair(10_000, 45_000) }), { ok: true, verb: 'set' }, { ok: true, verb: 'set' }, statusReply({ settings: [] })],
      inputs: { 'realtime-agent.delegationTimeoutMs': '90000' },
    })
    await strip.refresh()
    click({ action: 'wait', key: 'realtime-agent.delegationTimeoutMs' })
    await sentTick()
    expect(strip.state().notes['realtime-agent.delegationTimeoutMs']).toBe('no wait budget is registered')
  })

  it('does nothing at all for a wait click on a profile with no wait budget', async () => {
    const { frames, strip, click } = panel({ replies: [statusReply({ settings: [] })] })
    await strip.refresh()
    click({ action: 'wait' })
    await sentTick()
    expect(frames).toEqual(['status'])
  })

  it('flips a boolean with the value it rendered, not with a second read of the page', async () => {
    const { frames, strip, click } = panel({
      replies: [statusReply({ settings: [setting({ key: 'realtime-responder.speakMilestones', kind: 'boolean', field: 'speakMilestones', value: true })] }), { ok: true, verb: 'set' }, statusReply()],
    })
    await strip.refresh()
    click({ action: 'toggle', key: 'realtime-responder.speakMilestones', value: 'false' })
    await sentTick()
    expect(frames).toEqual(['status', 'set realtime-responder.speakMilestones=false', 'status'])
    expect(strip.state().notes['realtime-responder.speakMilestones']).toBe('false')
  })

  it('adds an entry to a write-only list and sends the whole array as JSON', async () => {
    // The wire format is JSON and only JSON — a list of secrets cannot be split on a comma — and the entry
    // list the editor holds is what is written, because the plugin never reports the current one.
    const entry = setting({ key: 'realtime-responder.redactSecrets', kind: 'string-list', field: 'redactSecrets', value: undefined })
    const { frames, strip, click } = panel({
      replies: [statusReply({ settings: [entry] }), { ok: true, verb: 'set' }, { ok: true, verb: 'set' }, statusReply({ settings: [entry] })],
      inputs: { 'realtime-responder.redactSecrets': 'hunter2' },
    })
    await strip.refresh()
    click({ action: 'list-add', key: 'realtime-responder.redactSecrets' })
    await sentTick()
    expect(frames).toEqual(['status', 'set realtime-responder.redactSecrets=["hunter2"]', 'status'])
    expect(strip.state().drafts['realtime-responder.redactSecrets']).toEqual(['hunter2'])
    expect(strip.state().notes['realtime-responder.redactSecrets']).toBe('1 in the list')

    // And the second add starts from what the editor holds rather than from nothing: an editor that reset
    // would replace the first entry with the second, silently.
    const again = fakePanel({ 'realtime-responder.redactSecrets': 'swordfish' })
    const strip2 = mountStrip({
      root: again.element,
      request: (frame) => Promise.resolve(frame === 'status' ? statusReply({ settings: [entry] }) : { ok: true, verb: 'set' }),
      connect: () => Promise.resolve({ kind: 'live' }),
      disconnect: () => undefined,
      audio: () => ({ kind: 'idle' }),
    })
    await strip2.refresh()
    again.click({ action: 'list-add', key: 'realtime-responder.redactSecrets' })
    await sentTick()
    expect(strip2.state().drafts['realtime-responder.redactSecrets']).toEqual(['swordfish'])
  })

  it('removes the entry that was asked for, whatever the plugin chose to hide', async () => {
    const entry = setting({ key: 'realtime-agent.stopWords', kind: 'string-list', field: 'stopWords', value: ['a', 'b'] })
    const { frames, strip, click } = panel({
      replies: [statusReply({ settings: [entry] }), { ok: true, verb: 'set' }, statusReply({ settings: [entry] })],
    })
    await strip.refresh()
    click({ action: 'list-remove', key: 'realtime-agent.stopWords', index: '0' })
    await sentTick()
    expect(frames).toEqual(['status', 'set realtime-agent.stopWords=["b"]', 'status'])
    expect(strip.state().drafts['realtime-agent.stopWords']).toEqual(['b'])
    expect(strip.state().notes['realtime-agent.stopWords']).toBe('1 in the list')
  })

  it('drops an entry a list click named without an index, rather than guessing one', async () => {
    // No index is a click from something the panel did not render. Every entry stays, and the frame it sends
    // is the list unchanged — honest, where a guess would delete whichever entry came first.
    const entry = setting({ key: 'realtime-agent.stopWords', kind: 'string-list', field: 'stopWords', value: ['a'] })
    const { frames, strip, click } = panel({
      replies: [statusReply({ settings: [entry] }), { ok: true, verb: 'set' }, statusReply({ settings: [entry] })],
    })
    await strip.refresh()
    click({ action: 'list-remove', key: 'realtime-agent.stopWords' })
    await sentTick()
    expect(frames).toEqual(['status', 'set realtime-agent.stopWords=["a"]', 'status'])
  })

  it('ignores a list click that names no setting at all', async () => {
    const { frames, strip, click } = panel({ replies: [statusReply()] })
    await strip.refresh()
    click({ action: 'list-add' })
    await sentTick()
    click({ action: 'list-remove' })
    await sentTick()
    expect(frames).toEqual(['status'])
  })

  it('steers with the picker’s value and reports the outcome against that field', async () => {
    const { frames, strip, click } = panel({ replies: [statusReply(), { ok: true, verb: 'steer', key: 'realtime-responder.sessionId', value: 'sess-2' }, statusReply()] })
    await strip.refresh()
    click({ action: 'steer', key: 'realtime-responder.sessionId' })
    await sentTick()

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
    await sentTick()

    expect(strip.state().notes['realtime-agent.autoStart'])
      .toBe('FROZEN_SETTING: "x" is claimed when the plugin loads — restart to change it')
  })

  it('sends a set for everything that is not the session picker', async () => {
    const { frames, strip, click } = panel({ inputs: { 'realtime-responder.answerTimeoutMs': '90000' } })
    await strip.refresh()
    click({ action: 'set', key: 'realtime-responder.answerTimeoutMs' })
    await sentTick()
    expect(frames).toEqual(['status', 'set realtime-responder.answerTimeoutMs=90000', 'status'])
  })

  it('starts and stops the voice from the panel, and reports which happened', async () => {
    const { frames, strip, click } = panel({ replies: [statusReply(), { ok: true, verb: 'start' }, statusReply()] })
    await strip.refresh()
    click({ action: 'voice-start' })
    await sentTick()
    expect(frames).toEqual(['status', 'start', 'status'])
    expect(strip.state().notice).toBe('voice started')

    click({ action: 'voice-stop' })
    await sentTick()
    expect(strip.state().notice).toBe('voice stopped')
  })

  it('relays a session refusal with its remedy AND the page, instead of "no reason given"', async () => {
    // The failure a user is most likely to meet: an account that cannot pay. The reply nests its own
    // classified code, remedy and page, and leaves the control-level `reason` unset — so reading only `reason`
    // made this panel say "refused: no reason given" at the exact moment it knew what to do.
    const { element, strip, click } = panel({
      replies: [
        statusReply(),
        {
          ok: false,
          verb: 'start',
          refusal: {
            code: 'INSUFFICIENT_CREDIT',
            remedy: 'add credit to the OpenAI account — the balance is exhausted',
            link: 'https://platform.openai.com/settings/organization/billing/',
          },
        },
        statusReply(),
      ],
    })
    await strip.refresh()
    click({ action: 'voice-start' })
    await sentTick()

    expect(strip.state().notice)
      .toBe('INSUFFICIENT_CREDIT: add credit to the OpenAI account — the balance is exhausted')
    expect(strip.state().noticeLink).toBe('https://platform.openai.com/settings/organization/billing/')
    // The page travels with the remedy: naming an action without naming where to take it is half an
    // instruction. This anchor is the only `href` the panel emits.
    expect(element.innerHTML)
      .toContain('href="https://platform.openai.com/settings/organization/billing/"')
    expect(element.innerHTML).toContain('rel="noreferrer noopener"')
    expect(element.innerHTML).not.toContain('no reason given')
  })

  it('still says something for a session refusal that explained itself badly', async () => {
    const { strip, click } = panel({ replies: [statusReply(), { ok: false, verb: 'start', refusal: {} }, statusReply()] })
    await strip.refresh()
    click({ action: 'voice-start' })
    await sentTick()

    // No code, no class, no remedy and no page: named as refused rather than invented, and no anchor is
    // emitted for a remedy that named no destination. The same honesty the control-level path keeps below.
    expect(strip.state().notice).toBe('refused: no reason given')
    expect(strip.state().noticeLink).toBe('')
  })

  it('connects and disconnects the microphone — the on-switch that used to be a console global', async () => {
    const page = fakePanel()
    let live = false
    let connectingWhileSettling = false
    const strip = mountStrip({
      root: page.element,
      request: () => Promise.resolve(statusReply({ voice: { open: false, provider: 'fake', model: 'gpt-live-1' } })),
      connect: () => { live = true; connectingWhileSettling = strip.state().connecting; return Promise.resolve({ kind: 'live' }) },
      disconnect: () => { live = false },
      audio: () => live ? { kind: 'live' } : { kind: 'idle' },
    })

    page.click({ action: 'connect' })
    await sentTick()
    expect(live).toBe(true)
    // The lamp is amber for the length of the connect, so the panel says what it is waiting on.
    expect(connectingWhileSettling).toBe(true)
    expect(strip.state().connecting).toBe(false)
    expect(page.element.innerHTML).toContain('class="dvr-btn on" data-action="disconnect">MIC')

    page.click({ action: 'disconnect' })
    await sentTick()
    expect(live).toBe(false)
    expect(page.element.innerHTML).toContain('data-action="connect">MIC')
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
    await sentTick()
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

  it('does nothing for a control clicked before the first status has arrived', async () => {
    // `settings()` reads the reply's own list and there is none yet, so the wait pair resolves to nothing and
    // the click stops — rather than reading the list out of the last render, which is a state the registry
    // may already have moved on from.
    const { frames, click } = panel()
    click({ action: 'wait' })
    await sentTick()
    expect(frames).toEqual([])
  })

  it('asks with what it has when a control named no key and holds no value', async () => {
    // A click from something the panel did not render. The frame is well-formed and empty where a value is
    // missing, and the channel answers with its own refusal: a panel that declined to send would be inventing
    // a rule the channel does not have.
    const { frames, strip, click } = panel({ replies: [statusReply(), { ok: true, verb: 'set' }, statusReply()] })
    await strip.refresh()
    click({ action: 'toggle' })
    await sentTick()
    expect(frames).toEqual(['status', 'set =', 'status'])
  })

  it('writes the wait pair with an empty value when the field is not on screen', async () => {
    const { frames, strip, click } = panel({
      replies: [
        statusReply({ settings: waitPair(10_000, 45_000) }),
        { ok: true, verb: 'set' },
        { ok: true, verb: 'set' },
        statusReply({ settings: waitPair(10_000, 45_000) }),
      ],
    })
    await strip.refresh()
    click({ action: 'wait', key: 'realtime-agent.delegationTimeoutMs' })
    await sentTick()
    expect(frames).toEqual([
      'status',
      'set realtime-agent.delegationTimeoutMs=',
      'set realtime-responder.answerTimeoutMs=',
      'status',
    ])
  })

  it('adds the entry the editor is holding, even when that is an empty one', async () => {
    const entry = setting({ key: 'realtime-agent.stopWords', kind: 'string-list', field: 'stopWords', value: [] })
    const { frames, strip, click } = panel({
      replies: [statusReply({ settings: [entry] }), { ok: true, verb: 'set' }, statusReply({ settings: [entry] })],
    })
    await strip.refresh()
    click({ action: 'list-add', key: 'realtime-agent.stopWords' })
    await sentTick()
    expect(frames).toEqual(['status', 'set realtime-agent.stopWords=[""]', 'status'])
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
      expect(page.element.innerHTML).toContain('no status yet')
      const exposed = (globalThis as unknown as Record<string, { mount: () => void; state: () => unknown; stop: () => void; request: (frame: string) => Promise<unknown> }>)[GLOBAL_KEY]!
      expect(exposed.mount).toBeTypeOf('function')
      const rendered = page.writes()
      exposed.mount()
      await sentTick()
      expect(page.writes()).toBe(rendered)

      // Driven through the panel's own controls, which is what makes the bundle's mount more than a
      // decoration: this page cannot reach a socket at all, and the panel says so — in the meter's own line
      // for the reason, and in the notice for why the status could not be read.
      page.click({ action: 'connect' })
      await sentTick()
      expect(page.element.innerHTML).toContain('microphone: no authority for the audio socket')
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
