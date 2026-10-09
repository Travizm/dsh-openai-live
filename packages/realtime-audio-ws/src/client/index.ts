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
  readonly target: { readonly dataset?: Record<string, string | undefined>; readonly value?: string } | null
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
  /** What the microphone is doing. */
  readonly audio: ClientAudioState
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
 * Render the whole panel.
 *
 * A pure function of the state, because that is what makes the panel testable at all: the injected script
 * is three lines and the DOM is one assignment, so everything worth checking lives here.
 * @param state - what the panel is showing.
 * @returns the markup for the panel's element.
 */
export function renderStrip(state: StripState): string {
  const reply = state.reply
  const lines = [`<p data-dsh-strip-voice>${escapeHtml(summariseVoice(reply, state.audio))}</p>`]
  if (reply !== null) lines.push(`<p data-dsh-strip-route>${escapeHtml(summariseRoute(reply))}</p>`)
  if (state.notice !== '') lines.push(`<p data-dsh-strip-notice>${escapeHtml(state.notice)}</p>`)
  lines.push(`<p data-dsh-strip-buttons>${buttons(state.audio)}</p>`)
  // Restart-bound settings are omitted rather than shown read-only: the gate says no control at all, and a
  // row that cannot be changed is a row a reader will try to change.
  const settings = (reply?.settings ?? []).filter(entry => entry.scope !== 'restart')
  lines.push(settings.length === 0
    ? '<p data-dsh-strip-empty>no settings to show</p>'
    : `<ul>${settings.map(entry => settingRow(entry, state.notes)).join('')}</ul>`)
  return lines.join('')
}

/**
 * The voice line: whether a session is live, and what it is.
 * @param reply - the last status, if any.
 * @param audio - what the microphone is doing.
 * @returns one line of plain text.
 */
function summariseVoice(reply: ControlReplyLike | null, audio: ClientAudioState): string {
  const microphone = audio.kind === 'failed' ? `microphone: failed — ${audio.reason}` : `microphone: ${audio.kind}`
  if (reply === null) return `no answer yet · ${microphone}`
  const voice = reply.voice
  // `null` is "nobody answered the question", which is a composition without an agent row — deliberately
  // not the same statement as a session that is merely closed.
  if (voice === null || voice === undefined) return `voice: no agent is mounted in this profile · ${microphone}`
  const where = voice.provider === undefined ? '' : ` · ${voice.provider}/${voice.model ?? '?'}`
  const which = voice.sessionId === undefined ? '' : ` · ${voice.sessionId}`
  return `voice: ${voice.open ? 'open' : 'closed'}${where}${which} · ${microphone}`
}

/**
 * The route line: what this socket is, and the last thing the journal recorded.
 * @param reply - the last status.
 * @returns one line of plain text.
 */
function summariseRoute(reply: ControlReplyLike): string {
  const last = reply.journal?.last?.kind
  return [
    reply.audio?.path ?? 'the audio route',
    `${String(reply.audio?.clients ?? 0)} socket(s)`,
    `journal ${String(reply.journal?.size ?? 0)}`,
    ...last === undefined ? [] : [`last ${last}`],
  ].join(' · ')
}

/**
 * The buttons above the settings.
 *
 * The microphone's own button is the on-switch this sprint exists to provide: what used to be a
 * `globalThis` call in a devtools console is now the first control in the panel.
 * @param audio - what the microphone is doing.
 * @returns the markup.
 */
function buttons(audio: ClientAudioState): string {
  const live = audio.kind === 'live'
  return [
    `<button data-action="${live ? 'disconnect' : 'connect'}">${live ? 'Disconnect microphone' : 'Connect microphone'}</button>`,
    '<button data-action="voice-start">Start voice</button>',
    '<button data-action="voice-stop">Stop voice</button>',
    '<button data-action="refresh">Refresh</button>',
  ].join(' ')
}

/**
 * One setting's row.
 *
 * Three classes, three treatments, and the gate's rule is the reason: a live field gets a control, a
 * session-bound field says what it would take to change it, and a restart-bound field is not rendered.
 * @param entry - the setting as `status` reported it.
 * @param notes - what the last change to each setting produced.
 * @returns the markup for one row.
 */
function settingRow(entry: SettingLike, notes: Readonly<Record<string, string>>): string {
  const key = escapeHtml(entry.key)
  const label = `<span data-dsh-strip-label>${escapeHtml(entry.describe ?? entry.field)}</span>`
  const note = notes[entry.key] === undefined
    ? ''
    : `<em data-note="${key}">${escapeHtml(notes[entry.key]!)}</em>`
  if (entry.scope !== 'live') {
    return `<li data-key="${key}" data-scope="session">${label}<b>${escapeHtml(show(entry.value))}</b>`
      + `<em>fixed when the session opens — reconnect to apply</em>${note}</li>`
  }
  // The channel has a verb for exactly one purpose — steering at a session — and this is the field it
  // means. Everything else goes through `set <key>=<value>`.
  const action = entry.field === 'sessionId' && entry.kind === 'string' ? 'steer' : 'set'
  const control = entry.choices !== undefined && entry.choices.length > 0
    ? `<select data-input="${key}">${choiceOptions(entry, entry.choices)}</select>`
    : `<input data-input="${key}" value="${escapeHtml(show(entry.value))}">`
  const name = action === 'steer' ? 'Steer' : 'Set'
  return `<li data-key="${key}" data-scope="live">${label}${control}`
    + `<button data-action="${action}" data-key="${key}">${name}</button>${note}</li>`
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
  let notice = ''

  const paint = (): void => {
    deps.root.innerHTML = renderStrip({ reply, notes, notice, audio: deps.audio() })
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

  /**
   * Send one frame and report what came back, then re-render.
   * @param frame - the control frame.
   * @param fieldKey - the setting the change was about, when it was about one.
   * @param done - what to say when it worked.
   */
  const send = async (frame: string, fieldKey: string | undefined, done: string): Promise<void> => {
    let line: string
    try {
      const answer = await deps.request(frame)
      // A refusal carries the reason written to be relayed verbatim, so it is relayed rather than
      // translated — including for a field frozen by its class.
      line = answer.ok ? done : `${answer.code ?? 'refused'}: ${answer.reason ?? 'no reason given'}`
    } catch (error) {
      line = error instanceof Error ? error.message : String(error)
    }
    if (fieldKey === undefined) notice = line
    else notes[fieldKey] = line
    await refresh()
  }

  const onClick = (event: StripEvent): void => {
    const action = event.target?.dataset?.action
    if (action === undefined) return
    const key = event.target?.dataset?.key
    const value = key === undefined ? undefined : deps.root.querySelector(`[data-input="${key}"]`)?.value
    const act = async (): Promise<void> => {
      // Cleared per action: a notice from the last one is about the last one, and leaving it up would make
      // a successful reconnect read as a failed one.
      notice = ''
      switch (action) {
        case 'refresh': await refresh(); return
        case 'disconnect': deps.disconnect(); await refresh(); return
        case 'connect': {
          const reached = await deps.connect()
          if (reached.kind === 'failed') notice = reached.reason
          await refresh()
          return
        }
        case 'voice-start': await send('start', undefined, 'voice started'); return
        case 'voice-stop': await send('stop', undefined, 'voice stopped'); return
        case 'steer': await send(`steer ${value ?? ''}`, key, 'steered'); return
        case 'set': await send(`set ${key ?? ''}=${value ?? ''}`, key, 'applied')
      }
    }
    void act()
  }

  deps.root.addEventListener('click', onClick)

  return { refresh, state: () => ({ reply, notes, notice, audio: deps.audio() }) }
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
