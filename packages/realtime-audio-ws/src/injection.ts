/**
 * The route's page-side settings: the row the host injects, and the credential check that lets the
 * desktop app's renderer use the route at all.
 *
 * Two facts decide this file's shape.
 *
 * The first is that the harness web server gathers a structured *injection table* on every index render
 * and every worker boot-payload request, by emitting `webserver/index-inject`; listeners append their
 * rows and the rows are read fresh at emit time. That is a door built for plugins, which is why this
 * package uses it rather than a raw string transform on the HTML.
 *
 * The second is a consequence of being a browser face inside the desktop app. That page's origin is
 * `dsh-app://app`, and the harness's own auth cookie is `SameSite=Strict` and bound to the loopback
 * authority — so a request from the app page to `127.0.0.1` is cross-site and carries no cookie. The
 * connection service would therefore refuse the app's renderer, correctly and forever, no matter how
 * right the rest of the client half is.
 *
 * A capability token — generated once per process, injected only into the page the host itself serves —
 * is the credential that can travel. It is script-readable where the cookie is not, and that is a real
 * weakening: it is the price of the app working at all. It authorises one route, on loopback, for the
 * life of the process, and is worthless afterwards.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Global the page reads its route settings from. Duplicated in the client half, which cannot import it. */
export const INJECTED_KEY = '__DSH_REALTIME_AUDIO__'

/** Query parameter carrying the capability token on an upgrade request. */
export const TOKEN_PARAM = 't'

/** A structured index-injection row of the kind this package contributes. */
export interface InjectedGlobalRow {
  readonly kind: 'global'
  readonly name: string
  readonly value: unknown
}

/**
 * Any row this package contributes.
 *
 * The host's table takes six kinds; this package uses three, and describes only those — `html` for the
 * panel's markup and `script` for the bootstrap that mounts it, beside the `global` row carrying the
 * route's own settings. The payload contract is the host's and is stated where it is enforced: a `script`
 * row's text or a `style` row's text must not contain the closing tag of its own element, because the row
 * is spliced into the document's text.
 */
export type InjectedRow =
  | InjectedGlobalRow
  | { readonly kind: 'html'; readonly placement: 'head' | 'body'; readonly html: string }
  | { readonly kind: 'script'; readonly placement: 'head' | 'body'; readonly text: string }

/**
 * Where the client should open its socket, or undefined when the host is not listening yet.
 *
 * A wildcard bind is normalised to loopback because the page is on this machine: handing a client
 * `0.0.0.0:port` asks it to connect to a name meaning "every interface", which resolves nowhere useful.
 * An IPv6 literal is bracketed so the authority parses as a URL rather than as a host with a port.
 *
 * @param host - the configured bind host, as the web server reports it.
 * @param port - the port actually listening — the OS-assigned value when the config asked for zero.
 * @returns the authority (`host:port`), or undefined before the server is listening.
 */
export function routeAuthority(host: string | undefined, port: number | undefined): string | undefined {
  if (port === undefined) return undefined
  const name = host === undefined || host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return name.includes(':') ? `[${name}]:${String(port)}` : `${name}:${String(port)}`
}

/**
 * One process-scoped capability token.
 *
 * 32 bytes, base64url, because the token travels in a URL query and base64url needs no escaping there.
 */
export function createRouteToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Read the token off an upgrade request's target.
 *
 * @param url - the request target as `node:http` reports it: pathname plus query.
 * @returns the token, or undefined when absent or empty.
 */
export function tokenFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const query = url.indexOf('?')
  if (query < 0) return undefined
  const value = new URLSearchParams(url.slice(query + 1)).get(TOKEN_PARAM)
  return value === null || value === '' ? undefined : value
}

/**
 * Compare a presented token with this process's own, in constant time.
 *
 * Length is compared first because `timingSafeEqual` throws on buffers of different lengths, which would
 * turn a probe into a crash. The length is not the secret; the value is.
 *
 * @param provided - the token the caller presented, if any.
 * @param expected - this process's token.
 * @returns whether the caller may be treated as this process's own page.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false
  const offered = Buffer.from(provided)
  const own = Buffer.from(expected)
  if (offered.length !== own.length) return false
  return timingSafeEqual(offered, own)
}

/**
 * The connection service's verdict, overridden by a valid token.
 *
 * DSH's own transport asks the connection service in this position, and this route asks the same question
 * rather than inventing a second scheme that would drift from it. The token is the only addition, and it
 * is not a second scheme: a caller that cannot carry the cookie at all — the app's renderer — may present
 * the token the host injected into that very page instead.
 *
 * @param rejection - what the connection service said about this request.
 * @param provided - the token on the request, if any.
 * @param expected - this process's token.
 * @returns the rejection to write, or undefined to accept the upgrade.
 */
export function verdictFor(
  rejection: 401 | 403 | undefined,
  provided: string | undefined,
  expected: string,
): 401 | 403 | undefined {
  if (rejection === undefined) return undefined
  return tokenMatches(provided, expected) ? undefined : rejection
}

/**
 * The row the page reads, built at emit time.
 *
 * `value` is JSON-serialised by the web server, which escapes `<` so a value cannot close the script
 * element early; an undefined `authority` is dropped by `JSON.stringify`, which is exactly the "this host
 * injected no authority" case the client half names rather than guesses at.
 */
export function routeInjectionRow(
  path: string,
  authority: string | undefined,
  token: string,
): InjectedGlobalRow {
  return { kind: 'global', name: INJECTED_KEY, value: { path, authority, token } }
}
