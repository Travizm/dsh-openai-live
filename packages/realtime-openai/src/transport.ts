/**
 * The `ws`-backed transport.
 *
 * Node's built-in `WebSocket` cannot set request headers, and this protocol authenticates with an
 * `Authorization` header — so the adapter needs a client library, and this module is the only place
 * that knows which one. Everything above it talks to {@link RealtimeTransport}.
 *
 * @module dsh-realtime-openai/transport
 */

import WebSocket from 'ws'
import type { RealtimeTransport, RealtimeTransportFactory, RealtimeTransportHandlers } from './types.ts'

/** Opens `ws` sockets as seam transports. */
export class WsTransportFactory implements RealtimeTransportFactory {
  /**
   * Connect and resolve once the socket is open.
   *
   * A failure **before** open rejects the returned promise, so a caller never receives a transport
   * that cannot carry frames. A failure **after** open is delivered to `handlers.onError`: by then
   * the caller owns a session, and rejecting a settled promise would lose the event.
   * @param url - absolute endpoint.
   * @param headers - request headers, including authorization.
   * @param handlers - frame and lifecycle callbacks.
   * @returns the open transport.
   */
  async connect(
    url: string,
    headers: Readonly<Record<string, string>>,
    handlers: RealtimeTransportHandlers,
  ): Promise<RealtimeTransport> {
    const settle = Promise.withResolvers<RealtimeTransport>()
    const socket = new WebSocket(url, { headers: { ...headers } })

    socket.on('open', () => {
      settle.resolve({
        // A send on a socket that is no longer open is a no-op rather than a throw: the transport
        // cannot know whether the session has noticed the close yet, and throwing here would surface
        // as a session bug instead of as a transport event.
        send: (frame: string) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(frame)
        },
        // Only an open socket is closable through this API. The factory hands out a transport only
        // after open and rejects otherwise, so no caller can ever hold a connecting one.
        close: () => {
          if (socket.readyState === WebSocket.OPEN) socket.close()
        },
      })
    })

    socket.on('message', (data: WebSocket.RawData) => {
      handlers.onMessage(typeof data === 'string' ? data : data.toString())
    })

    socket.on('close', (code: number, reason: Buffer) => {
      handlers.onClose(code, reason.toString())
    })

    // One path, not two: always report to the handlers, always reject the pending connect.
    // Rejecting an already-settled promise is a no-op, so a failure after open is reported exactly
    // once — to the handlers — and a failure before open also reaches the caller as a rejection.
    socket.on('error', (error: Error) => {
      settle.reject(error)
      handlers.onError(error)
    })

    return await settle.promise
  }
}
