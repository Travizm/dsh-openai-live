/**
 * The one place a real socket is opened.
 *
 * Kept out of the adapter so that everything above it — transport framing, session, adapter establishment — can
 * be exercised against a fake with no key and no network. This function is the only code in the package that
 * touches the network, which makes "what talks to the internet" a one-line question to answer.
 *
 * @module dsh-realtime-deepgram/ws
 */
import WebSocket from 'ws'
import type { SocketLike } from './transport.ts'

/**
 * Open a WebSocket.
 * @param url - the agent endpoint.
 * @param headers - upgrade headers, including the `Token` credential.
 * @returns a socket the transport can bind to.
 */
export function openWebSocket(url: string, headers: Readonly<Record<string, string>>): SocketLike {
  // The provider authenticates on the upgrade with `Authorization: Token <key>` — the scheme is the vendor's,
  // not `Bearer`, and getting it wrong is a 401 that looks like a bad key.
  return new WebSocket(url, { headers: { ...headers } }) as unknown as SocketLike
}
