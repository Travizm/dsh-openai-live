/**
 * The upgrade handshake: refusal, and `ws` acceptance.
 *
 * Kept apart from the plugin so both halves are testable against a real socket without a Cordis context.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { AudioSocket } from './types.ts'

/**
 * Refuse an upgrade **without transferring socket ownership to `ws`**.
 *
 * Deliberately the same bytes DSH's own transport writes for the same refusal, so a client cannot tell
 * this route's rejection from the gateway's.
 *
 * @param socket - carrier socket that receives the HTTP rejection.
 * @param status - the rejection the connection service reported.
 */
export function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

/** What the route handler needs, so the plugin owns no handshake detail of its own. */
export interface UpgradeAcceptor {
  /** Complete the handshake for one dispatched request and hand back the connected socket. */
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    onConnection: (client: AudioSocket) => void,
  ): void
  /** Release the `ws` server. Resolves once it has no clients left. */
  close(): Promise<void>
}

/**
 * The real acceptor: a `ws` server with no listener of its own, driven entirely by the web server's
 * upgrade dispatch, which is why `noServer` is the only correct mode here — a listening `ws` server would
 * bind a second port and bypass the route registry that makes this plugin lawful.
 *
 * @param maxPayload - largest inbound frame `ws` will assemble before closing with 1009.
 */
export function createUpgradeAcceptor(maxPayload: number): UpgradeAcceptor {
  const server = new WebSocketServer({ noServer: true, maxPayload })
  return {
    handleUpgrade(req, socket, head, onConnection) {
      server.handleUpgrade(req, socket, head, (client) => {
        // `ws` satisfies the structural `AudioSocket` at runtime; the cast keeps this package free of the
        // library's type surface, which the tests would otherwise have to fabricate.
        onConnection(client as unknown as AudioSocket)
      })
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    }),
  }
}
