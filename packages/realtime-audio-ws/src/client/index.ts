/**
 * The browser face: microphone in, speaker out, over the host route.
 *
 * This is the client half of the transport. `dsh-realtime-audio-ws` claims the socket on the host and
 * bridges it to the agent's audio events; this file opens that socket, captures the microphone into it, and
 * plays what comes back.
 *
 * **One file, on purpose.** A client face is served as a single resource (`<package>/client.js`), so a
 * relative value import would emit a second file the loader never serves. Everything therefore lives here,
 * including the API shapes it needs.
 *
 * **No DOM lib, also on purpose.** The browser APIs are described structurally and read off `globalThis`
 * through one cast, so this compiles in the package's ordinary program — no second tsconfig, no DOM lib,
 * no bundler — and every path is testable by injecting fakes. `standard-browser-types` would have bought
 * accurate types for six objects at the cost of a whole second build face; this is the cheaper trade.
 *
 * **`ScriptProcessorNode`, and why.** The modern capture path is an `AudioWorklet`, whose module must be
 * fetched from a URL — a `blob:` URL, which a page's Content-Security-Policy can refuse. The desktop app
 * demonstrably *has* a CSP (a `connect-src 'none'` string is in its bundle, governing the shell pages), and
 * I have not read the app page's policy. `ScriptProcessorNode` needs no URL, no module fetch and no policy
 * grant, and it runs in the page, so the whole capture path is testable. It is deprecated and its latency is
 * worse. That is a deliberate, disclosed trade: swap it for a worklet once the app page's `script-src` has
 * actually been read, rather than shipping a capture path that a policy might silently kill.
 */

/** Browser-side plugin name. */
export const name = 'realtime-audio-client'

/**
 * No client services. The socket, the device and the audio graph are all this plugin's own, so it injects
 * nothing — and a client face that needs nothing cannot be broken by another plugin's absence.
 */
export const inject: string[] = []

/** Where the host route lives. Duplicated from the host package because a client face cannot import it. */
export const DEFAULT_PATH = '/dsh-realtime/audio'

/** The session's declared rate. The graph is opened at this rate or the client refuses to run. */
export const SAMPLE_RATE = 24_000

/** Capture chunk in samples. 1024 at 24 kHz is ~43 ms: the 2^10 floor the API allows, so latency is lowest. */
export const CAPTURE_BUFFER = 1024

/** Backlog past which incoming speech is dropped rather than queued — the same rule the host carries. */
export const MAX_BACKLOG_SECONDS = 0.5

/** Global the client publishes itself on. There is no UI surface yet; this is how it is started. */
export const GLOBAL_KEY = '__dshRealtimeAudio'

/** Optional host-injected settings. A future index-injection row may set the path; the default matches. */
export const INJECTED_KEY = '__DSH_REALTIME_AUDIO__'

// ---- the API shapes this file needs, described rather than imported -----------------------------------

export interface LocationLike { readonly protocol: string; readonly host: string }
export interface TrackLike { stop(): void; readonly kind?: string }
export interface StreamLike { getTracks(): TrackLike[] }
export interface MediaNodeLike { connect(target: MediaNodeLike | unknown): void; disconnect(): void }
export interface BufferLike { readonly duration: number; getChannelData(channel: number): Float32Array }
export interface SourceLike { buffer: unknown; connect(target: unknown): void; start(when?: number): void }
export interface ContextLike {
  readonly sampleRate: number
  readonly currentTime: number
  readonly destination: unknown
  createMediaStreamSource(stream: StreamLike): MediaNodeLike
  createScriptProcessor(buffer: number, inputs: number, outputs: number): MediaNodeLike & {
    onaudioprocess: ((event: { inputBuffer: BufferLike }) => void) | null
  }
  createBuffer(channels: number, frames: number, rate: number): BufferLike
  createGain(): MediaNodeLike & { readonly gain: { value: number } }
  createBufferSource(): SourceLike
  close(): Promise<void>
}
export interface SocketLike {
  binaryType?: string
  send(data: Uint8Array): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
}

/**
 * The slice of a client Cordis context this plugin uses.
 *
 * Structural, and not only for testability: this face is served as a single CommonJS module, so any import
 * it carried would have to be resolvable by whatever the module table hands the bundle. It needs one
 * method, so it states one and imports nothing at all.
 */
export interface ClientContextLike {
  effect(run: unknown, label?: string): unknown
}

/** Everything this plugin touches outside itself, injectable so every path is testable. */
export interface ClientAudioDeps {
  readonly location: LocationLike | undefined
  readonly getUserMedia: ((constraints: unknown) => Promise<StreamLike>) | undefined
  readonly createAudioContext: ((sampleRate: number) => ContextLike) | undefined
  readonly createSocket: ((url: string) => SocketLike) | undefined
  readonly injected: { readonly path?: string } | undefined
}

/** What the caller — or a test — gets to see. */
export type ClientAudioState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'live' }
  | { readonly kind: 'failed'; readonly reason: string }

export interface ClientAudio {
  /** Acquire the microphone and connect. Resolves with the state it reached. */
  start(): Promise<ClientAudioState>
  /** Release everything. Safe to call when not started. */
  stop(): void
  /** Current state. */
  state(): ClientAudioState
}

// ---- pure helpers --------------------------------------------------------------------------------------

/**
 * The socket URL for the host route.
 *
 * @param location - the page's location, or undefined when there is none.
 * @param path - the route pathname.
 * @returns the URL, or undefined when this page cannot host a socket at all.
 */
export function socketUrl(location: LocationLike | undefined, path: string): string | undefined {
  if (location === undefined || location.host === '') return undefined
  // An https page may not open a ws:// socket — the browser blocks it as mixed content — so the scheme has
  // to follow the page rather than being decided here.
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}${path}`
}

/**
 * Convert one captured float block to the wire's PCM16.
 *
 * Clamped, not wrapped: a sample above 1.0 is a loud peak, and letting it wrap turns a loud voice into
 * noise. Asymmetric on purpose — 32767 is the largest Int16 and -32768 the smallest, so scaling both by the
 * same factor would clip every negative peak one step early.
 *
 * @param input - samples in the range [-1, 1].
 * @returns the same samples as little-endian PCM16 bytes.
 */
export function pcm16FromFloat32(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  // `entries()` rather than an index: under `noUncheckedIndexedAccess` an indexed read is
  // `number | undefined`, and guarding that would add a branch that can never be taken at runtime.
  for (const [index, raw] of input.entries()) {
    const sample = Math.max(-1, Math.min(1, raw))
    out[index] = Math.round(sample < 0 ? sample * 32768 : sample * 32767)
  }
  return out
}

/**
 * Read one PCM16 frame as playback samples.
 *
 * @param bytes - the frame.
 * @returns samples in [-1, 1).
 */
export function float32FromPcm16(bytes: Uint8Array): Float32Array {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
  const out = new Float32Array(samples.length)
  for (const [index, sample] of samples.entries()) out[index] = sample / 32768
  return out
}

// ---- the client ----------------------------------------------------------------------------------------

export interface ScopeLike {
  location?: LocationLike
  navigator?: { mediaDevices?: { getUserMedia(constraints: unknown): Promise<StreamLike> } }
  AudioContext?: new (options: { sampleRate: number }) => ContextLike
  WebSocket?: new (url: string) => SocketLike
  __DSH_REALTIME_AUDIO__?: { readonly path?: string }
}

/**
 * Read the real browser APIs, and any settings the host injected.
 *
 * @param scope - the global scope, injectable so both the present and absent cases are testable without
 * mutating the process's own globals.
 * @returns the production dependencies. Every one may be absent, which is why `start` reports rather than
 * throws: a page without a microphone API is a fact about the page, not a defect in the caller.
 */
export function defaultDeps(scope: ScopeLike = globalThis as unknown as ScopeLike): ClientAudioDeps {
  const media = scope.navigator?.mediaDevices
  const Audio = scope.AudioContext
  const Socket = scope.WebSocket
  return {
    location: scope.location,
    getUserMedia: media === undefined ? undefined : (constraints) => media.getUserMedia(constraints),
    createAudioContext: Audio === undefined ? undefined : (rate) => new Audio({ sampleRate: rate }),
    createSocket: Socket === undefined ? undefined : (url) => new Socket(url),
    injected: scope.__DSH_REALTIME_AUDIO__,
  }
}

/**
 * The client: one microphone in, one socket out, one speaker fed.
 *
 * @param deps - the outside world, injected so every path is testable.
 * @returns the start/stop/state handle.
 */
export function createAudioClient(deps: ClientAudioDeps): ClientAudio {
  let current: ClientAudioState = { kind: 'idle' }
  let socket: SocketLike | undefined
  let context: ContextLike | undefined
  let stream: StreamLike | undefined
  let processor: MediaNodeLike | undefined
  let silence: MediaNodeLike | undefined
  let playsAt = 0

  const fail = (reason: string): ClientAudioState => {
    current = { kind: 'failed', reason }
    return current
  }

  /** Release everything held. Idempotent, because stop, an error and a close all reach it. */
  const release = (): void => {
    socket?.close()
    socket = undefined
    processor?.disconnect()
    processor = undefined
    silence?.disconnect()
    silence = undefined
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = undefined
    const closing = context
    context = undefined
    if (closing !== undefined) void closing.close().catch(() => undefined)
    playsAt = 0
  }

  /** Play one frame, dropping it rather than queueing when we are already behind. */
  const play = (bytes: Uint8Array): void => {
    if (context === undefined) return
    const samples = float32FromPcm16(bytes)
    if (samples.length === 0) return
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE)
    buffer.getChannelData(0).set(samples)
    const now = context.currentTime
    const at = Math.max(now, playsAt)
    // Unbuffered, like the host: audio that is already late is dropped rather than played behind, because a
    // queue that grows converts a stutter into a permanent delay that never recovers.
    if (at - now > MAX_BACKLOG_SECONDS) return
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.start(at)
    playsAt = at + buffer.duration
  }

  /** Build the capture graph and start shipping frames. */
  const attachCapture = (): ClientAudioState => {
    if (context === undefined || stream === undefined || socket === undefined) {
      return fail('the audio graph went away before the socket opened')
    }
    const source = context.createMediaStreamSource(stream)
    const node = context.createScriptProcessor(CAPTURE_BUFFER, 1, 1)
    node.onaudioprocess = (event) => {
      const pcm16 = pcm16FromFloat32(event.inputBuffer.getChannelData(0))
      socket?.send(new Uint8Array(pcm16.buffer))
    }
    // A ScriptProcessorNode only fires while connected to the destination — and connecting the microphone
    // there is a feedback loop. A zero-gain node keeps it running with nothing audible, which is the whole
    // reason this chain looks the way it does.
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(context.destination)
    processor = node
    silence = mute
    current = { kind: 'live' }
    return current
  }

  const stop = (): void => {
    release()
    current = { kind: 'idle' }
  }

  const start = async (): Promise<ClientAudioState> => {
    if (current.kind === 'live') return current
    const url = socketUrl(deps.location, deps.injected?.path ?? DEFAULT_PATH)
    if (url === undefined) return fail('this page has no location to open a socket against')
    if (deps.getUserMedia === undefined) return fail('this page has no microphone API')
    if (deps.createAudioContext === undefined) return fail('this page has no audio API')
    if (deps.createSocket === undefined) return fail('this page has no WebSocket API')

    try {
      stream = await deps.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
    } catch (error) {
      // A refused permission is the ordinary case here, not an error to hide: the reason is what tells the
      // user whether to grant it or to look somewhere else.
      return fail(error instanceof Error ? error.message : String(error))
    }

    context = deps.createAudioContext(SAMPLE_RATE)
    if (context.sampleRate !== SAMPLE_RATE) {
      // Refuse rather than mislabel. Streaming 48 kHz samples declared as 24 kHz arrives at half speed and
      // sounds like a provider fault, which is the most expensive possible way to learn about a resampler.
      const opened = context.sampleRate
      release()
      return fail(`the audio graph opened at ${String(opened)} Hz, not ${String(SAMPLE_RATE)}`)
    }

    const opened = deps.createSocket(url)
    socket = opened
    opened.binaryType = 'arraybuffer'
    opened.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) play(new Uint8Array(event.data))
    }
    opened.onclose = () => {
      release()
      current = { kind: 'idle' }
    }
    return await new Promise<ClientAudioState>((resolve) => {
      opened.onopen = () => { resolve(attachCapture()) }
      opened.onerror = () => { resolve(fail('the host refused the audio socket')) }
    })
  }

  return { start, stop, state: () => current }
}

/**
 * The client plugin. Publishes the client on a global and releases it with the plugin.
 *
 * There is no UI surface yet, so a global is how it is driven — a settings card is its own increment and a
 * bigger one than this. `inject` is empty for the same reason: nothing here needs another plugin.
 *
 * @param ctx - the client context, used only to own the lifetime.
 */
export function apply(ctx: ClientContextLike): void {
  const client = createAudioClient(defaultDeps())
  ;(globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY] = {
    start: () => client.start(),
    stop: () => { client.stop() },
    state: () => client.state(),
  }
  // A held microphone and a live audio graph must not outlive the plugin that opened them.
  ctx.effect(() => () => { client.stop() }, 'realtime-audio-client')
}
