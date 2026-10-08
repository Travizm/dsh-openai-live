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

  client.on('message', (data, isBinary) => {
    // A text frame is not part of this contract. Ignoring one is cheaper than closing the connection and
    // no less correct: nothing on this wire is JSON.
    if (!isBinary) return
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
