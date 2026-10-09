/**
 * The diagnostics route: the journal, served as JSON over the web server's route registry.
 *
 * S1 story 4. It exists so a failure can be read *after* the fact without a console attached — which is
 * the whole cost this project kept paying, an evening spent inferring a reason that was never written
 * down anywhere.
 *
 * ## The access policy is the audio route's, reused rather than re-derived
 *
 * The host's route registry "knows no harness concepts" and its handlers own the full response, so
 * nothing upstream answers the authentication question for us. The audio route already answers it in
 * this package: ask the connection service, and let the process's capability token override a refusal,
 * because the desktop app's page is served from `dsh-app://app` and is therefore cross-site to loopback
 * — it can never carry the harness's `SameSite=Strict` cookie. This route asks in the same position with
 * the same token: one policy, two doors. Inventing a second check here is how two schemes drift until
 * one of them is found holding the weaker answer.
 *
 * ## What it deliberately does not do
 *
 * It does not redact on the way out. The journal redacts on **write**, so there is no unredacted value
 * in the buffer to serve and no second step for a later edit to forget. A route that redacted at the
 * boundary would look safer and be strictly worse: the secret would already be retained, in memory and
 * in whatever the process dumps.
 *
 * @module dsh-realtime-audio-ws/diagnostics
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Journal } from 'dsh-realtime'
import { tokenFromUrl, verdictFor } from './injection.ts'

/**
 * The slice of the journal this route reads.
 *
 * Typed as the public surface rather than as the class: `Journal` exists as two declarations in this
 * repository — built `lib/` and `src/` — and a class with a private member is nominally typed, so the
 * two are not assignable to each other even though they are the same code.
 */
export type DiagnosticsJournal = Pick<Journal, 'snapshot' | 'size' | 'oldestSeq'>

/** What the route needs from the plugin that owns it. */
export interface DiagnosticsDeps {
  /** Absolute pathname to claim, no trailing slash — the registry's own contract. */
  readonly path: string
  /** This process's capability token, the same one the audio route publishes to the page. */
  readonly token: string
  /** The connection service's verdict for one request. */
  readonly rejectionFor: (request: { headers: IncomingMessage['headers'] }) => 401 | 403 | undefined
  /** The journal to serve. */
  readonly journal: DiagnosticsJournal
}

/** A route the host's registry accepts, described structurally as this package describes the registry. */
export interface DiagnosticsRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void
}

/**
 * Build the diagnostics route.
 * @param deps - the path to claim, this process's token, the connection service's verdict, and the journal.
 * @returns the route registration, ready for `webServer.register`.
 */
export function diagnosticsRoute(deps: DiagnosticsDeps): DiagnosticsRoute {
  return {
    kind: 'exact',
    path: deps.path,
    handler: (req, res) => {
      const rejection = verdictFor(deps.rejectionFor(req), tokenFromUrl(req.url), deps.token)
      if (rejection !== undefined) {
        // The status carries the verdict the connection service actually gave, so a reader can tell a
        // missing credential from a refused one rather than guessing from a generic failure.
        send(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      const entries = deps.journal.snapshot()
      // `size` and `oldestSeq` travel with the entries rather than being left for the reader to infer:
      // a truncated buffer and an idle one are the same empty-looking list otherwise, and the sequence
      // number is the only thing that separates "nothing happened" from "the buffer rolled over".
      send(res, 200, { size: deps.journal.size, oldestSeq: deps.journal.oldestSeq, entries })
    },
  }
}

/**
 * Write one JSON response.
 *
 * `no-store` on both branches. This response is a picture of a moving buffer, and a cached one would be
 * read as current — the same class of mistake as a journal that cannot show its own eviction.
 * @param res - the response this handler owns.
 * @param status - HTTP status to write.
 * @param body - value to serialise as the JSON body.
 */
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
