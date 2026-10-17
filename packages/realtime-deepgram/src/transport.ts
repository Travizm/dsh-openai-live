/**
 * The transport: one WebSocket, typed at both ends.
 *
 * The socket is **injected** rather than constructed here. That is not indirection for its own sake — it is what
 * lets the framing be tested without a network, and it keeps `ws` (a dependency of the plugin) out of the
 * translation and session layers, which are the parts most likely to be reused.
 *
 * Binary vs text matters on this wire and is handled in one place: a string frame is JSON and is routed as a
 * provider event, a binary frame is linear16 audio and is routed as samples. A transport that guessed would put
 * audio bytes into a JSON parser, and the resulting error would look like a protocol failure.
 *
 * @module dsh-realtime-deepgram/transport
 */
import type { ClientFrame, ServerFrame } from './wire.ts'

/** The socket surface this module needs — structurally the browser `WebSocket` and `ws`. */
export interface SocketLike {
  /** Send a text or binary frame. */
  send(data: string | Uint8Array): void
  /** Close the connection. */
  close(): void
  /** Subscribe to transport events. `message` carries either a string or bytes. */
  on(event: 'message' | 'close' | 'error', listener: (...args: never[]) => void): void
}

/** What the transport reports upward. */
export interface TransportHandlers {
  /** A parsed provider frame. */
  readonly onFrame: (frame: ServerFrame) => void
  /** Raw output audio. */
  readonly onAudio: (pcm16: Uint8Array) => void
  /** The socket closed, cleanly or not. */
  readonly onClose: (reason?: string) => void
  /** The transport failed. */
  readonly onError: (error: Error) => void
}

/** What a session sends through. */
export interface DeepgramTransport {
  /** Send one client frame. */
  send(frame: ClientFrame): void
  /** Send one frame of microphone audio. */
  sendAudio(pcm16: Uint8Array): void
  /** Close the socket. Idempotent. */
  close(): Promise<void>
}

/** Whether a received payload is audio rather than JSON. */
function isBinary(data: unknown): data is Uint8Array {
  return data instanceof Uint8Array || ArrayBuffer.isView(data)
}

/**
 * Bind a socket to the handlers that consume it.
 *
 * A frame that is not JSON is reported as a transport error rather than dropped: a provider that starts sending
 * something else is a fact the session needs to know, and silence is how that becomes a mystery.
 */
export function openTransport(socket: SocketLike, handlers: TransportHandlers): DeepgramTransport {
  let closed = false
  socket.on('message', ((data: unknown) => {
    if (isBinary(data)) {
      handlers.onAudio(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      return
    }
    if (typeof data !== 'string') {
      handlers.onError(new Error('received a frame that was neither text nor bytes'))
      return
    }
    try {
      handlers.onFrame(JSON.parse(data) as ServerFrame)
    } catch {
      handlers.onError(new Error('received a frame that was not JSON'))
    }
  }) as (...args: never[]) => void)
  socket.on('close', ((...args: unknown[]) => {
    closed = true
    const first = args[0]
    handlers.onClose(typeof first === 'string' && first.length > 0 ? first : undefined)
  }) as (...args: never[]) => void)
  socket.on('error', ((error: unknown) => {
    handlers.onError(error instanceof Error ? error : new Error(String(error)))
  }) as (...args: never[]) => void)
  return {
    send(frame) {
      if (closed) throw new Error('the transport is closed')
      socket.send(JSON.stringify(frame))
    },
    sendAudio(pcm16) {
      if (closed) throw new Error('the transport is closed')
      socket.send(pcm16)
    },
    async close() {
      if (closed) return
      closed = true
      socket.close()
    },
  }
}
