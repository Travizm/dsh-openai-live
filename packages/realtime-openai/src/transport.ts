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
    return await new Promise<RealtimeTransport>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { ...headers } })
      let opened = false

      socket.on('open', () => {
        opened = true
        resolve({
          send: (frame: string) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(frame)
          },
          close: () => {
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
          },
        })
      })

      socket.on('message', (data: WebSocket.RawData) => {
        handlers.onMessage(typeof data === 'string' ? data : data.toString())
      })

      socket.on('close', (code: number, reason: Buffer) => {
        handlers.onClose(code, reason.toString())
      })

      socket.on('error', (error: Error) => {
        if (opened) handlers.onError(error)
        else reject(error)
      })
    })
  }
}
