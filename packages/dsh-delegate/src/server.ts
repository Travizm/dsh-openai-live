/**
 * P4b, third piece — the HTTP surface an OpenAI-compatible client can point at.
 *
 * `POST /v1/chat/completions` → admit the turn through the controller, follow it to its answer, reply with a
 * completion. Four rules shape the surface:
 *
 * 1. **Loopback by default.** The endpoint is a door into a live agent session; binding it to `0.0.0.0` by
 *    default would publish that door on whatever network the machine is on.
 * 2. **Every failure is coded in the body.** A caller that gets a 500 with prose has to parse English to know
 *    whether to retry; `{ error: { code } }` is the difference between a retry loop that works and one that
 *    thrashes.
 * 3. **A bounded body.** An unbounded `readFile` on a request body is a memory exhaustion handed to anyone who
 *    can reach the port.
 * 4. **No `stream: true`.** Not implemented is stated, not silently ignored — a client asking for SSE and
 *    receiving one JSON object has a bug nobody can find from the outside.
 *
 * @module dsh-delegate/server
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { COMPLETIONS_PATH, DelegateRequestError, toCompletion, toPromptRequest } from './protocol.ts'
import type { CompletionBody, CompletionResponse } from './protocol.ts'
import { ask } from './settle.ts'
import type { AskOptions, SessionControllerLike } from './settle.ts'

/** Refuse a body larger than this. A completion request is text; a megabyte is already generous. */
export const MAX_BODY_BYTES = 1_048_576

/** Everything the handler needs. */
export interface DelegateOptions {
  readonly controller: SessionControllerLike
  /** Session a request is admitted to when the body does not name one. */
  readonly sessionId?: string
  /** Model name echoed in the response. Diagnostic only — it never selects behaviour. */
  readonly model?: string
  /** Passed through to {@link ask}: turn budget and injectable timers. */
  readonly askOptions?: AskOptions
  /** Injected clock, so a test can assert `created` without freezing time globally. */
  readonly now?: () => number
}

/** A refusal, in the one shape a client can branch on. */
interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string }
}

function refuse(response: ServerResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } }
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function send(response: ServerResponse, status: number, body: CompletionResponse): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** Read the body, refusing one that is too large rather than buffering it. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new DelegateRequestError(`the body exceeded ${MAX_BODY_BYTES} bytes`, 'MALFORMED_REQUEST')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Build the request handler.
 *
 * Returned rather than registered so a test can drive it directly, and so a plugin can mount it wherever the
 * harness expects a listener.
 */
export function createDelegateHandler(options: DelegateOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const now = options.now ?? (() => Date.now())
  const model = options.model ?? 'dsh-delegate'
  return (request, response) => {
    void (async () => {
      const path = (request.url ?? '').split('?')[0]
      if (path !== COMPLETIONS_PATH) return refuse(response, 404, 'NOT_FOUND', `no route for ${path}`)
      if (request.method !== 'POST') return refuse(response, 405, 'METHOD_NOT_ALLOWED', 'completions are POST')
      let body: CompletionBody
      try {
        body = JSON.parse(await readBody(request)) as CompletionBody
      } catch (error) {
        if (error instanceof DelegateRequestError) return refuse(response, 400, error.code, error.message)
        return refuse(response, 400, 'MALFORMED_REQUEST', 'the body was not JSON')
      }
      if ((body as { stream?: unknown }).stream === true) {
        // Stated, not ignored: a client that asked for SSE and got one object has an invisible bug.
        return refuse(response, 400, 'STREAM_UNSUPPORTED', 'this shim does not implement stream: true')
      }
      if (body.sessionId === undefined && options.sessionId !== undefined) body = { ...body, sessionId: options.sessionId }
      const prompt = toPromptRequest(body)
      const result = await ask(options.controller, prompt, options.askOptions)
      if (result.kind === 'failure') {
        const status = result.code === 'TURN_TIMEOUT' ? 504 : 502
        return refuse(response, status, result.code, result.message)
      }
      return send(response, 200, toCompletion(result.text, { model, requestId: prompt.requestId, created: now() }))
    })().catch((error: unknown) => {
      // One mapping for anything that escaped the inline handlers: a translation refusal is the caller's fault and
      // gets a 400 with its code; everything else is the shim's and gets a 500. Every writer above returns
      // immediately, so nothing has been sent by the time an error can reach here.
      if (error instanceof DelegateRequestError) return refuse(response, 400, error.code, error.message)
      refuse(response, 500, 'SHIM_FAILURE', 'the shim failed while handling the request')
    })
  }
}

/** A running shim. */
export interface DelegateServer {
  /** Base URL a client points at, e.g. `http://127.0.0.1:8787`. */
  readonly url: string
  /** The port actually bound — useful when the caller asked for `0`. */
  readonly port: number
  /** Stop listening and release the port. */
  close(): Promise<void>
}

/**
 * Start the shim.
 *
 * Binds `127.0.0.1` unless a host is given. Deployments that need a public URL — Deepgram's managed cloud
 * cannot reach loopback — must pass `host` deliberately and put a proxy in front; see
 * `docs/p4-delegate-shim.md`.
 */
export function startDelegateServer(options: DelegateOptions & { readonly port?: number; readonly host?: string }): Promise<DelegateServer> {
  const handler = createDelegateHandler(options)
  const server: Server = createServer(handler)
  // Hoisted so both defaults are reachable by a test: an inline `?? 0` inside the listen call can only ever be
  // exercised one way, which makes the untested side a claim rather than a decision.
  const requestedPort = options.port ?? 0
  const host = options.host ?? '127.0.0.1'
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, host, () => {
      // We asked for a TCP host and port, so `address()` is an `AddressInfo`. The usual
      // `typeof address === 'object'` dance is a branch no test can reach — and an untestable guard is one a
      // reader has to take on faith.
      const bound = (server.address() as AddressInfo).port
      resolve({
        url: `http://${host}:${bound}`,
        port: bound,
        close: () => new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done()))),
      })
    })
  })
}
