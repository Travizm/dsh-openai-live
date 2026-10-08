/**
 * The plugin against a real socket.
 *
 * A fake socket cannot complete a `ws` handshake, so the happy path is exercised for real: a `node:http`
 * server dispatches upgrades exactly as the harness web server does — one exact route, everything else
 * closed — and a real `ws` client connects to it.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import WebSocket from 'ws'
import { Config, apply } from '../src/index.ts'
import { DEFAULT_PATH, type RealtimeAudioWsConfig } from '../src/types.ts'

let cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

/** The route registry slice this package claims. */
class FakeWebServer extends Service {
  readonly upgrades = new Map<string, (req: IncomingMessage, socket: Duplex, head: Buffer) => unknown>()
  constructor(ctx: Context) { super(ctx, 'webServer') }
  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => unknown }): () => void {
    this.upgrades.set(route.path, route.handler)
    return () => { this.upgrades.delete(route.path) }
  }
}

/** The slice of the connection service that answers for an upgrade. */
class FakeConnection extends Service {
  rejection: 401 | 403 | undefined
  constructor(ctx: Context) { super(ctx, 'connection') }
  requestRejection(): 401 | 403 | undefined { return this.rejection }
}

async function mount(over: Partial<RealtimeAudioWsConfig> = {}) {
  const context = new Context()
  const web = new FakeWebServer(context)
  const connection = new FakeConnection(context)
  const mic: Uint8Array[] = []
  context.on('realtime-agent/mic', (pcm16: Uint8Array) => { mic.push(pcm16) })

  apply(context, Config(over) as RealtimeAudioWsConfig)
  // The `ctx.inject` callback lands on a microtask once both services are visible.
  await Promise.resolve()
  await Promise.resolve()

  const server: Server = createServer()
  server.on('upgrade', (req, socket, head) => {
    const handler = web.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) { socket.destroy(); return }
    void handler(req, socket, head)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as { port: number }

  cleanups.push(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await context.fiber.dispose()
  })
  return { context, web, connection, mic, url: (path = DEFAULT_PATH): string => `ws://127.0.0.1:${String(port)}${path}` }
}

/** Resolve with the first matching event, or reject so a failure names itself instead of timing out. */
function once(client: WebSocket, event: 'open' | 'message' | 'close'): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    client.once(event, (...args: unknown[]) => { resolve(args) })
    client.once('error', (error: Error) => { reject(error) })
  })
}

describe('the audio route', () => {
  it('claims exactly the configured path', async () => {
    const { web } = await mount()
    expect([...web.upgrades.keys()]).toEqual([DEFAULT_PATH])
  })

  it('carries a captured frame from the socket to the microphone seam', async () => {
    const { url, mic } = await mount()
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await once(client, 'open')
    client.send(Buffer.from([1, 2, 3]))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(mic.map(frame => Array.from(frame))).toEqual([[1, 2, 3]])
  })

  it('carries the agent speech back to the client', async () => {
    const { context, url } = await mount()
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await once(client, 'open')
    const received = once(client, 'message')
    context.emit('realtime-agent/audio', new Uint8Array([9, 8]))
    const [data] = await received as [Buffer]
    expect(Array.from(data)).toEqual([9, 8])
  })

  it('refuses an unauthenticated upgrade instead of accepting the socket', async () => {
    // Upgrades never reach the HTTP route handlers, so nothing else answers for them. Without the
    // connection service's check this route would be an unauthenticated loopback microphone.
    const { connection, url, mic } = await mount()
    connection.rejection = 401
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await expect(once(client, 'open')).rejects.toThrowError(/401/)
    expect(mic).toEqual([])
  })

  it('refuses with 403 when the connection service says the caller is untrusted', async () => {
    const { connection, url } = await mount()
    connection.rejection = 403
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await expect(once(client, 'open')).rejects.toThrowError(/403/)
  })

  it('closes a second connection while one microphone holds the route', async () => {
    const { url } = await mount({ maxConnections: 1 })
    const first = new WebSocket(url())
    const second = new WebSocket(url())
    cleanups.push(() => { first.terminate(); second.terminate() })
    await once(first, 'open')
    const [code] = await once(second, 'close') as [number]
    expect(code).toBe(1013)
  })

  it('drops the route and terminates live clients when the fiber is disposed', async () => {
    const { context, web, url } = await mount()
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await once(client, 'open')
    const closed = once(client, 'close')
    await context.fiber.dispose()
    await closed
    expect([...web.upgrades.keys()]).toEqual([])
  })
})
