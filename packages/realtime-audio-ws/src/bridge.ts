/**
 * One socket's bridge to the agent's audio events — the whole of this package's logic.
 *
 * Both impure edges arrive as arguments, so every path is testable with plain fakes: no socket, no
 * context, no web server, no credential, no spend.
 */

import type { AudioSocket } from './types.ts'

export interface AudioSocketBridgeDeps {
  /** Emit one captured frame as host-side microphone audio. */
  readonly emitMic: (pcm16: Uint8Array) => void
  /** Subscribe to host-side output audio. Returns the unsubscriber. */
  readonly subscribeAudio: (listener: (pcm16: Uint8Array) => void) => () => void
  /** Longest inbound frame accepted, in bytes. */
  readonly maxFrameBytes: number
  /**
   * Handle one **control frame** — a text frame on this socket.
   *
   * Until S2 story 2 a text frame was not part of this contract, and the comment that said so was right
   * about the wire as it was: the socket carried PCM16 in both directions and nothing else. It now
   * carries a channel too, because it is the only duplex connection the client already holds, and one
   * text frame in / one text frame out is a smaller contract than a second route with its own
   * authentication would have been.
   *
   * `reply` writes exactly one text frame back, and silently drops it once the socket is gone: a control
   * handler is asynchronous, and a reply to a closed socket would throw from inside a promise nobody
   * awaits.
   */
  readonly onControl: (frame: string, reply: (text: string) => void) => void
  /** Called exactly once when the bridge stops, however it stops. */
  readonly onDetach: () => void
}

/**
 * Normalise a `ws` message payload to bytes.
 *
 * `ws` delivers `RawData`, which is a Buffer, an ArrayBuffer **or a Buffer[]** depending on how the frame
 * was fragmented. Assuming the first case is the classic way to get an audio pipeline that works on small
 * frames and corrupts on large ones.
 *
 * @param data - the payload as `ws` delivered it.
 * @returns the payload as bytes.
 */
export function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as readonly Uint8Array[]))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(Buffer.from(data as ArrayBufferLike))
}

/**
 * Normalise a `ws` message payload to text.
 *
 * The same three shapes {@link toBytes} handles, decoded as UTF-8 — a control frame arrives as a Buffer
 * whichever way it was framed, and a fragmented one as an array of them.
 *
 * @param data - the payload as `ws` delivered it.
 * @returns the payload as text.
 */
export function toText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data as readonly Uint8Array[]).toString('utf8')
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return Buffer.from(data as ArrayBufferLike).toString('utf8')
}

/**
 * Wire one accepted socket to the agent's audio events.
 *
 * @param client - the connected socket.
 * @param deps - the two bus edges, the frame bound and the detach hook.
 * @returns a disposer that stops the bridge and terminates the socket.
 */
export function attachAudioSocket(client: AudioSocket, deps: AudioSocketBridgeDeps): () => void {
  let stopped = false

  const unsubscribe = deps.subscribeAudio((pcm16) => {
    // A frame arriving after the socket went away is dropped, not queued — the same rule the audio event
    // itself carries, and the reason a client that cannot keep up degrades instead of accumulating.
    if (stopped) return
    client.send(pcm16)
  })

  const stop = (): void => {
    // `close` and `error` both arrive on a failing socket, and the disposer can follow either, so this is
    // the once-only guard rather than a redundant check.
    if (stopped) return
    stopped = true
    unsubscribe()
    deps.onDetach()
  }

  /**
   * Answer one control frame, if the socket is still there.
   *
   * The guard is here rather than at the call site because this is the only place that knows whether the
   * bridge is still live, and because a control handler settles asynchronously: a reply that arrives after
   * the socket went away must be dropped, not thrown.
   *
   * **Total**, including the write: a socket can die between the check above and the send, and a throw here
   * would escape into a promise nobody awaits — and, in the plugin, would break the reply queue for every
   * frame behind it.
   * @param text - the reply frame.
   */
  const reply = (text: string): void => {
    if (stopped) return
    try {
      client.send(text)
    } catch {
      stop()
    }
  }

  client.on('message', (data, isBinary) => {
    // A **text** frame is a control frame. This is the deliberate widening of the contract that used to
    // say the opposite: the socket is the one duplex connection the client already holds, and a control
    // plane that needs a second route with a second authentication is a control plane nobody builds.
    // Checked before the audio path, because a text frame is never audio whatever it contains.
    if (!isBinary) {
      deps.onControl(toText(data), reply)
      return
    }
    const pcm16 = toBytes(data)
    if (pcm16.byteLength > deps.maxFrameBytes) {
      // 1009 = message too big. `ws` enforces its own `maxPayload` first, so reaching this means the bound
      // was configured tighter than the handshake's — which is worth closing for rather than truncating.
      stop()
      client.close(1009, 'frame too large')
      return
    }
    deps.emitMic(pcm16)
  })
  client.on('close', stop)
  client.on('error', stop)

  return () => {
    stop()
    client.terminate()
  }
}
