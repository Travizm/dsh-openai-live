import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPLETIONS_PATH, MAX_BODY_BYTES, createDelegateHandler, resetQueues, startDelegateServer } from '../src/index.ts'
import type { DelegateServer, FollowFrame, SessionControllerLike } from '../src/index.ts'

const committed = (text: string): FollowFrame[] => [
  { type: 'event', event: { type: 'assistant/message', seq: 2, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } } },
  { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } } },
]

const okController = (text = 'It is raining.'): SessionControllerLike => ({
  async prompt() { return { accepted: true } },
  async *follow() { yield* committed(text) },
})

let server: DelegateServer | undefined

const start = async (controller: SessionControllerLike, extra: Partial<Parameters<typeof startDelegateServer>[0]> = {}): Promise<string> => {
  server = await startDelegateServer({ controller, port: 0, now: () => 1_700_000_000, ...extra })
  return server.url
}

const post = (url: string, body: unknown, path = COMPLETIONS_PATH): Promise<Response> =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })

beforeEach(() => { resetQueues() })
afterEach(async () => { await server?.close(); server = undefined })

describe('the completions surface', () => {
  it('answers a well-formed request with an OpenAI-shaped completion', async () => {
    const url = await start(okController())
    const response = await post(url, { sessionId: 's1', messages: [{ role: 'user', content: 'Weather?' }] })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(String(body['id'])).toMatch(/^chatcmpl-/)
    expect(body['object']).toBe('chat.completion')
    expect(body['created']).toBe(1_700_000_000)
    expect(body['model']).toBe('dsh-delegate')
    expect(body['choices']).toEqual([
      { index: 0, message: { role: 'assistant', content: 'It is raining.' }, finish_reason: 'stop' },
    ])
  })

  it('uses the configured default session when the body names none', async () => {
    const seen: string[] = []
    const controller: SessionControllerLike = {
      async prompt(request) { seen.push(request.sessionId); return {} },
      async *follow() { yield* committed('ok') },
    }
    const url = await start(controller, { sessionId: 'session-default', model: 'echo-model' })
    const response = await post(url, { messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(200)
    expect(seen).toEqual(['session-default'])
    expect((await response.json() as { model: string }).model).toBe('echo-model')
  })

  it('refuses a path it does not serve', async () => {
    const url = await start(okController())
    const response = await post(url, {}, '/v1/other')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('refuses a method it does not serve', async () => {
    const url = await start(okController())
    const response = await fetch(`${url}${COMPLETIONS_PATH}`)
    expect(response.status).toBe(405)
    expect(await response.json()).toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } })
  })

  it('refuses a body that is not JSON', async () => {
    const url = await start(okController())
    const response = await post(url, 'not json at all')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'MALFORMED_REQUEST' } })
  })

  it('refuses stream: true by name rather than ignoring it', async () => {
    // A client that asked for SSE and received one object has an invisible bug; saying so is the whole fix.
    const url = await start(okController())
    const response = await post(url, { sessionId: 's1', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'STREAM_UNSUPPORTED' } })
  })

  it('refuses a request with no messages, passing the translation code through', async () => {
    const url = await start(okController())
    const response = await post(url, { sessionId: 's1', messages: [] })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'NO_MESSAGES' } })
  })

  it('refuses a body over the size bound instead of buffering it', async () => {
    const url = await start(okController())
    const response = await post(url, 'x'.repeat(MAX_BODY_BYTES + 10))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'MALFORMED_REQUEST' } })
  })

  it('reports a failed turn as 502 with its code', async () => {
    const controller: SessionControllerLike = {
      async prompt() { return {} },
      async *follow() { yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'abandoned' } } } },
    }
    const url = await start(controller)
    const response = await post(url, { sessionId: 's1', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'ATTEMPT_ABANDONED' } })
  })

  it('reports a timed-out turn as 504, not as a provider failure', async () => {
    // 504 says "the budget was too small"; 502 would send the caller to the provider's status page.
    const controller: SessionControllerLike = {
      async prompt() { return {} },
      async *follow(_request, signal) {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      },
    }
    const url = await start(controller, { askOptions: { timeoutMs: 20 } })
    const response = await post(url, { sessionId: 's1', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(504)
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_TIMEOUT' } })
  })

  it('answers 500 with a code when the shim itself throws', async () => {
    const controller: SessionControllerLike = {
      async prompt() { throw new Error('the controller exploded') },
      async *follow() { yield* committed('never') },
    }
    const url = await start(controller)
    const response = await post(url, { sessionId: 's1', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'SHIM_FAILURE' } })
  })

  it('dates the response from the real clock when no clock is injected', async () => {
    const before = Math.floor(Date.now() / 1000)
    const url = await startDelegateServer({ controller: okController(), port: 0 })
      .then(started => { server = started; return started.url })
    const body = await (await post(url, { sessionId: 's1', messages: [{ role: 'user', content: 'hi' }] })).json() as { created: number }
    expect(body.created).toBeGreaterThanOrEqual(before)
  })

  it('refuses a request that carries no URL at all', async () => {
    // A hand-built listener can hand the handler a request without a url; the route check must not throw on it.
    let status = 0
    let payload = ''
    const response = {
      writeHead: (code: number) => { status = code; return response },
      end: (body: string) => { payload = body },
      headersSent: false,
    }
    createDelegateHandler({ controller: okController() })({ method: 'POST' } as never, response as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(status).toBe(404)
    expect(JSON.parse(payload)).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('reports a second close instead of pretending it succeeded', async () => {
    const started = await startDelegateServer({ controller: okController(), port: 0 })
    await started.close()
    // Node signals a close on an already-closed server. Swallowing it would hide a double-close bug in a plugin.
    await expect(started.close()).rejects.toThrow()
  })

  it('defaults to an ephemeral port on loopback when nothing is asked for', async () => {
    // The default must not bind a fixed port: two shims on one machine would fight, and a fixed port on a
    // shared host is a collision waiting for a restart.
    const started = await startDelegateServer({ controller: okController() })
    server = started
    expect(started.url).toBe(`http://127.0.0.1:${started.port}`)
    expect(started.port).toBeGreaterThan(0)
  })

  it('binds a real port and reports it, so a caller can build a URL without guessing', async () => {
    const url = await start(okController())
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(server?.port).toBeGreaterThan(0)
  })
})
