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
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): void
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

/** Normalise a binary payload to a plain byte view of exactly its bytes. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  const view = data as Uint8Array
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

/**
 * Bind a socket to the handlers that consume it.
 *
 * A frame that is not JSON is reported as a transport error rather than dropped: a provider that starts sending
 * something else is a fact the session needs to know, and silence is how that becomes a mystery.
 */
export function openTransport(socket: SocketLike, handlers: TransportHandlers): DeepgramTransport {
  let closed = false
  // A real WebSocket is not open when it is constructed, and `send` on a connecting socket **throws**. The session
  // sends `Settings` immediately, so without this buffer the very first frame fails against the real provider —
  // which is exactly what the live smoke found (readyState 0) after 86 unit tests passed, because the fake socket
  // accepted writes whenever it was asked. Frames are held in order and flushed on `open`.
  let open = false
  const buffered: (string | Uint8Array)[] = []
  const write = (data: string | Uint8Array): void => {
    if (!open) { buffered.push(data); return }
    socket.send(data)
  }
  const parse = (text: string): void => {
    try {
      handlers.onFrame(JSON.parse(text) as ServerFrame)
    } catch {
      handlers.onError(new Error('received a frame that was not JSON'))
    }
  }
  socket.on('open', ((..._args: never[]) => {
    open = true
    // `splice` drains the queue in place, so order is preserved and nothing is sent twice.
    for (const data of buffered.splice(0)) socket.send(data)
  }) as (...args: never[]) => void)
  socket.on('message', ((data: unknown, isBinary?: unknown) => {
    // The `ws` socket delivers a **text** frame as a Buffer, and a Buffer is a Uint8Array — so sniffing the type
    // classifies every server frame as audio and parses nothing. Found by the live smoke, which timed out waiting
    // for `SettingsApplied` while the frames were arriving all along. The `isBinary` flag is the authority; the
    // type is only a fallback for sockets that do not pass one.
    const binary = isBinary === true
    if (binary) {
      handlers.onAudio(toBytes(data))
      return
    }
    if (typeof data === 'string') {
      parse(data)
      return
    }
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      // A text frame as bytes: decode it rather than treating it as samples.
      parse(new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data))
      return
    }
    handlers.onError(new Error('received a frame that was neither text nor bytes'))
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
      write(JSON.stringify(frame))
    },
    sendAudio(pcm16) {
      if (closed) throw new Error('the transport is closed')
      write(pcm16)
    },
    async close() {
      if (closed) return
      closed = true
      socket.close()
    },
  }
}
