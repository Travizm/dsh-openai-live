/**
 * The Cordis plugin — the completions shim, mounted against the harness's own sessions.
 *
 * This is the piece that makes A′ real: DSH is the only brain, and the shim is the door a voice provider knocks
 * on. Until it existed, `dsh-delegate` was a library and an HTTP server with no way into a running harness.
 *
 * Two conventions it follows, both silent when broken:
 *
 * 1. **Named exports, no default** — a default export makes the Loader discard the plugin's namespace, so the
 *    plugin loads and contributes nothing.
 * 2. **`inject: ['sessionController']`** — the service must exist before `apply` runs. Note it does **not** inject
 *    `realtime`: the shim is not part of the voice seam, it is a door onto the session controller, and mounting it
 *    must not depend on the seam being present.
 *
 * The server starts asynchronously, so `apply` returns a handle rather than blocking: a caller (and a test) can see
 * the URL once bound, or the error if the port was taken. Binding loopback by default, because this endpoint is a
 * door into a live agent session.
 *
 * @module dsh-delegate/plugin
 */
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { startDelegateServer } from './server.ts'
import type { SessionControllerLike } from './settle.ts'

/** Plugin name, as it appears in Loader diagnostics. */
export const name = 'dsh-delegate'

/** The one service this plugin needs. */
export const inject = ['sessionController']

/** Validated configuration. */
export const Config = Schema.object({
  port: Schema.number().default(8787).description('Port to bind; 0 asks the OS for one'),
  host: Schema.string().default('127.0.0.1').description('Interface to bind — loopback unless deliberately widened'),
  sessionId: Schema.string().description('Session a completion is admitted to when the body names none'),
  model: Schema.string().default('dsh-delegate').description('Model name echoed in responses'),
  timeoutMs: Schema.number().default(120_000).description('Per-turn budget'),
})

/** The configuration `apply` receives, after validation. */
export interface DelegatePluginConfig {
  readonly port?: number
  readonly host?: string
  readonly sessionId?: string
  readonly model?: string
  readonly timeoutMs?: number
}

/** What `apply` returns: where the shim came up, or why it did not. */
export interface DelegateHandle {
  /** Base URL once bound, e.g. `http://127.0.0.1:8787`. */
  readonly url?: string
  /** The port actually bound. */
  readonly port?: number
  /** Set when the server could not start — a taken port, a bad host. */
  readonly error?: Error
  /** Stop listening. Safe to call before the server has bound, and more than once. */
  close(): Promise<void>
}

/**
 * Coerce whatever a rejected promise carried into an `Error`.
 *
 * Node's `listen` rejects with an `Error`, so the second arm is for a rejection from anywhere else — a plugin
 * loader, a transport, a future caller. It is exported so it can be exercised directly instead of sitting in a
 * handler as a branch no test reaches.
 */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Mount the shim.
 * @param ctx - the Cordis context; must provide `sessionController`.
 * @param config - validated configuration.
 * @returns a handle whose `url` fills in once bound.
 */
export function apply(ctx: Context, config: DelegatePluginConfig = {}): DelegateHandle {
  // `closed` belongs to the handle, not to the server: dispose and an explicit close are both normal, and the
  // second must be a no-op rather than "Server is not running" thrown at whoever happened to call last.
  let closed = false
  let release: (() => Promise<void>) | undefined
  const handle: { url?: string; port?: number; error?: Error; close(): Promise<void> } = {
    async close() {
      if (closed) return
      closed = true
      await release?.()
    },
  }
  const starting = startDelegateServer({
    controller: (ctx as unknown as { sessionController: SessionControllerLike }).sessionController,
    port: config.port ?? 8787,
    host: config.host ?? '127.0.0.1',
    ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
    ...(config.model === undefined ? {} : { model: config.model }),
    askOptions: { timeoutMs: config.timeoutMs ?? 120_000 },
  })
  // Resolved rather than awaited: `apply` is called during plugin start-up and blocking it would stall the harness.
  void starting.then(
    server => { handle.url = server.url; handle.port = server.port; release = () => server.close() },
    (error: unknown) => { handle.error = asError(error) },
  )
  // Cordis disposes a plugin by emitting `dispose`; releasing the port here is what stops a reload from leaving a
  // listener behind.
  const context = ctx as unknown as { on?: (event: string, listener: () => void) => void }
  const dispose = (): void => { void handle.close() }
  if (typeof context.on === 'function') context.on('dispose', dispose)
  return handle
}
