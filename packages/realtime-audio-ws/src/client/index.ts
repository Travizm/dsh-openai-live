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

/**
 * What the host injects into the page: the route path, the authority to open the socket against, and the
 * capability token to present. Every field is optional, because an older host injects only the path.
 */
export interface InjectedRouteSettings {
  readonly path?: string
  readonly authority?: string
  readonly token?: string
}

/** Optional host-injected settings, published as a `global` index-injection row before this file runs. */
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
  /** Binary frames carry audio; a string is a control frame. */
  send(data: Uint8Array | string): void
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
  readonly injected: InjectedRouteSettings | undefined
}

/** What the caller — or a test — gets to see. */
export type ClientAudioState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'live' }
  | { readonly kind: 'failed'; readonly reason: string }

/** One setting as `status` reports it. Structural, like everything else here: a client face imports nothing. */
export interface SettingLike {
  readonly key: string
  readonly field: string
  readonly kind: string
  readonly scope: string
  readonly describe?: string
  readonly value?: unknown
  /** The values a picker may offer. Present only when the owner declared a set to pick from. */
  readonly choices?: readonly string[]
}

/**
 * One control reply, as the panel reads it.
 *
 * Described rather than imported, for the reason the whole file describes its APIs: a type-only import
 * would still pull the host module into this program, and a second emitted file is one the module table
 * never serves.
 */
export interface ControlReplyLike {
  readonly ok: boolean
  readonly verb?: string
  readonly code?: string
  readonly reason?: string
  /**
   * A *session* refusal, nested inside the reply.
   *
   * A control-level refusal sets `code` and `reason`; a session-level one carries its own classified code, the
   * remedy written to be relayed, and the page the remedy is carried out on. Reading only the top level made
   * the panel answer the failure a user is most likely to meet with "refused: no reason given".
   */
  readonly refusal?: {
    readonly code?: string
    readonly class?: string
    readonly remedy?: string
    readonly link?: string
  }
  readonly key?: string
  readonly value?: unknown
  readonly voice?: { readonly open: boolean; readonly provider?: string; readonly model?: string; readonly sessionId?: string } | null
  readonly audio?: { readonly path?: string; readonly clients?: number }
  readonly settings?: readonly SettingLike[]
  readonly journal?: { readonly size?: number; readonly last?: { readonly kind?: string } | null }
}

export interface ClientAudio {
  /** Acquire the microphone and connect. Resolves with the state it reached. */
  start(): Promise<ClientAudioState>
  /** Release everything. Safe to call when not started. */
  stop(): void
  /** Current state. */
  state(): ClientAudioState
  /**
   * Send one control frame and resolve with its reply.
   *
   * The panel's whole transport. Requests are serialised: the host answers in arrival order, but the
   * *client* still sends one frame at a time, because a caller that pipelined would be pairing replies
   * with frames by guesswork the moment anything on the host slowed down.
   *
   * Rejects — rather than inventing a reply — when there is no socket: nothing was sent, so there is
   * nothing the channel could have said about it.
   * @param frame - one control frame, e.g. `status` or `set key=value`.
   * @returns the host's reply, already parsed.
   */
  request(frame: string): Promise<ControlReplyLike>
}

// ---- pure helpers --------------------------------------------------------------------------------------

/**
 * The socket URL for the host route.
 *
 * @param location - the page's location, or undefined when there is none.
 * @param path - the route pathname.
 * @returns the URL, or undefined when this page cannot host a socket at all.
 */
export function socketUrl(
  location: LocationLike | undefined,
  path: string,
  authority?: string,
): string | undefined {
  const host = authority !== undefined && authority !== '' ? authority : pageAuthority(location)
  if (host === undefined) return undefined
  // An https page may not open a ws:// socket — the browser blocks it as mixed content — so the scheme has
  // to follow the page rather than being decided here.
  const scheme = location?.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${host}${path}`
}

/**
 * The authority a page can derive for itself, or undefined when it cannot derive a usable one.
 *
 * Only an http(s) page addresses a server. The desktop app's page is served from `dsh-app://app`, whose
 * host is the literal string `app`: deriving a socket URL from it yields `ws://app/...`, which resolves
 * nowhere and fails in a way that reads exactly like the host refusing the connection — a wrong answer
 * that costs an afternoon. Returning undefined lets the caller name the real cause instead.
 *
 * @param location - the page's location, or undefined when there is none.
 * @returns the authority, or undefined when this page has no usable one of its own.
 */
export function pageAuthority(location: LocationLike | undefined): string | undefined {
  if (location === undefined) return undefined
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return undefined
  return location.host === '' ? undefined : location.host
}

/**
 * Attach the capability token, when the host injected one.
 *
 * @param url - the socket URL.
 * @param token - the injected token, or undefined on a host that injects none.
 * @returns the URL to open.
 */
export function withToken(url: string, token: string | undefined): string {
  if (token === undefined || token === '') return url
  return `${url}?t=${encodeURIComponent(token)}`
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
  __DSH_REALTIME_AUDIO__?: InjectedRouteSettings
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
  /** The control request waiting for its reply, if any. The host answers one frame with one frame. */
  let pending: { resolve: (reply: ControlReplyLike) => void; reject: (error: Error) => void } | undefined
  /** The tail of the request chain, so two frames are never in flight at once. */
  let chain: Promise<unknown> = Promise.resolve()

  const fail = (reason: string): ClientAudioState => {
    current = { kind: 'failed', reason }
    return current
  }

  /** Release everything held. Idempotent, because stop, an error and a close all reach it. */
  const release = (): void => {
    // A request whose socket is going away must fail rather than hang: the panel disables half of itself
    // while one is in flight, and a promise that never settles would leave it disabled for ever.
    pending?.reject(new Error('the audio socket closed before the host answered'))
    pending = undefined
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
      // Every quantum ships, **silent ones included, and that is load-bearing rather than incidental**: the
      // provider's session timeline advances with the audio this client sends, and a context append is
      // placed only while that timeline is advancing — so a client that skipped silent blocks (an
      // obvious-looking saving) would silently freeze the session and lose every append after it. Measured,
      // with the mechanism, in `docs/usable-window.md`; guarded by the capture-continuity case in
      // `tests/client.spec.ts`.
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
    const route = socketUrl(deps.location, deps.injected?.path ?? DEFAULT_PATH, deps.injected?.authority)
    if (route === undefined) {
      return fail('no authority for the audio socket: this page has none of its own and the host injected none')
    }
    const url = withToken(route, deps.injected?.token)
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
      // Binary frames are audio; a string is the answer to a control frame. The frame's own type is what
      // tells them apart, which is why the control channel cost this path nothing.
      if (event.data instanceof ArrayBuffer) {
        play(new Uint8Array(event.data))
        return
      }
      if (typeof event.data !== 'string') return
      const waiting = pending
      pending = undefined
      if (waiting === undefined) return
      try {
        waiting.resolve(JSON.parse(event.data) as ControlReplyLike)
      } catch {
        // A reply that is not JSON is a host fault, and the caller has to hear about it rather than be left
        // waiting: the same rule the channel itself follows, one side out.
        waiting.reject(new Error('the host answered a control frame with something that is not a reply'))
      }
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

  /**
   * Send one frame and wait for its reply.
   *
   * The socket is looked up at the moment of use rather than closed over, so a request made after a
   * reconnect goes out on the socket that exists now — the same rule every other live value in this
   * project follows.
   * @param frame - the control frame.
   * @returns the parsed reply.
   */
  const sendFrame = (frame: string): Promise<ControlReplyLike> => {
    const current = socket
    if (current === undefined) {
      return Promise.reject(new Error('not connected: connect the microphone first'))
    }
    return new Promise<ControlReplyLike>((resolve, reject) => {
      pending = { resolve, reject }
      current.send(frame)
    })
  }

  const request = (frame: string): Promise<ControlReplyLike> => {
    // Chained, not concurrent: the host answers in arrival order, and a client that pipelined would be
    // pairing replies with frames by guesswork. The chain is kept alive across a failure, because one
    // refused frame must not silently stop every frame behind it.
    const next = chain.then(() => sendFrame(frame))
    chain = next.catch(() => undefined)
    return next
  }

  return { start, stop, state: () => current, request }
}

// ---- the strip: the panel this plugin puts in the app ---------------------------------------------------

/** The element the injected markup provides. Duplicated in the host half, which mints the row. */
export const STRIP_ELEMENT_ID = 'dsh-realtime-strip'

/** The plate's wordmark and model, engraved. The host half styles the plate; the deck is minted here. */
export const STRIP_WORDMARK = 'REALTIME'
export const STRIP_MODEL = 'DV-1 · DESK VOICE UNIT'

/** The segments in the input meter. Its own scale, not a level — see {@link meterMarkup}. */
export const METER_SEGMENTS = 14

/** Which of the panel's three drill levels is showing. */
export type StripLevel = 'collapsed' | 'controls' | 'all'

/** What the pilot lamp is reporting. */
export type LampState = 'live' | 'connecting' | 'closed'

/** The lamp's own word, engraved beside it. */
const LAMP_WORDS: Readonly<Record<LampState, string>> = { live: 'LIVE', connecting: 'LINK', closed: 'CLOSED' }

/**
 * Short legends for the controls that sit on the plate.
 *
 * A description is not a label: schema prose written to explain a field to a developer is too long to scan
 * beside a control, and two such sentences about different fields read as one field described twice. The
 * full prose is one drill level down, where the raw registry rows are.
 */
const SHORT_LABELS: Readonly<Record<string, string>> = {
  speakMilestones: 'SPEAK STEPS',
  maxPromptChars: 'PROMPT',
  maxSpokenMilestones: 'MILESTONES',
  sessionId: 'SESSION',
}

/**
 * The minimum of a DOM element this file uses.
 *
 * Structural, like everything else here, and for a second reason beyond testability: the panel's logic
 * lives *in this bundle* rather than in the injected script, so what it does is covered by tests instead of
 * sitting in a string that nothing ever executes.
 */
export interface StripElement {
  innerHTML: string
  /** An input's or a select's current value. Absent on everything else. */
  value?: string
  addEventListener(type: 'click' | 'change', listener: (event: StripEvent) => void): void
  querySelector(selector: string): StripElement | null
}

/** A click or a change, as much of it as the panel reads. */
export interface StripEvent {
  readonly target: {
    readonly dataset?: Record<string, string | undefined>
    readonly value?: string
  } | null
}

/** The page scope the panel looks itself up in. */
export interface StripScope {
  readonly document?: { getElementById(id: string): StripElement | null }
}

/** What the panel is showing, exposed so a test can read it rather than scrape the markup. */
export interface StripState {
  /** The last status, or `null` before one has arrived. */
  readonly reply: ControlReplyLike | null
  /** Per-setting notes, keyed by the setting's key: what the last change to *it* produced. */
  readonly notes: Readonly<Record<string, string>>
  /** Anything with no field to belong to — a transport failure, or what a start or stop produced. */
  readonly notice: string
  /**
   * Where a notice points, when it points anywhere.
   *
   * A remedy that says "add credit" without saying where is half an instruction, and the URL lives in the
   * provider's own message — which this design never carries. So it travels as its own field and is rendered
   * as an anchor: the one `href` this panel emits, and it comes from the provider table, never from text a
   * provider sent. Optional, because most notices point nowhere.
   */
  readonly noticeLink?: string
  /** What the microphone is doing. */
  readonly audio: ClientAudioState
  /** Which drill level is showing. Collapsed is the default, and the reason the panel is not in the way. */
  readonly level: StripLevel
  /**
   * The entries a list editor has built, keyed by the setting.
   *
   * Only ever used for a value the plugin **does not report** — the responder's `redactSecrets` is a
   * write-only `string-list` — because a list you cannot read cannot be edited in place: each add would
   * start from nothing and silently replace the one before it. For a list the registry does report, what it
   * says is what is shown.
   */
  readonly drafts: Readonly<Record<string, readonly string[]>>
  /** Whether a microphone connect is in flight, which is the lamp's amber. */
  readonly connecting: boolean
}

export interface StripDeps {
  readonly root: StripElement
  readonly request: (frame: string) => Promise<ControlReplyLike>
  /** Connect the microphone, resolving with the state the attempt reached. */
  readonly connect: () => Promise<ClientAudioState>
  readonly disconnect: () => void
  readonly audio: () => ClientAudioState
}

export interface Strip {
  /** Ask the host for a status and render whatever comes back. */
  refresh(): Promise<void>
  /** What is on screen now. */
  state(): StripState
}

/**
 * Where the injected markup puts the panel, or `null` when this page does not carry it.
 * @param scope - the page scope, injectable so both cases are testable without a DOM.
 * @returns the panel's element, or `null`.
 */
export function stripRoot(scope: StripScope): StripElement | null {
  return scope.document?.getElementById(STRIP_ELEMENT_ID) ?? null
}

/**
 * Escape text for an element's body and for a quoted attribute at once.
 *
 * One function rather than two because the two contexts differ only in which characters break out, and
 * every value a panel renders came from a plugin's own configuration — a session id, a model name, or
 * `instructions` somebody typed.
 * @param text - the text to escape.
 * @returns the text, safe in either position.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Show one value as text.
 * @param value - a setting's value as `status` reported it.
 * @returns the text to render.
 */
function show(value: unknown): string {
  if (value === undefined || value === null) return '—'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * A value as a number, for the controls that are numeric.
 *
 * `0` rather than a refusal for anything that is not a number: a number control for a setting that reported
 * nothing is a control for a setting that will refuse the write, and the registry's own reply is what says
 * so. Inventing a second refusal here would put two answers behind one refusal.
 * @param value - a setting's value as `status` reported it.
 * @returns the value, or `0`.
 */
function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/**
 * A value as a list of strings, when it is one.
 * @param value - a setting's value as `status` reported it.
 * @returns the strings, or `undefined` when the value is not an array.
 */
function asList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * One live setting of a given kind, by field.
 *
 * By `field` and not by `<owner>.<field>` key: which plugin owns a budget is not the panel's business, and
 * a panel keyed on an owner's name breaks the day the owner is renamed. The same resolution the control
 * channel's `steer` verb makes, for the same reason.
 * @param settings - every setting the status reported.
 * @param field - the setting's own name.
 * @param kind - the kind the control can drive.
 * @returns the setting, or `undefined`.
 */
function liveField(
  settings: readonly SettingLike[],
  field: string,
  kind: string,
): SettingLike | undefined {
  return settings.find(entry => entry.field === field && entry.kind === kind && entry.scope === 'live')
}

/**
 * The two budgets that each bound how long the voice waits, in the order the panel writes them.
 *
 * Measured rather than assumed, and the panel therefore rests on facts: the agent's `delegationTimeoutMs`
 * (how long the voice model waits for a responder) and the responder's `answerTimeoutMs` (how long one turn
 * waits for the agent). Both are `live`, so one control that writes both is an affordance the protocol can
 * honour — and **the smaller bound is what is heard**, in the responder's own words, so `min` is the truth
 * about what the pair does.
 *
 * Zero or one key is a real answer: in a profile with no agent row, or no responder row, the other budget
 * does not exist to be written.
 * @param settings - every setting the status reported.
 * @returns the keys, in the order they are written.
 */
export function waitKeys(settings: readonly SettingLike[]): readonly string[] {
  const keys: string[] = []
  for (const field of ['delegationTimeoutMs', 'answerTimeoutMs'] as const) {
    const entry = liveField(settings, field, 'number')
    if (entry !== undefined) keys.push(entry.key)
  }
  return keys
}

/**
 * What the wait control says it wrote, from the pair the registry now reports.
 *
 * Never the value that was asked for: a setter may clamp what it was handed, so the answer to "what does
 * this now do?" is the pair the plugin holds. Reported as a **pair** — a half-applied write has to be
 * visible as one, and averaging it would hide exactly the state a reader needs to see.
 * @param settings - every setting the status reported, re-read after the write.
 * @returns one line for the note.
 */
function waitSummary(settings: readonly SettingLike[]): string {
  const values = waitKeys(settings).map(key => asNumber(settings.find(entry => entry.key === key)?.value))
  if (values.length === 0) return 'no wait budget is registered'
  return `waits up to ${String(Math.round(Math.min(...values) / 1000))} s — ${values.map(value => String(value)).join(' / ')} ms`
}

/**
 * The pilot lamp's state.
 *
 * Green live, amber connecting, dark closed — one lamp rather than three words, and the amber is real
 * rather than decorative: a connect is a promise that settles, and the state it is in while it settles is
 * the only thing on this plate that changes without a repaint from the status.
 * @param state - what the panel is showing.
 * @returns which of the three the lamp reports.
 */
function lampState(state: StripState): LampState {
  if (state.connecting) return 'connecting'
  return state.reply?.voice?.open === true ? 'live' : 'closed'
}

/**
 * The input meter.
 *
 * **Not a level.** A real level needs a repaint loop, and repainting this element's `innerHTML` on a timer
 * would destroy whatever is half-typed in it — the list editor is the case that matters. So the bar encodes
 * the capture path's *state*, which is the one thing about the microphone that changes without a repaint:
 * dark when the device is not open, filled when it is, and a fault shown at the top of the scale where the
 * eye already looks for "something is wrong with the input". The state is named on the element for anyone
 * who cannot read the colour, and the title says what the bar is so it cannot be mistaken for a peak meter.
 * @param audio - what the microphone is doing.
 * @returns the meter's markup.
 */
function meterMarkup(audio: ClientAudioState): string {
  const live = audio.kind === 'live'
  const fault = audio.kind === 'failed'
  const segments = Array.from({ length: METER_SEGMENTS }, (_unused, index) => {
    if (fault) return index >= METER_SEGMENTS - 2 ? '<i class="dvr-seg on hot"></i>' : '<i class="dvr-seg"></i>'
    if (!live || index >= 11) return '<i class="dvr-seg"></i>'
    return `<i class="dvr-seg on${index >= 9 ? ' warm' : ''}"></i>`
  }).join('')
  return `<span class="dvr-meter" data-meter="${audio.kind}" role="img"`
    + ` aria-label="microphone ${audio.kind}" title="capture state — not a level">`
    + '<span class="dvr-cap"><span>INPUT</span><span>−12 −6 0</span></span>'
    + `<span class="dvr-scale">${segments}</span>`
    + '</span>'
}

/**
 * Where the voice is pointed.
 *
 * Three separate states, kept separate: nothing has answered yet, the profile has no agent to answer, and a
 * session that exists and knows where it points. Collapsing the first two is the mistake this line exists to
 * avoid — "no agent is mounted" behind a control that has simply not been asked yet sends a reader to the
 * wrong file.
 * @param reply - the last status, if any.
 * @returns one engraved line.
 */
function whereText(reply: ControlReplyLike | null): string {
  if (reply === null) return 'no status yet'
  const voice = reply.voice
  if (voice === null || voice === undefined) return 'no agent mounted'
  const model = `${voice.provider ?? '?'}/${voice.model ?? '?'}`
  return voice.sessionId === undefined ? model : `${model} · ${voice.sessionId}`
}

/**
 * The knob's pointer position, as one of eleven buckets.
 *
 * A readout, not a control: the pointer encodes where the value sits on the knob's own scale, and the field
 * beside it is what writes. The scale is the panel's, because the registry declares a kind and not a range —
 * which is exactly why a draggable knob would be a lie about what the panel knows.
 * @param value - the value in force.
 * @param span - the panel's own scale for this knob.
 * @returns a bucket from 0 to 10.
 */
function knobBucket(value: number, span: readonly [number, number]): number {
  const [low, high] = span
  const bucket = Math.round(((value - low) / (high - low)) * 10)
  return Math.min(10, Math.max(0, bucket))
}

/** One knob, as the panel lays it out. */
interface KnobSpec {
  readonly label: string
  /** Which verb writes it: `wait` writes both budgets, `set` writes the one key. */
  readonly action: 'set' | 'wait'
  readonly key: string
  readonly value: number
  readonly shown: string
  readonly span: readonly [number, number]
  /** Present only when something needs saying about the value — the capping layer, for the pair. */
  readonly caption?: string
}

/**
 * One knob: the dial, the legend, the value, and the field that writes it.
 * @param knob - what to draw.
 * @returns the knob's markup.
 */
function knobMarkup(knob: KnobSpec): string {
  const key = escapeHtml(knob.key)
  const caption = knob.caption === undefined ? '' : `<span class="dvr-knob-caption">${escapeHtml(knob.caption)}</span>`
  return '<div class="dvr-knob-unit">'
    + `<span class="dvr-knob dvr-knob--${String(knobBucket(knob.value, knob.span))}"`
    + ' title="readout — the field below is the control"></span>'
    + `<span class="dvr-knob-label">${escapeHtml(knob.label)}</span>`
    + `<span class="dvr-knob-value">${escapeHtml(knob.shown)}</span>`
    + caption
    + '<span class="dvr-knob-set">'
    + `<input class="dvr-input" type="number" data-input="${key}" value="${escapeHtml(String(knob.value))}">`
    + `<button class="dvr-btn" data-action="${knob.action}" data-key="${key}">Set</button>`
    + '</span></div>'
}

/**
 * The few controls worth a physical affordance.
 *
 * One primary for the wait budget rather than the two indistinguishable rows the screenshot showed, and the
 * mechanism one drill level down where it is reachable without being in the way.
 * @param settings - every setting the status reported.
 * @returns the knobs' markup, empty when none of them are registered.
 */
function knobsMarkup(settings: readonly SettingLike[]): string {
  const knobs: string[] = []
  const waits = waitKeys(settings)
  if (waits.length > 0) {
    const values = waits.map(key => asNumber(settings.find(entry => entry.key === key)?.value))
    const binding = Math.min(...values)
    // The cap is named only when the two actually diverge, because that is the only case in which one of
    // them is inert — and an inert control that accepts input and does nothing is the defect this design
    // exists to remove.
    const caption = values.length < 2 || values[0] === values[1]
      ? undefined
      : `capped by the ${values[0]! < values[1]! ? 'reply' : 'turn'} budget`
    knobs.push(knobMarkup({
      label: 'WAIT',
      action: waits.length === 2 ? 'wait' : 'set',
      key: waits[0]!,
      value: binding,
      shown: `${String(Math.round(binding / 1000))} s`,
      span: [1000, 120_000],
      ...caption === undefined ? {} : { caption },
    }))
  }
  const prompt = liveField(settings, 'maxPromptChars', 'number')
  if (prompt !== undefined) {
    knobs.push(knobMarkup({
      label: SHORT_LABELS.maxPromptChars!,
      action: 'set',
      key: prompt.key,
      value: asNumber(prompt.value),
      shown: `${String(asNumber(prompt.value))} ch`,
      span: [0, 8000],
    }))
  }
  const milestones = liveField(settings, 'maxSpokenMilestones', 'number')
  if (milestones !== undefined) {
    knobs.push(knobMarkup({
      label: SHORT_LABELS.maxSpokenMilestones!,
      action: 'set',
      key: milestones.key,
      value: asNumber(milestones.value),
      shown: String(asNumber(milestones.value)),
      span: [0, 6],
    }))
  }
  return knobs.join('')
}

/**
 * A switch that is not a setting: it drives a verb.
 * @param action - the control verb.
 * @param on - whether the thing it drives is on.
 * @param label - its legend.
 * @param colour - the LED's colour when lit.
 * @returns the switch's markup.
 */
function lampSwitch(action: string, on: boolean, label: string, colour: 'green' | 'amber'): string {
  const lit = on ? ` on ${colour}` : ''
  return `<button class="dvr-switch" data-action="${action}" aria-pressed="${String(on)}">`
    + `<i class="dvr-led${lit}"></i><span>${label}</span></button>`
}

/**
 * A boolean setting as a toggle.
 *
 * A toggle and not a text box holding `true`: typing `false` into a field is a coercion the user has to get
 * right, and a toggle cannot be got wrong. The value it writes is carried on the button, so the flip is
 * decided against the value the panel was rendered with rather than a second read of the page.
 * @param entry - the setting.
 * @returns the toggle's markup.
 */
function booleanSwitch(entry: SettingLike): string {
  const key = escapeHtml(entry.key)
  const on = entry.value === true
  return `<button class="dvr-switch" data-action="toggle" data-key="${key}"`
    + ` data-value="${on ? 'false' : 'true'}" aria-pressed="${String(on)}">`
    + `<i class="dvr-led${on ? ' on' : ''}"></i>`
    + `<span>${escapeHtml(SHORT_LABELS[entry.field] ?? entry.field)}</span>`
    + `<b class="dvr-switch-state">${on ? 'ON' : 'OFF'}</b></button>`
}

/**
 * The switches row: the microphone, the session, and every live boolean.
 * @param state - what the panel is showing.
 * @param settings - every setting the status reported.
 * @returns the row's markup.
 */
function switchesMarkup(state: StripState, settings: readonly SettingLike[]): string {
  const voice = state.reply?.voice
  const open = voice !== null && voice !== undefined && voice.open
  const boolean = liveField(settings, 'speakMilestones', 'boolean')
  return '<div class="dvr-switches">'
    + lampSwitch(state.audio.kind === 'live' ? 'disconnect' : 'connect', state.audio.kind === 'live', 'MIC', 'green')
    + lampSwitch(open ? 'voice-stop' : 'voice-start', open, 'VOICE', 'green')
    + (boolean === undefined ? '' : booleanSwitch(boolean))
    + '</div>'
}

/**
 * The tabs that switch between the two drill levels inside the panel.
 * @param level - the level showing.
 * @returns the tabs' markup.
 */
function tabsMarkup(level: StripLevel): string {
  const tab = (target: StripLevel, label: string): string =>
    `<button class="dvr-tab${level === target ? ' active' : ''}" data-action="level" data-level="${target}">${label}</button>`
  return `<div class="dvr-tabs">${tab('controls', 'CONTROLS')}${tab('all', 'ALL SETTINGS')}</div>`
}

/**
 * A list as a real editor: every entry visible, each removable, and one field to add.
 *
 * Not a comma-separated string in a text box — that is a serialisation format leaked into the UI, and one
 * stray space silently changes the value. The wire format is JSON and only JSON (a list of secrets cannot be
 * split on a comma), so the editor builds the array and sends it whole.
 *
 * When the plugin **does not report** the value — a write-only list — the note says so, because an editor
 * showing an empty list would otherwise read as "the list is empty" rather than "the list is not readable".
 * @param entry - the setting.
 * @param state - what the panel is showing, for the entries the editor has built.
 * @returns the editor's markup.
 */
function listEditor(entry: SettingLike, state: StripState): string {
  const key = escapeHtml(entry.key)
  const reported = asList(entry.value)
  const entries = reported ?? state.drafts[entry.key] ?? []
  const rows = entries.map((item, index) =>
    `<li class="dvr-entry"><span class="dvr-entry-value">${escapeHtml(item)}</span>`
    + `<button class="dvr-remove" data-action="list-remove" data-key="${key}"`
    + ` data-index="${String(index)}">✕</button></li>`,
  ).join('')
  return `<ul class="dvr-list">${rows}</ul>`
    + (reported === undefined
      ? '<em class="dvr-write-only">the plugin does not report this value — this list replaces whatever is set</em>'
      : '')
    + `<input class="dvr-input dvr-input--wide" data-input="${key}" value="">`
    + `<button class="dvr-btn" data-action="list-add" data-key="${key}">Add</button>`
}

/**
 * The control a live setting gets, which is decided by its kind rather than by its description.
 * @param entry - the setting.
 * @param state - what the panel is showing, for a list editor's own entries.
 * @returns the control's markup.
 */
function liveControl(entry: SettingLike, state: StripState): string {
  const key = escapeHtml(entry.key)
  if (entry.kind === 'boolean') return booleanSwitch(entry)
  if (entry.kind === 'string-list') return listEditor(entry, state)
  // The channel has a verb for exactly one purpose — steering at a session — and this is the field it means.
  // Everything else goes through `set <key>=<value>`.
  const action = entry.field === 'sessionId' && entry.kind === 'string' ? 'steer' : 'set'
  const control = entry.choices !== undefined && entry.choices.length > 0
    ? `<select class="dvr-select" data-input="${key}">${choiceOptions(entry, entry.choices)}</select>`
    : `<input class="dvr-input dvr-input--wide" data-input="${key}" value="${escapeHtml(show(entry.value))}">`
  return control + `<button class="dvr-btn" data-action="${action}" data-key="${key}">${action === 'steer' ? 'Steer' : 'Set'}</button>`
}

/**
 * One registry row, as the deepest drill level shows it: the key, what the owner says it does, and the
 * control its kind asks for.
 * @param entry - the setting.
 * @param state - what the panel is showing.
 * @returns the row's markup.
 */
function settingRow(entry: SettingLike, state: StripState): string {
  const key = escapeHtml(entry.key)
  const head = `<span class="dvr-skey">${key}</span>`
  const describe = entry.describe === undefined ? '' : `<span class="dvr-sdesc">${escapeHtml(entry.describe)}</span>`
  const noted = state.notes[entry.key]
  const note = noted === undefined ? '' : `<em class="dvr-note" data-note="${key}">${escapeHtml(noted)}</em>`
  if (entry.scope !== 'live') {
    // Session-bound: the change exists, it just costs a reconnect, and saying so is the gate's second class.
    return `<div class="dvr-srow" data-key="${key}" data-scope="session">${head}${describe}`
      + `<b>${escapeHtml(show(entry.value))}</b>`
      + '<em class="dvr-fixed">fixed when the session opens — reconnect to apply</em>'
      + note
      + '</div>'
  }
  return `<div class="dvr-srow" data-key="${key}" data-scope="live">${head}${describe}`
    + liveControl(entry, state) + note + '</div>'
}

/**
 * The raw registry rows.
 *
 * Developer detail the panel used to carry — the journal's size, the socket count, the last event name — is
 * **not** here. It belongs to `voice_journal` and `voice_diagnose`, which already expose it; a surface
 * carrying it reads as a log excerpt with buttons under it, which is what "maximally expanded with every
 * field visible" actually described. The test for what belongs: which of these would a reader *act* on?
 * @param state - what the panel is showing.
 * @param settings - every setting the status reported.
 * @returns the rows' markup.
 */
function rowsMarkup(state: StripState, settings: readonly SettingLike[]): string {
  // Restart-bound settings get no row at all. The control-plane gate says no affordance the protocol cannot
  // honour, and a row that cannot be changed is a row a reader will try to change.
  const rows = settings.filter(entry => entry.scope !== 'restart')
  if (rows.length === 0) return '<p class="dvr-empty">no settings to show</p>'
  return rows.map(entry => settingRow(entry, state)).join('')
}

/**
 * The panel: the drill-through's contents, one level at a time.
 *
 * The knobs and the raw rows are never on screen together. That is not layout taste — both name their inputs
 * by the setting's key, and two inputs under one name would make the panel read whichever came first in the
 * document, so a control would write a value nobody typed.
 * @param state - what the panel is showing.
 * @param settings - every setting the status reported.
 * @returns the panel's markup.
 */
function panelMarkup(state: StripState, settings: readonly SettingLike[]): string {
  const knobs = state.level === 'controls' ? knobsMarkup(settings) : ''
  return '<div class="dvr-panel">'
    + (knobs === '' ? '' : `<div class="dvr-knobs">${knobs}</div>`)
    + switchesMarkup(state, settings)
    + tabsMarkup(state.level)
    + (state.level === 'all' ? rowsMarkup(state, settings) : '')
    + '</div>'
}

/**
 * The 1U plate: state, not settings.
 * @param state - what the panel is showing.
 * @returns the deck's markup.
 */
function deckMarkup(state: StripState): string {
  const lamp = lampState(state)
  const collapsed = state.level === 'collapsed'
  const micOn = state.audio.kind === 'live'
  return '<div class="dvr-row">'
    + '<span class="dvr-screw"></span>'
    + '<span class="dvr-brand">'
    + `<b class="dvr-name">${STRIP_WORDMARK}</b><i class="dvr-model">${STRIP_MODEL}</i>`
    + '</span>'
    + '<span class="dvr-rule"></span>'
    + `<span class="dvr-jewel" data-lamp="${lamp}" title="session: ${lamp}">`
    + `<i class="dvr-lamp"></i><i class="dvr-jewel-label">${LAMP_WORDS[lamp]}</i></span>`
    + meterMarkup(state.audio)
    + `<span class="dvr-where">${escapeHtml(whereText(state.reply))}</span>`
    + '<span class="dvr-spacer"></span>'
    + `<button class="dvr-btn${micOn ? ' on' : ''}" data-action="${micOn ? 'disconnect' : 'connect'}">MIC</button>`
    + '<button class="dvr-btn" data-action="level"'
    + ` data-level="${collapsed ? 'controls' : 'collapsed'}">SETTINGS ${collapsed ? '⌃' : '⌄'}</button>`
    + '<span class="dvr-screw"></span>'
    + '</div>'
}

/**
 * The microphone's own failure, said in words rather than implied by a lamp.
 * @param audio - what the microphone is doing.
 * @returns the line's markup, empty when there is nothing wrong.
 */
function faultMarkup(audio: ClientAudioState): string {
  return audio.kind === 'failed' ? `<p class="dvr-fault">microphone: ${escapeHtml(audio.reason)}</p>` : ''
}

/**
 * The notice, and the page it points at when it points anywhere.
 * @param state - what the panel is showing.
 * @returns the line's markup, empty when there is nothing to say.
 */
function noticeMarkup(state: StripState): string {
  if (state.notice === '') return ''
  const link = state.noticeLink ?? ''
  const anchor = link === ''
    ? ''
    : ` <a href="${escapeHtml(link)}" target="_blank" rel="noreferrer noopener">open ↗</a>`
  return `<p class="dvr-notice" data-dsh-strip-notice>${escapeHtml(state.notice)}${anchor}</p>`
}

/**
 * Render the whole panel.
 *
 * A pure function of the state, because that is what makes the panel testable at all: the injected script
 * is three lines and the DOM is one assignment, so everything worth checking lives here.
 *
 * The order is the panel's own geometry: the drill-through grows **upward** from the plate, so it comes
 * first in the document and the deck stays pinned to the bottom of the page.
 * @param state - what the panel is showing.
 * @returns the markup for the panel's element.
 */
export function renderStrip(state: StripState): string {
  const settings = state.reply?.settings ?? []
  const parts: string[] = []
  if (state.level !== 'collapsed') parts.push(panelMarkup(state, settings))
  parts.push(deckMarkup(state))
  const fault = faultMarkup(state.audio)
  if (fault !== '') parts.push(fault)
  const notice = noticeMarkup(state)
  if (notice !== '') parts.push(notice)
  return parts.join('')
}

/**
 * A picker's options, with the value in force always among them.
 * @param entry - the setting, for its value.
 * @param candidates - the values it declared. Passed in rather than read here: this is only ever called
 *   for a setting that has a non-empty list, and a fallback for the case that cannot happen is a branch
 *   the coverage gate rightly flags as dead.
 * @returns the markup for each option.
 */
function choiceOptions(entry: SettingLike, candidates: readonly string[]): string {
  const current = show(entry.value)
  // A value that is not among the candidates is offered anyway. A select that silently showed the first
  // candidate instead of the value actually in force would be lying about the state, which is the one
  // thing a control plane must not do.
  const all = candidates.includes(current) ? candidates : [current, ...candidates]
  return all.map(choice =>
    `<option value="${escapeHtml(choice)}"${choice === current ? ' selected' : ''}>${escapeHtml(choice)}</option>`,
  ).join('')
}

/**
 * Read a click's level, refusing anything that is not one.
 * @param raw - the `data-level` the button carried.
 * @returns the level it names.
 */
function asLevel(raw: string | undefined): StripLevel {
  if (raw === 'controls' || raw === 'all') return raw
  return 'collapsed'
}

/**
 * Mount the panel on its element.
 *
 * Reads `status` once, then renders — and renders again after every action, because a control that
 * reported an outcome without showing the state it produced would leave the reader unsure which of the two
 * they are looking at.
 * @param deps - the element, the transport and the microphone's own controls.
 * @returns the panel's handle.
 */
export function mountStrip(deps: StripDeps): Strip {
  let reply: ControlReplyLike | null = null
  const notes: Record<string, string> = {}
  const drafts: Record<string, readonly string[]> = {}
  let notice = ''
  /** The page the current notice points at, or empty. Set only where a refusal carried one. */
  let noticeLink = ''
  let level: StripLevel = 'collapsed'
  let connecting = false

  const settings = (): readonly SettingLike[] => reply?.settings ?? []

  const paint = (): void => {
    deps.root.innerHTML = renderStrip({
      reply, notes, drafts, notice, noticeLink, audio: deps.audio(), level, connecting,
    })
  }

  const refresh = async (): Promise<void> => {
    try {
      reply = await deps.request('status')
    } catch (error) {
      // Nothing was sent, or nothing came back: the panel says which, rather than showing a stale state as
      // if it were current.
      notice = error instanceof Error ? error.message : String(error)
    }
    paint()
  }

  /** One list as the editor holds it: what the plugin reported, else what the editor has built. */
  const listAt = (key: string): readonly string[] =>
    asList(settings().find(entry => entry.key === key)?.value) ?? drafts[key] ?? []

  /**
   * Send one intent and report what came back, then re-render.
   *
   * An intent can be more than one frame: the wait control writes two budgets, and the pair is reported as
   * a pair. The first refusal stops the sequence — a half-applied pair is a state to *see*, not one to keep
   * writing past.
   * @param frames - the control frames, in order.
   * @param fieldKey - the setting the change was about, when it was about one.
   * @param done - what to say when every frame was applied.
   * @returns the refusal it stopped on, or `undefined` when every frame was applied. Returned rather than
   *   only recorded because one caller — the wait pair — has something better to say than "applied", and a
   *   line written from a re-read must not overwrite a refusal.
   */
  const send = async (
    frames: readonly string[],
    fieldKey: string | undefined,
    done: string,
  ): Promise<string | undefined> => {
    let refusal: string | undefined
    try {
      for (const frame of frames) {
        const answer = await deps.request(frame)
        if (!answer.ok) {
          // A refusal carries the reason written to be relayed verbatim, so it is relayed rather than
          // translated — including for a field frozen by its class. A **session** refusal nests its own
          // classified code, remedy and page and leaves the control-level `reason` unset, so reading only
          // that answered the failure a user is most likely to meet with "refused: no reason given" — a
          // panel saying nothing at the exact moment it knows what to do.
          refusal = answer.refusal === undefined
            ? `${answer.code ?? 'refused'}: ${answer.reason ?? 'no reason given'}`
            : `${answer.refusal.code ?? answer.refusal.class ?? 'refused'}: ${answer.refusal.remedy ?? 'no reason given'}`
          noticeLink = answer.refusal?.link ?? ''
          break
        }
        noticeLink = ''
      }
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    const line = refusal ?? done
    if (fieldKey === undefined) notice = line
    else notes[fieldKey] = line
    await refresh()
    return refusal
  }

  const onClick = (event: StripEvent): void => {
    const action = event.target?.dataset?.action
    if (action === undefined) return
    const key = event.target?.dataset?.key
    const value = event.target?.dataset?.value
      ?? (key === undefined ? undefined : deps.root.querySelector(`[data-input="${key}"]`)?.value)
    const act = async (): Promise<void> => {
      // Cleared per action: a notice from the last one is about the last one, and leaving it up would make
      // a successful reconnect read as a failed one.
      notice = ''
      noticeLink = ''
      switch (action) {
        case 'level': level = asLevel(event.target?.dataset?.level); paint(); return
        case 'refresh': await refresh(); return
        case 'disconnect': deps.disconnect(); await refresh(); return
        case 'connect': {
          // The lamp goes amber for the length of the connect, which is the only thing on this plate that
          // moves without the status having moved.
          connecting = true
          paint()
          const reached = await deps.connect()
          connecting = false
          if (reached.kind === 'failed') notice = reached.reason
          await refresh()
          return
        }
        case 'voice-start': await send(['start'], undefined, 'voice started'); return
        case 'voice-stop': await send(['stop'], undefined, 'voice stopped'); return
        case 'toggle': await send([`set ${key ?? ''}=${value ?? ''}`], key, `${value ?? ''}`); return
        case 'wait': {
          const keys = waitKeys(settings())
          if (keys.length === 0) return
          const stopped = await send(keys.map(name => `set ${name}=${value ?? ''}`), keys[0]!, 'applied')
          // The note is what the registry now says, not what was asked for: a setter may clamp, and a pair
          // that half-applied has to be visible as a pair. Only when the write went through, because a
          // refusal is a better answer than any value.
          if (stopped === undefined) {
            notes[keys[0]!] = waitSummary(settings())
            paint()
          }
          return
        }
        case 'list-add': {
          if (key === undefined) return
          const next = [...listAt(key), value ?? '']
          drafts[key] = next
          await send([`set ${key}=${JSON.stringify(next)}`], key, `${String(next.length)} in the list`)
          return
        }
        case 'list-remove': {
          if (key === undefined) return
          // A click that named no index is a click from something the panel did not render. It removes
          // nothing rather than defaulting to the first entry, which is what `Number(undefined)` would do.
          const index = event.target?.dataset?.index
          const next = listAt(key).filter((_item, at) => at !== (index === undefined ? -1 : Number(index)))
          drafts[key] = next
          await send([`set ${key}=${JSON.stringify(next)}`], key, `${String(next.length)} in the list`)
          return
        }
        case 'steer': await send([`steer ${value ?? ''}`], key, 'steered'); return
        case 'set': await send([`set ${key ?? ''}=${value ?? ''}`], key, 'applied')
      }
    }
    void act()
  }

  deps.root.addEventListener('click', onClick)

  return {
    refresh,
    state: () => ({ reply, notes, drafts, notice, noticeLink, audio: deps.audio(), level, connecting }),
  }
}

/**
 * The client plugin. Publishes the client and the strip on a global, and releases them with the plugin.
 *
 * `inject` is empty on purpose: nothing here needs another plugin, and a client face that needs nothing
 * cannot be broken by another plugin's absence.
 *
 * The global is **no longer the on-switch**. S2 story 3 put a panel in the app, and the panel's buttons
 * are how anyone starts a microphone; the global is now the seam between the injected markup and this
 * bundle, which is a different thing from a user interface that only exists in a devtools console.
 *
 * @param ctx - the client context, used only to own the lifetime.
 */
export function apply(ctx: ClientContextLike): void {
  const client = createAudioClient(defaultDeps())
  let mounted = false

  /**
   * Render the panel into the element the injected markup provides.
   *
   * Called twice on purpose — once here, and once by the injected bootstrap script — because the two
   * orders are both possible: this bundle is materialised by the module table, and the markup arrives with
   * the body rows. Whichever runs second finds the panel already there and does nothing.
   */
  const mount = (): void => {
    if (mounted) return
    const root = stripRoot(globalThis as unknown as StripScope)
    if (root === null) return
    mounted = true
    const strip = mountStrip({
      root,
      request: (frame) => client.request(frame),
      connect: () => client.start(),
      disconnect: () => { client.stop() },
      audio: () => client.state(),
    })
    void strip.refresh()
  }

  ;(globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY] = {
    start: () => client.start(),
    stop: () => { client.stop() },
    state: () => client.state(),
    request: (frame: string) => client.request(frame),
    mount,
  }
  mount()
  // A held microphone and a live audio graph must not outlive the plugin that opened them.
  ctx.effect(() => () => { client.stop() }, 'realtime-audio-client')
}
