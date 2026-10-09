import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Journal, REDACTED } from 'dsh-realtime'
import { diagnosticsRoute } from '../src/diagnostics.ts'
import { DEFAULT_DIAGNOSTICS_PATH } from '../src/types.ts'

/** The token this process minted. Fixed here so the override case can present it. */
const TOKEN = 'token-this-process-minted'

/** Derived, never written: a credential-shaped literal is what the leak scan and gitleaks both fail on. */
const ROUTE_TOKEN = Buffer.from(Uint8Array.from({ length: 32 }, (_unused, index) => (index * 11 + 5) % 256)).toString('base64url')

/** A response that records everything the handler wrote, so an assertion reads the whole response. */
function fakeResponse(): { res: ServerResponse; written: { status?: number; headers?: Record<string, string>; body?: string } } {
  const written: { status?: number; headers?: Record<string, string>; body?: string } = {}
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => { written.status = status; written.headers = headers },
    end: (body?: string) => { written.body = body ?? '' },
  } as unknown as ServerResponse
  return { res, written }
}

/** A request carrying a target; the headers are empty because the connection service is faked. */
function fakeRequest(url: string): IncomingMessage {
  return { url, headers: {} } as unknown as IncomingMessage
}

interface Overrides {
  rejectionFor?: (request: { headers: IncomingMessage['headers'] }) => 401 | 403 | undefined
  journal?: Journal
}

function build(over: Overrides = {}) {
  const journal = over.journal ?? new Journal({ capacity: 8 })
  return {
    journal,
    built: diagnosticsRoute({
      path: DEFAULT_DIAGNOSTICS_PATH,
      token: TOKEN,
      rejectionFor: over.rejectionFor ?? (() => undefined),
      journal,
    }),
  }
}

describe('the diagnostics route', () => {
  it('claims the configured path exactly, as the registry contract requires', () => {
    const { built } = build()
    expect(built.kind).toBe('exact')
    expect(built.path).toBe(DEFAULT_DIAGNOSTICS_PATH)
  })

  it('serves the journal as JSON to a caller the connection service accepts', () => {
    const { journal, built } = build()
    journal.record('delegation.seen', { id: 'item_1' })
    const { res, written } = fakeResponse()

    built.handler(fakeRequest(DEFAULT_DIAGNOSTICS_PATH), res)

    expect(written.status).toBe(200)
    expect(written.headers?.['content-type']).toBe('application/json')
    // A picture of a moving buffer must not be cached and read as current.
    expect(written.headers?.['cache-control']).toBe('no-store')
    const body = JSON.parse(String(written.body)) as { size: number; entries: { kind: string }[] }
    expect(body.size).toBe(1)
    expect(body.entries.map(entry => entry.kind)).toEqual(['delegation.seen'])
  })

  it('refuses an unauthorized caller, which is the whole reason it carries the check', () => {
    // The registry applies no authentication of its own and knows no harness concepts, so nothing
    // upstream answered this question. A route that skipped the check would hand the journal — and the
    // failure reasons in it — to anything on loopback.
    const { journal, built } = build({ rejectionFor: () => 401 })
    journal.record('prompt.refused', { reason: 'session/model-unavailable' })
    const { res, written } = fakeResponse()

    built.handler(fakeRequest(DEFAULT_DIAGNOSTICS_PATH), res)

    expect(written.status).toBe(401)
    expect(JSON.parse(String(written.body))).toEqual({ error: 'unauthorized' })
    // Not just a status: the body must not carry the record it refused to serve.
    expect(String(written.body)).not.toContain('model-unavailable')
  })

  it('reports a 403 as a 403 rather than flattening every refusal to one status', () => {
    const { built } = build({ rejectionFor: () => 403 })
    const { res, written } = fakeResponse()

    built.handler(fakeRequest(DEFAULT_DIAGNOSTICS_PATH), res)

    expect(written.status).toBe(403)
    expect(JSON.parse(String(written.body))).toEqual({ error: 'forbidden' })
  })

  it('accepts the process token in place of a cookie the app page can never carry', () => {
    // The desktop page is `dsh-app://app`, so its requests to loopback are cross-site and the harness's
    // SameSite=Strict cookie cannot travel. This is the same override the audio route performs.
    const { built } = build({ rejectionFor: () => 401 })
    const { res, written } = fakeResponse()

    built.handler(fakeRequest(`${DEFAULT_DIAGNOSTICS_PATH}?t=${TOKEN}`), res)

    expect(written.status).toBe(200)
  })

  it('rejects the token presented on a request the service would have accepted', () => {
    // A wrong token is not a credential, and it must not turn an accepted caller into a refused one —
    // the override runs one way only.
    const { built } = build()
    const { res, written } = fakeResponse()

    built.handler(fakeRequest(`${DEFAULT_DIAGNOSTICS_PATH}?t=not-the-token`), res)

    expect(written.status).toBe(200)
  })

  it('travels with the eviction markers, so an empty list is not read as an idle one', () => {
    const { journal, built } = build({ journal: new Journal({ capacity: 1 }) })
    journal.record('session.opened', { provider: 'openai-live' })
    journal.record('session.closed', {})
    const { res, written } = fakeResponse()

    built.handler(fakeRequest(DEFAULT_DIAGNOSTICS_PATH), res)

    const body = JSON.parse(String(written.body)) as { size: number; oldestSeq: number }
    expect(body.size).toBe(1)
    expect(body.oldestSeq).toBe(2)
  })

  it('cannot leak a secret the journal refused to retain, because it redacts on write', () => {
    // The route is Q3's third sink. It does not redact on the way out and does not need to: the value
    // was already replaced before it was stored, so there is no second step for a later edit to forget.
    const { journal, built } = build({ journal: new Journal({ capacity: 8, secrets: [ROUTE_TOKEN] }) })
    journal.record('socket.rejected', { url: `/dsh-realtime/audio?t=${ROUTE_TOKEN}` })
    const { res, written } = fakeResponse()

    built.handler(fakeRequest(DEFAULT_DIAGNOSTICS_PATH), res)

    expect(String(written.body)).not.toContain(ROUTE_TOKEN)
    expect(String(written.body)).toContain(REDACTED)
  })
})
