import { Buffer } from 'node:buffer'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { WsTransportFactory } from '../src/transport.ts'
import type { RealtimeTransportHandlers } from '../src/types.ts'

/**
 * The `ws` transport, exercised against a **local** WebSocket server.
 *
 * Nothing leaves the machine and no credential is involved, so this is a real integration test rather
 * than a mock: it is the only place the socket library is actually proven to work, and the only test
 * that would catch a `ws` API change.
 */
const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(server => new Promise<void>(resolve => {
    for (const client of server.clients) client.terminate()
    server.close(() => resolve())
  })))
})

/**
 * Poll until `check` stops throwing.
 *
 * Local rather than `vi.waitFor` so the file has one import of vitest and no ordering trap: an
 * `import` at the bottom of a module is hoisted, so a second `vi` binding would be a duplicate.
 */
async function waitFor(check: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Start a local server and return its URL. */
async function serve(onConnection: (socket: ServerSocket, authorization: string | undefined) => void): Promise<string> {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  server.on('connection', (socket, request) => {
    onConnection(socket, request.headers.authorization)
  })
  await new Promise<void>(resolve => server.once('listening', resolve))
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** Collect every handler invocation so a test can assert what the transport reported. */
function collector() {
  const messages: string[] = []
  const closes: Array<{ code: number; reason: string }> = []
  const errors: Error[] = []
  const handlers: RealtimeTransportHandlers = {
    onMessage: frame => messages.push(frame),
    onClose: (code, reason) => closes.push({ code, reason }),
    onError: error => errors.push(error),
  }
  return { handlers, messages, closes, errors }
}

describe('WsTransportFactory', () => {
  it('connects, forwards the authorization header, and carries frames both ways', async () => {
    let seenHeader: string | undefined
    let connected = false
    const url = await serve((socket, authorization) => {
      connected = true
      seenHeader = authorization
      socket.on('message', (data: Buffer) => socket.send(`echo:${data.toString()}`))
    })
    const { handlers, messages } = collector()

    const transport = await new WsTransportFactory().connect(url, { Authorization: 'Bearer test-value' }, handlers)
    expect(connected).toBe(true)
    expect(seenHeader).toBe('Bearer test-value')

    transport.send('hello')
    await waitFor(() => expect(messages).toEqual(['echo:hello']))
    transport.close()
  })

  it('reports a server-initiated close with its code and reason', async () => {
    const url = await serve(socket => { socket.close(1000, 'done here') })
    const { handlers, closes } = collector()
    const transport = await new WsTransportFactory().connect(url, {}, handlers)
    await waitFor(() => expect(closes).toHaveLength(1))
    expect(closes[0]).toEqual({ code: 1000, reason: 'done here' })
    transport.close()
  })

  it('decodes a binary frame to text rather than dropping it', async () => {
    const url = await serve(socket => { socket.send(Buffer.from('binary-frame')) })
    const { handlers, messages } = collector()
    const transport = await new WsTransportFactory().connect(url, {}, handlers)
    await waitFor(() => expect(messages).toEqual(['binary-frame']))
    transport.close()
  })

  it('refuses a connection nothing is listening on, and reports it once', async () => {
    // Bind then release a port, so the address is known to be free rather than assumed.
    const probe = new WebSocketServer({ port: 0 })
    await new Promise<void>(resolve => probe.once('listening', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>(resolve => probe.close(() => resolve()))

    const { handlers, errors } = collector()
    await expect(new WsTransportFactory().connect(`ws://127.0.0.1:${port}`, {}, handlers))
      .rejects.toBeInstanceOf(Error)
    // One path, not two: a caller cannot be told about the same failure twice.
    expect(errors).toHaveLength(1)
  })

  it('treats a send or close after the peer has gone as a no-op', async () => {
    const url = await serve(socket => { socket.close(1000, 'bye') })
    const { handlers, closes } = collector()
    const transport = await new WsTransportFactory().connect(url, {}, handlers)
    await waitFor(() => expect(closes).toHaveLength(1))
    expect(() => transport.send('into the void')).not.toThrow()
    expect(() => transport.close()).not.toThrow()
    expect(() => transport.close()).not.toThrow()
  })

  it('reports a close when the peer vanishes mid-session, without throwing out of a send', async () => {
    // Deliberately asserts the *close*, not a post-open 'error' event: a socket error after open is
    // not deterministically triggerable from a test, and a spec that only passes sometimes is a
    // defect in the spec. The error path is covered by the refused-connection case above.
    let serverSocket: ServerSocket | undefined
    const url = await serve(socket => { serverSocket = socket })
    const { handlers, closes } = collector()
    const transport = await new WsTransportFactory().connect(url, {}, handlers)

    serverSocket?.terminate()
    await waitFor(() => expect(closes.length).toBeGreaterThan(0))
    // A write into a transport whose peer has gone must not escape as an exception.
    expect(() => transport.send('after the peer vanished')).not.toThrow()
    expect(() => transport.close()).not.toThrow()
  })
})
