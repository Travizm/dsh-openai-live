/**
 * The route's page-side settings, exercised as pure functions.
 *
 * These two decisions — the authority the page is told, and whether a presented token overrides the
 * connection service — are what decide whether the desktop app's page can use the route at all. They are
 * pinned here rather than only through a socket, because a wrong answer in either looks identical to a
 * host that refused the connection.
 */

import { describe, expect, it } from 'vitest'
import {
  INJECTED_KEY,
  TOKEN_PARAM,
  createRouteToken,
  routeAuthority,
  routeInjectionRow,
  tokenFromUrl,
  tokenMatches,
  verdictFor,
} from '../src/injection.ts'

describe('routeAuthority', () => {
  it('is undefined before the server is listening', () => {
    expect(routeAuthority('127.0.0.1', undefined)).toBeUndefined()
  })

  it('pairs the configured host with the port actually listening', () => {
    expect(routeAuthority('127.0.0.1', 19387)).toBe('127.0.0.1:19387')
  })

  it('normalises a wildcard bind to loopback, because the page is on this machine', () => {
    expect(routeAuthority('0.0.0.0', 19387)).toBe('127.0.0.1:19387')
    expect(routeAuthority('::', 19387)).toBe('127.0.0.1:19387')
  })

  it('treats an absent or empty host as loopback', () => {
    expect(routeAuthority(undefined, 1)).toBe('127.0.0.1:1')
    expect(routeAuthority('', 1)).toBe('127.0.0.1:1')
  })

  it('brackets an IPv6 literal so the authority parses as a URL', () => {
    expect(routeAuthority('::1', 19387)).toBe('[::1]:19387')
  })
})

describe('createRouteToken', () => {
  it('is URL-safe and long enough not to be guessed', () => {
    expect(createRouteToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('differs every time', () => {
    expect(createRouteToken()).not.toBe(createRouteToken())
  })
})

describe('tokenFromUrl', () => {
  it('reads the parameter', () => {
    expect(tokenFromUrl(`/dsh-realtime/audio?${TOKEN_PARAM}=abc`)).toBe('abc')
  })

  it('ignores other parameters around it', () => {
    expect(tokenFromUrl(`/x?a=1&${TOKEN_PARAM}=abc&b=2`)).toBe('abc')
  })

  it('is undefined without a query, without the parameter, or when empty', () => {
    expect(tokenFromUrl('/x')).toBeUndefined()
    expect(tokenFromUrl('/x?a=1')).toBeUndefined()
    expect(tokenFromUrl(`/x?${TOKEN_PARAM}=`)).toBeUndefined()
    expect(tokenFromUrl(undefined)).toBeUndefined()
  })
})

describe('tokenMatches', () => {
  it('accepts the process token and refuses every other', () => {
    const own = createRouteToken()
    expect(tokenMatches(own, own)).toBe(true)
    expect(tokenMatches(undefined, own)).toBe(false)
    expect(tokenMatches(createRouteToken(), own)).toBe(false)
  })

  it('refuses a different-length token instead of throwing, which timingSafeEqual would', () => {
    // The length check is not a nicety: timingSafeEqual throws on mismatched buffers, so without it a
    // one-character probe would become a crashed request handler rather than a refusal.
    expect(tokenMatches('short', createRouteToken())).toBe(false)
  })
})

describe('verdictFor', () => {
  const token = createRouteToken()

  it('accepts whatever the connection service accepted', () => {
    expect(verdictFor(undefined, undefined, token)).toBeUndefined()
  })

  it('keeps the verdict the service reported when no token is presented', () => {
    expect(verdictFor(401, undefined, token)).toBe(401)
    expect(verdictFor(403, undefined, token)).toBe(403)
  })

  it('overrides the verdict for a caller presenting the injected token', () => {
    expect(verdictFor(401, token, token)).toBeUndefined()
  })

  it('does not override it for a wrong token', () => {
    expect(verdictFor(401, createRouteToken(), token)).toBe(401)
  })
})

describe('routeInjectionRow', () => {
  it('publishes the settings under the global the client half reads', () => {
    expect(routeInjectionRow('/p', '127.0.0.1:1', 'tok')).toEqual({
      kind: 'global',
      name: INJECTED_KEY,
      value: { path: '/p', authority: '127.0.0.1:1', token: 'tok' },
    })
  })

  it('carries a missing authority as absent, which is the case the client half names', () => {
    expect(routeInjectionRow('/p', undefined, 'tok').value).toEqual({
      path: '/p',
      authority: undefined,
      token: 'tok',
    })
  })
})
