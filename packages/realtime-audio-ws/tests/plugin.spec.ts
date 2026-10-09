/**
 * The plugin against a real socket.
 *
 * A fake socket cannot complete a `ws` handshake, so the happy path is exercised for real: a `node:http`
 * server dispatches upgrades exactly as the harness web server does — one exact route, everything else
 * closed — and a real `ws` client connects to it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import RealtimeRuntime from 'dsh-realtime'
import WebSocket from 'ws'
import { Config, apply } from '../src/index.ts'
import { INJECTED_KEY } from '../src/injection.ts'
import { DEFAULT_DIAGNOSTICS_PATH, DEFAULT_PATH, type RealtimeAudioWsConfig } from '../src/types.ts'
import { STRIP_ELEMENT_ID } from '../src/strip.ts'

let cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

/** The route registry slice this package claims: an upgrade table and an HTTP table. */
class FakeWebServer extends Service {
  readonly upgrades = new Map<string, (req: IncomingMessage, socket: Duplex, head: Buffer) => unknown>()
  readonly routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  /** The web server's own view of where it is listening: the injection row is built from these. */
  listenedPort = 19387
  readonly config = { port: 19387, host: '127.0.0.1' }
  constructor(ctx: Context) { super(ctx, 'webServer') }
  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => unknown }): () => void {
    this.upgrades.set(route.path, route.handler)
    return () => { this.upgrades.delete(route.path) }
  }
  register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

/** The slice of the connection service that answers for a route. */
class FakeConnection extends Service {
  rejection: 401 | 403 | undefined
  constructor(ctx: Context) { super(ctx, 'connection') }
  requestRejection(): 401 | 403 | undefined { return this.rejection }
}

async function mount(over: Partial<RealtimeAudioWsConfig> = {}) {
  const context = new Context()
  const web = new FakeWebServer(context)
  const connection = new FakeConnection(context)
  // The real seam, because the plugin writes into the journal it *finds* there and serves that same
  // instance: a fake would prove the calls happen and say nothing about what the route reports.
  const realtime = new RealtimeRuntime(context)
  const mic: Uint8Array[] = []
  context.on('realtime-agent/mic', (pcm16: Uint8Array) => { mic.push(pcm16) })

  apply(context, Config(over) as RealtimeAudioWsConfig)
  // The `ctx.inject` callback lands on a microtask once every service it named is visible.
  await Promise.resolve()
  await Promise.resolve()

  // The page's settings row, emitted exactly as the host emits it. The token exists nowhere else, so
  // reading it out of the row is the same thing the client half does.
  const table: { name: string; value: { token: string } }[] = []
  ;(context.emit as unknown as (name: string, emitted: unknown[]) => void)('webserver/index-inject', table)
  const token = table[0]!.value.token

  const server: Server = createServer()
  server.on('upgrade', (req, socket, head) => {
    const handler = web.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) { socket.destroy(); return }
    void handler(req, socket, head)
  })
  server.on('request', (req, res) => {
    const handler = web.routes.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    void handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as { port: number }

  cleanups.push(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await context.fiber.dispose()
  })
  return {
    context,
    web,
    connection,
    mic,
    token,
    journal: realtime.journal,
    url: (path = DEFAULT_PATH): string => `ws://127.0.0.1:${String(port)}${path}`,
    http: (path = DEFAULT_DIAGNOSTICS_PATH, query = ''): string => `http://127.0.0.1:${String(port)}${path}${query}`,
  }
}

describe('the journal it writes to a file', () => {
  it('appends to the path it was given, and never the token', async () => {
    // Off by default is a policy rather than an oversight: a plugin that writes files because it was
    // installed is a plugin writing files in somebody else's directory. This is the deployment that named
    // one, and the assertion is about the file — not the buffer — because the file is the whole point.
    const path = join(mkdtempSync(join(tmpdir(), 'audio-ws-journal-')), 'records.jsonl')
    const { journal, token } = await mount({ journalPath: path })

    journal.record('session.closed', {})

    const written = readFileSync(path, 'utf8')
    expect(written.trim().split('\n').map(line => (JSON.parse(line) as { kind: string }).kind))
      .toEqual(['session.closed'])
    // The token is registered as a secret *before* the sink is registered, so an entry that carried it would
    // still be redacted on its way to the file. This is that ordering, observed on disk.
    expect(written).not.toContain(token)
  })
})

describe('the journal the audio route writes', () => {
  it('records an accepted socket with its target, redacting the token the page presented', async () => {
    const { journal, token, url } = await mount()
    const client = new WebSocket(`${url()}?t=${token}`)
    await new Promise((resolve) => { client.on('open', resolve) })
    cleanups.push(() => { client.terminate() })

    const accepted = journal.snapshot().find(entry => entry.kind === 'socket.accepted')
    // The target is the one place this process's own token travels, and the token is the secret no
    // pattern can find — so this is the value arm, at the sink that was going to leak it.
    expect(accepted?.detail.url).toContain('[redacted]')
    expect(accepted?.detail.url).not.toContain(token)
    expect(accepted?.detail.clients).toBe('1')
  })

  it('records a refused socket with its verdict and no target at all', async () => {
    const { connection, journal, url } = await mount()
    connection.rejection = 401

    await new Promise((resolve) => {
      const client = new WebSocket(url())
      client.on('error', resolve)
      client.on('close', resolve)
      cleanups.push(() => { client.terminate() })
    })

    const rejected = journal.snapshot().find(entry => entry.kind === 'socket.rejected')
    expect(rejected?.detail).toEqual({ verdict: '401' })
  })

  it('records a second microphone as busy rather than dropping it silently', async () => {
    const { journal, url } = await mount({ maxConnections: 1 })
    const first = new WebSocket(url())
    await new Promise((resolve) => { first.on('open', resolve) })
    cleanups.push(() => { first.terminate() })

    const second = new WebSocket(url())
    const code = await new Promise<number>((resolve) => { second.on('close', (value: number) => { resolve(value) }) })
    cleanups.push(() => { second.terminate() })

    expect(code).toBe(1013)
    expect(journal.snapshot().some(entry => entry.detail.verdict === '1013')).toBe(true)
  })

  it('records a socket leaving, so a journal that stops is not read as a process that died', async () => {
    const { journal, url } = await mount()
    const client = new WebSocket(url())
    await new Promise((resolve) => { client.on('open', resolve) })
    cleanups.push(() => { client.terminate() })

    const closed = new Promise((resolve) => { client.on('close', resolve) })
    client.close()
    await closed
    // The host detaches on its own turn, after the socket is gone — so wait for the entry instead of
    // assuming it landed with the client's own close event.
    await vi.waitFor(() => {
      expect(journal.snapshot().some(entry => entry.kind === 'socket.closed')).toBe(true)
    })

    // Whichever way it left, the journal says so rather than trailing off after the accept — and in order.
    // `apply`'s `config.resolved` is the head and belongs to the plugin, so the assertion starts at the
    // accept; the ask for a session then sits between the two socket entries, because this mount leaves
    // `openSessionOnConnect` at its default of true.
    const kinds = journal.snapshot().map(entry => entry.kind)
    expect(kinds.slice(kinds.indexOf('socket.accepted')))
      .toEqual(['socket.accepted', 'session.requested', 'socket.closed'])
  })

  it('lets the host page read the answer, which is cross-origin to loopback', async () => {
    const { http, token, connection } = await mount()
    const page = { headers: { origin: 'dsh-app://app' } }

    // The page the host serves lives on its own scheme, so every response it reads is cross-origin, and a
    // browser discards a cross-origin response with no `Access-Control-Allow-Origin`. The route answered
    // 200 to a request from that page and the caller saw only a CORS failure — which is how this survived
    // its own tests: every one of them asserted the status, and the status was right the whole time.
    const authorised = await fetch(http(DEFAULT_DIAGNOSTICS_PATH, `?t=${token}`), page)
    expect(authorised.status).toBe(200)
    expect(authorised.headers.get('access-control-allow-origin')).toBe('dsh-app://app')
    expect(authorised.headers.get('vary')).toContain('Origin')

    // The refusal carries it too, or a page could learn that it was refused and not why. The refusal comes
    // from the connection service — a missing token is not by itself one, because the token is the override
    // and the service is the gate — so this asks the service to object, as the host's own does.
    connection.rejection = 401
    const refused = await fetch(http(), page)
    expect(refused.status).toBe(401)
    expect(refused.headers.get('access-control-allow-origin')).toBe('dsh-app://app')
    connection.rejection = undefined

    // A caller that sent no origin is granted nothing it did not need — curl has no same-origin policy to
    // be exempted from.
    const plain = await fetch(http(DEFAULT_DIAGNOSTICS_PATH, `?t=${token}`))
    expect(plain.status).toBe(200)
    expect(plain.headers.get('access-control-allow-origin')).toBeNull()

    // A preflight is answered only once the verdict has allowed the caller: answering one before that would
    // confirm the route's existence to anyone who guessed its path.
    const preflight = await fetch(http(DEFAULT_DIAGNOSTICS_PATH, `?t=${token}`), { method: 'OPTIONS', ...page })
    expect(preflight.status).toBe(204)
    connection.rejection = 403
    const unauthorised = await fetch(http(), { method: 'OPTIONS', ...page })
    expect(unauthorised.status).toBe(403)
    connection.rejection = undefined
  })

  it('records a verdict even when a request carries no target', async () => {
    // `node:http` always reports a target on a server request, so this is unreachable in practice — but
    // it is the branch that decides whether a malformed request is journalled or throws while recording.
    const { web, connection, journal } = await mount()
    connection.rejection = 403
    const socket = { write: () => true, end: () => {}, destroy: () => {} } as unknown as Duplex

    web.upgrades.get(DEFAULT_PATH)?.({ url: undefined, headers: {} } as unknown as IncomingMessage, socket, Buffer.alloc(0))

    expect(journal.snapshot().some(entry => entry.detail.verdict === '403')).toBe(true)
  })

  it('serves the journal over HTTP and refuses a caller the connection service rejected', async () => {
    const { connection, journal, http } = await mount()
    journal.record('delegation.seen', { id: 'item_1' })

    const allowed = await fetch(http())
    expect(allowed.status).toBe(200)
    // The journal's head is the `config.resolved` entry apply writes; this assertion is about the entry the
    // test wrote reaching the route, not about the journal having no other entries.
    const served = (await allowed.json()) as { entries: Array<{ kind: string }> }
    expect(served.entries.at(-1)?.kind).toBe('delegation.seen')

    // The regression this route exists to prevent: the host's registry gates nothing, so the plugin
    // must, and the same verdict answers both doors.
    connection.rejection = 401
    const refused = await fetch(http())
    expect(refused.status).toBe(401)
  })
})

describe('the ask it records, and the config it resolved', () => {
  it('records the request for a session on the side that asks, when a client connects', async () => {
    const { journal, url } = await mount()
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await once(client, 'open')

    // The opener records what came of the request. This side records that it asked — the only thing that tells
    // a listener which never ran apart from a session nobody asked for, whose journals are otherwise identical.
    const asked = journal.snapshot().find(entry => entry.kind === 'session.requested')
    expect(asked?.detail).toEqual({ trigger: 'connect', clients: '1' })
  })

  it('records a request from the control channel as the strip asking, and a stop as no request at all', async () => {
    const { journal, url } = await mount()
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await once(client, 'open')

    const strips = (): number => journal.snapshot()
      .filter(entry => entry.kind === 'session.requested' && entry.detail.trigger === 'strip').length

    client.send('stop')
    await once(client, 'message')
    // A stop is answered by the close entry that follows it, so it is not a request for a session.
    expect(strips()).toBe(0)

    client.send('start')
    await once(client, 'message')
    expect(strips()).toBe(1)
  })

  it('records what it resolved, so the journal can be read without the profile beside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audio-ws-config-'))
    const { journal } = await mount({
      path: '/dsh-realtime/audio',
      openSessionOnConnect: false,
      journalPath: join(dir, 'journal.jsonl'),
    })

    // The question this answers is the one nothing else can: which route, and whether anything was going to
    // open a session on its own. `journalPath` names a file and carries no secret, and the token was handed to
    // the journal's redaction on the line before this record, so it cannot reach here in the first place.
    expect(journal.snapshot()[0]?.detail).toEqual({
      plugin: 'dsh-realtime-audio-ws',
      path: '/dsh-realtime/audio',
      openSessionOnConnect: 'false',
      maxConnections: '1',
      maxFrameBytes: '480000',
      journalPath: join(dir, 'journal.jsonl'),
    })
  })
})

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

  it('asks the agent for the session when an authenticated client connects', async () => {
    const { context, url } = await mount()
    const starts: number[] = []
    context.on('realtime-agent/start', () => { starts.push(1) })
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await once(client, 'open')
    // Without this a working microphone writes into a session nobody opened, and the mic seam drops every
    // frame by design — silence that looks like a fault anywhere but in the agent.
    expect(starts).toHaveLength(1)
  })

  it('ends the session when the last client leaves', async () => {
    const { context, url } = await mount()
    const stops: number[] = []
    context.on('realtime-agent/stop', () => { stops.push(1) })
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await once(client, 'open')
    const closed = once(client, 'close')
    client.close()
    await closed
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(stops).toHaveLength(1)
  })

  it('leaves the session alone when asked not to open one', async () => {
    const { context, url } = await mount({ openSessionOnConnect: false })
    const events: string[] = []
    context.on('realtime-agent/start', () => { events.push('start') })
    context.on('realtime-agent/stop', () => { events.push('stop') })
    const client = new WebSocket(url())
    cleanups.push(() => { client.terminate() })
    await once(client, 'open')
    client.close()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(events).toEqual([])
  })

  /** Gather the injection table the web server collects on every index render and worker boot payload. */
  function injectionTable(context: Context): Array<{ name: string; value: { path?: string; authority?: string; token?: string } }> {
    const table: unknown[] = []
    void (context.emit as unknown as (name: string, payload: unknown) => void)('webserver/index-inject', table)
    return table as Array<{ name: string; value: { path?: string; authority?: string; token?: string } }>
  }

  /** Every row the plugin contributes, whatever kind, in the order the host would render them. */
  function injectionRows(context: Context): Array<{ kind: string; html?: string; text?: string }> {
    const table: unknown[] = []
    void (context.emit as unknown as (name: string, payload: unknown) => void)('webserver/index-inject', table)
    return table as Array<{ kind: string; html?: string; text?: string }>
  }

  it('publishes the route settings the page needs, built at emit time', async () => {
    const { context } = await mount()
    const table = injectionTable(context)
    expect(table[0]?.name).toBe(INJECTED_KEY)
    expect(table[0]?.value.path).toBe(DEFAULT_PATH)
    // The port is read at emit time, not at boot: an index render follows the listen, which is the only
    // moment the OS-assigned port is known.
    expect(table[0]?.value.authority).toBe('127.0.0.1:19387')
    expect(table[0]?.value.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('publishes the strip after the settings it reads', async () => {
    const { context } = await mount()
    const rows = injectionRows(context)
    // Markup, then the bootstrap that mounts the panel on it: the table's ordering guarantee is what makes
    // a two-row panel safe, and the settings row has to come first because the bundle reads it while
    // rendering.
    expect(rows.map(row => row.kind)).toEqual(['global', 'html', 'script'])
    expect(rows[1]?.html).toContain(`id="${STRIP_ELEMENT_ID}"`)
    expect(rows[2]?.text).toContain('__dshRealtimeAudio')
  })

  it('accepts the injected token from a caller that cannot carry the cookie', async () => {
    // The desktop app's page is served from `dsh-app://app`, so its request to loopback is cross-site and
    // the harness's SameSite=Strict cookie never arrives — the connection service refuses it, correctly.
    // The injected token is what makes that page usable at all, and this is the case that proves it.
    const { context, connection, url } = await mount()
    connection.rejection = 401
    const token = injectionTable(context)[0]?.value.token ?? ''
    expect(token).not.toBe('')
    const client = new WebSocket(`${url()}?t=${token}`)
    cleanups.push(() => { client.terminate() })
    await once(client, 'open')
    // The service's verdict is untouched: it is the token that admitted this caller, not a changed answer.
    expect(connection.rejection).toBe(401)
  })

  it('still refuses a caller presenting the wrong token', async () => {
    const { connection, url } = await mount()
    connection.rejection = 401
    const client = new WebSocket(`${url()}?t=not-the-token`)
    cleanups.push(() => { client.terminate() })
    await expect(once(client, 'open')).rejects.toThrowError(/401/)
  })
})

describe('the settings the route declares', () => {
  it('declares its one live field on the seam, so a control plane can find it', async () => {
    const { context } = await mount()
    expect(context.realtime.settings.list()).toEqual([{
      key: 'realtime-audio-ws.openSessionOnConnect',
      owner: 'realtime-audio-ws',
      field: 'openSessionOnConnect',
      kind: 'boolean',
      scope: 'live',
      describe: 'Ask the agent to open the session when an authenticated client connects',
      value: true,
    }])
  })

  it('applies a change to the next connection rather than the next boot', async () => {
    const { context, journal, url } = await mount({ openSessionOnConnect: false })
    const started: string[] = []
    context.on('realtime-agent/start', () => { started.push('start') })

    const first = new WebSocket(url())
    cleanups.push(() => { first.terminate() })
    await once(first, 'open')
    // Mounted with it off, so an authenticated microphone produced silence — the state the gate says
    // must be changeable without a restart, because otherwise it is the failure that looks like a fault
    // anywhere but in this plugin.
    expect(started).toEqual([])

    expect(context.realtime.settings.apply('realtime-audio-ws.openSessionOnConnect', 'true'))
      .toEqual({ ok: true, key: 'realtime-audio-ws.openSessionOnConnect', value: true })
    // Recorded by key: a change to a running plugin is a thing that happened, and the journal is where
    // a reader looks for it.
    expect(journal.snapshot().at(-1)).toMatchObject({ kind: 'config.changed', detail: { key: 'realtime-audio-ws.openSessionOnConnect' } })

    const closed = once(first, 'close')
    first.close()
    await closed
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    const second = new WebSocket(url())
    cleanups.push(() => { second.terminate() })
    await once(second, 'open')
    expect(started).toEqual(['start'])
  })

  it('refuses a key it does not have, rather than silently doing nothing', async () => {
    const { context } = await mount()
    expect(context.realtime.settings.apply('realtime-audio-ws.maxFrameBytes', '10'))
      .toMatchObject({ ok: false, code: 'UNKNOWN_SETTING' })
  })

  it('withdraws its setting with the fiber that registered it', async () => {
    const { context } = await mount()
    const settings = context.realtime.settings
    await context.fiber.dispose()
    expect(settings.list()).toEqual([])
  })
})
