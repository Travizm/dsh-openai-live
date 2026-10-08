import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  GLOBAL_KEY,
  apply,
  createAudioClient,
  defaultDeps,
  float32FromPcm16,
  pcm16FromFloat32,
  socketUrl,
  type ClientAudioDeps,
  type ContextLike,
  type ScopeLike,
  type SocketLike,
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
  const sent: Uint8Array[] = []
  let closes = 0
  let markReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => { markReady = resolve })
  const handlers: Record<HandlerName, ((event: { data: unknown }) => void) | null> = {
    onopen: null, onmessage: null, onerror: null, onclose: null,
  }
  const socket = {
    binaryType: '',
    send: (data: Uint8Array) => { sent.push(data) },
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

  const node = (name: string) => ({ connect: () => {}, disconnect: () => { disconnects.push(name) } })
  const context = {
    get sampleRate(): number { return options.sampleRate ?? 24_000 },
    get currentTime(): number { return clock },
    destination: {},
    createMediaStreamSource: () => node('source'),
    createScriptProcessor: () => ({
      ...node('processor'),
      set onaudioprocess(handler: typeof capture) { capture = handler },
    }),
    createGain: () => ({ ...node('gain'), gain: { value: 1 } }),
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
    expect(Array.from(new Int16Array(h.sent[0]!.buffer))).toEqual([0, 16384, -16384])
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
