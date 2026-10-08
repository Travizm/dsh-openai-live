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
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
// Type-only: pulls the `Events` augmentation that declares the two audio events this package bridges.
import type {} from 'dsh-realtime-agent'
import { attachAudioSocket } from './bridge.ts'
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
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_OPEN_SESSION_ON_CONNECT,
  DEFAULT_PATH,
  type AudioSocket,
  type RealtimeAudioWsConfig,
} from './types.ts'

export * from './types.ts'
export { attachAudioSocket, toBytes, type AudioSocketBridgeDeps } from './bridge.ts'
export { createUpgradeAcceptor, rejectUpgrade, type UpgradeAcceptor } from './upgrade.ts'

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
})

/**
 * The slice of the web server's route registry this package claims.
 *
 * Structural rather than imported: `@deepseek-ai/dsh-host-webserver` is a DeepSeek package, and importing
 * it would both add a dependency edge for one shape and augment `Context` with another declaration of
 * `webServer` — two declarations of one property with different types is a compile error.
 */
interface WebServerLike {
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
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
  ctx.inject(['connection', 'webServer'], (injected) => {
    const services = injected as unknown as { webServer: WebServerLike; connection: ConnectionLike }
    const acceptor = createUpgradeAcceptor(config.maxFrameBytes)
    const clients = new Set<AudioSocket>()
    const token = createRouteToken()
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
          const rejection = verdictFor(
            services.connection.requestRejection(req),
            tokenFromUrl(req.url),
            token,
          )
          if (rejection !== undefined) {
            rejectUpgrade(socket, rejection)
            return
          }
          acceptor.handleUpgrade(req, socket, head, (client) => {
            if (clients.size >= config.maxConnections) {
              // 1013 = try again later. Closing the newcomer leaves the existing microphone live.
              client.close(1013, 'busy')
              return
            }
            clients.add(client)
            // Ask for the session before the bridge goes in, so the first frames are written into a session
            // that is being opened rather than dropped by the mic seam's no-session rule.
            if (config.openSessionOnConnect) ctx.emit('realtime-agent/start')
            attachAudioSocket(client, {
              emitMic: (pcm16) => { ctx.emit('realtime-agent/mic', pcm16) },
              subscribeAudio: (listener) => ctx.on('realtime-agent/audio', listener),
              maxFrameBytes: config.maxFrameBytes,
              onDetach: () => {
                clients.delete(client)
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
        for (const client of clients) client.terminate()
        clients.clear()
        await acceptor.close()
      }
    }, `realtime-audio-ws: ${config.path}`)
  })
}
