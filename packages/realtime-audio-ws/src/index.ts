/**
 * The audio route: the host end of the client half's transport.
 *
 * A **function plugin**: named-exports `name` / `Config` / `apply`, and no default export — a default
 * export makes the Loader discard the namespace, so the plugin loads and contributes nothing.
 *
 * It declares no top-level `inject` and defers its registration with `ctx.inject([...])` instead. The
 * measured result is the same as a declared inject: the row's fiber waits until the web server and
 * connection services exist, so a composition without a web stack gets a row that visibly waits rather
 * than one that loads and silently claims nothing. `packages/realtime-audio-ws/tests/plugin.spec.ts` proves
 * the functional path against a real socket with both services present.
 *
 * It claims **two** routes on that registry, and one policy authenticates both: the WebSocket upgrade
 * that carries audio, and the JSON diagnostics route that serves the journal. See `./diagnostics.ts` for
 * why the second reuses the first's check rather than deriving its own.
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
// Type-only: pulls the `Events` augmentation that declares the two audio events this package bridges.
import type {} from 'dsh-realtime-agent'
import { attachAudioSocket } from './bridge.ts'
import { diagnosticsRoute } from './diagnostics.ts'
import {
  createRouteToken,
  routeAuthority,
  routeInjectionRow,
  tokenFromUrl,
  verdictFor,
  type InjectedGlobalRow,
} from './injection.ts'
import { createUpgradeAcceptor, rejectUpgrade } from './upgrade.ts'
import {
  DEFAULT_DIAGNOSTICS_PATH,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_OPEN_SESSION_ON_CONNECT,
  DEFAULT_PATH,
  type AudioSocket,
  type RealtimeAudioWsConfig,
} from './types.ts'

export * from './types.ts'
/**
 * The query parameter carrying the capability token.
 *
 * Published with the route rather than kept internal: nothing can address the route without it, and a
 * consumer restating the literal is a consumer that drifts. It is one string; the rest of `injection.ts`
 * stays where it is.
 */
export { TOKEN_PARAM } from './injection.ts'
export { attachAudioSocket, toBytes, type AudioSocketBridgeDeps } from './bridge.ts'
export { createUpgradeAcceptor, rejectUpgrade, type UpgradeAcceptor } from './upgrade.ts'
export { diagnosticsRoute, type DiagnosticsDeps, type DiagnosticsJournal, type DiagnosticsRoute } from './diagnostics.ts'

/** Plugin name. */
export const name = 'realtime-audio-ws'

export const Config = Schema.object({
  path: Schema.string().default(DEFAULT_PATH),
  maxFrameBytes: Schema.natural().default(DEFAULT_MAX_FRAME_BYTES),
  maxConnections: Schema.natural().default(DEFAULT_MAX_CONNECTIONS),
  // True, and deliberately not the same decision as the agent's `autoStart`. That one opens a session at
  // boot with nobody asking, which is why it is false. This one opens a session because someone connected a
  // microphone: a connection takes an explicit action, an authenticated one, and its absence is silence.
  openSessionOnConnect: Schema.boolean().default(DEFAULT_OPEN_SESSION_ON_CONNECT),
  diagnosticsPath: Schema.string().default(DEFAULT_DIAGNOSTICS_PATH),
})

/**
 * The slice of the web server's route registry this package claims.
 *
 * Structural rather than imported: `@deepseek-ai/dsh-host-webserver` is a DeepSeek package, and importing
 * it would both add a dependency edge for one shape and augment `Context` with another declaration of
 * `webServer` — two declarations of one property with different types is a compile error.
 *
 * `register` applies no authentication of its own and knows no harness concepts: the handler owns the
 * whole response. That is why both routes here carry the same explicit check rather than trusting the
 * registry to have made the decision.
 */
interface WebServerLike {
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
  /**
   * The port actually listening — the OS-assigned value when the config asked for zero. Read at injection
   * time rather than at boot, because an index render happens after the listen.
   */
  readonly listenedPort?: number
  /** The configured bind host, so the page can be told an authority it can actually reach. */
  readonly config?: { readonly host?: string }
}

/** The slice of the connection service that authenticates an upgrade. Structural for the same reason. */
interface ConnectionLike {
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

export function apply(ctx: Context, config: RealtimeAudioWsConfig): void {
  ctx.inject(['connection', 'webServer', 'realtime'], (injected) => {
    const services = injected as unknown as { webServer: WebServerLike; connection: ConnectionLike }
    const acceptor = createUpgradeAcceptor(config.maxFrameBytes)
    const clients = new Set<AudioSocket>()
    const token = createRouteToken()
    const journal = injected.realtime.journal
    // The token travels in a URL query, and this route records request targets, so the journal has to be
    // able to redact it before it records one. This is exactly why `addSecrets` is additive instead of a
    // constructor argument: the plugin that mints the token is the only one that can name it, and it
    // mints it here, after the journal already exists.
    journal.addSecrets([token])
    // The injection event is declared by `@deepseek-ai/dsh-host-webserver`, which this package deliberately
    // does not import: importing it would augment `Context` with a second declaration of `webServer` and
    // turn the structural dependency above into a compile error. The name is cast at this one boundary.
    const onInjection = ctx.on as unknown as (
      name: string,
      listener: (table: InjectedGlobalRow[]) => void,
    ) => unknown

    ctx.effect(() => {
      // The page is told where the route is and what to present. The web server gathers this table on every
      // index render and every worker boot-payload request, so the row is built at emit time — the only
      // moment the listening port is known for certain, since an index render follows the listen.
      onInjection('webserver/index-inject', (table) => {
        table.push(routeInjectionRow(
          config.path,
          routeAuthority(services.webServer.config?.host, services.webServer.listenedPort),
          token,
        ))
      })
      const unregisterDiagnostics = services.webServer.register(diagnosticsRoute({
        path: config.diagnosticsPath,
        token,
        rejectionFor: (request) => services.connection.requestRejection(request),
        journal,
      }))
      const unregister = services.webServer.registerUpgrade({
        path: config.path,
        handler: (req, socket, head) => {
          // Upgrade requests never reach the web server's HTTP route handlers, so nothing else answers for
          // them. Without this check the route would be an unauthenticated loopback endpoint carrying
          // microphone audio in and the agent's answers out. DSH's own transport asks the connection
          // service in exactly this position, so this route asks the same question rather than inventing a
          // second scheme that would drift from it.
          //
          // The token is the one addition, and it is not a second scheme. The desktop app's page is served
          // from `dsh-app://app`, so its requests to loopback are cross-site and the harness's
          // `SameSite=Strict` cookie cannot travel; without the token that page is refused forever, however
          // correct the rest of the client half is.
          // Normalised once, at the caller's edge, so no record below repeats the check. `node:http`
          // always reports a target on a server request; the type admits `undefined` for client requests,
          // which this handler cannot see.
          const target = req.url ?? ''
          const rejection = verdictFor(
            services.connection.requestRejection(req),
            tokenFromUrl(req.url),
            token,
          )
          if (rejection !== undefined) {
            // The verdict only, and no target. A valid token is never rejected — it overrides the
            // refusal — so any target recorded here belongs to something else, and a wrong token is
            // still a credential. Retaining a caller's secret in order to log a refusal is a worse trade
            // than losing which path was probed.
            journal.record('socket.rejected', { verdict: String(rejection) })
            rejectUpgrade(socket, rejection)
            return
          }
          acceptor.handleUpgrade(req, socket, head, (client) => {
            if (clients.size >= config.maxConnections) {
              // 1013 = try again later. Closing the newcomer leaves the existing microphone live.
              journal.record('socket.rejected', { verdict: '1013', reason: 'busy' })
              client.close(1013, 'busy')
              return
            }
            clients.add(client)
            // The target here, because an accepted request is the one place this process's own token
            // travels: the app page presents it in the query precisely because it cannot carry the
            // cookie. The journal redacts it on write — which is what the token was added to the journal's
            // secrets for, and the reason that has to be additive rather than a constructor argument,
            // since the token does not exist until this plugin applies.
            journal.record('socket.accepted', { clients: String(clients.size), url: target })
            // Ask for the session before the bridge goes in, so the first frames are written into a session
            // that is being opened rather than dropped by the mic seam's no-session rule.
            if (config.openSessionOnConnect) ctx.emit('realtime-agent/start')
            attachAudioSocket(client, {
              emitMic: (pcm16) => { ctx.emit('realtime-agent/mic', pcm16) },
              subscribeAudio: (listener) => ctx.on('realtime-agent/audio', listener),
              maxFrameBytes: config.maxFrameBytes,
              onDetach: () => {
                clients.delete(client)
                journal.record('socket.closed', { clients: String(clients.size) })
                // The last client leaving ends the session. This also covers the transport's own disposal,
                // which terminates its clients — so a profile reload does not leave a session nobody holds.
                if (config.openSessionOnConnect && clients.size === 0) ctx.emit('realtime-agent/stop')
              },
            })
          })
        },
      })
      return async () => {
        unregister()
        unregisterDiagnostics()
        for (const client of clients) client.terminate()
        clients.clear()
        await acceptor.close()
      }
    }, `realtime-audio-ws: ${config.path}`)
  })
}
