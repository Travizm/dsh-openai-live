/**
 * The client half's URL derivation, as pure functions.
 *
 * This is where the desktop app was broken, and it was broken *quietly*: the app's page is served from
 * `dsh-app://app`, whose host is the literal string `app`, so the client derived `ws://app/...` — a name
 * that resolves nowhere — and the resulting failure read exactly like the host refusing the connection.
 * Every branch below is a boundary between "open a socket" and "name the real cause".
 */

import { describe, expect, it } from 'vitest'
import { type LocationLike, pageAuthority, socketUrl, withToken } from '../src/client/index.ts'

const http: LocationLike = { protocol: 'http:', host: '127.0.0.1:19387' }
const https: LocationLike = { protocol: 'https:', host: 'example.test' }
const app: LocationLike = { protocol: 'dsh-app:', host: 'app' }

describe('pageAuthority', () => {
  it('reads the authority of an http or https page', () => {
    expect(pageAuthority(http)).toBe('127.0.0.1:19387')
    expect(pageAuthority(https)).toBe('example.test')
  })

  it('refuses a custom-scheme page, whose host resolves nowhere', () => {
    // `ws://app/...` is the bug this line exists to make impossible to ship again.
    expect(pageAuthority(app)).toBeUndefined()
  })

  it('is undefined without a page, or with an empty host', () => {
    expect(pageAuthority(undefined)).toBeUndefined()
    expect(pageAuthority({ protocol: 'http:', host: '' })).toBeUndefined()
  })
})

describe('socketUrl', () => {
  it('prefers an injected authority over the page it is running in', () => {
    expect(socketUrl(app, '/dsh-realtime/audio', '127.0.0.1:19387'))
      .toBe('ws://127.0.0.1:19387/dsh-realtime/audio')
  })

  it('falls back to an http page and reads its own authority', () => {
    expect(socketUrl(http, '/p')).toBe('ws://127.0.0.1:19387/p')
  })

  it('follows an https page to wss, because the browser blocks ws as mixed content', () => {
    expect(socketUrl(https, '/p')).toBe('wss://example.test/p')
  })

  it('is undefined for a custom-scheme page with nothing injected', () => {
    expect(socketUrl(app, '/p')).toBeUndefined()
  })

  it('ignores an empty injected authority rather than building a URL on it', () => {
    expect(socketUrl(http, '/p', '')).toBe('ws://127.0.0.1:19387/p')
  })
})

describe('withToken', () => {
  it('attaches the token as a query parameter', () => {
    expect(withToken('ws://h/p', 'abc')).toBe('ws://h/p?t=abc')
  })

  it('escapes a token, so a value from elsewhere cannot reshape the URL', () => {
    expect(withToken('ws://h/p', 'a b&c')).toBe('ws://h/p?t=a%20b%26c')
  })

  it('returns the URL untouched when there is no token to attach', () => {
    expect(withToken('ws://h/p', undefined)).toBe('ws://h/p')
    expect(withToken('ws://h/p', '')).toBe('ws://h/p')
  })
})
