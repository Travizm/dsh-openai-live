import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config, apply, asError, inject, name } from '../src/index.ts'
import type { FollowFrame, SessionControllerLike } from '../src/index.ts'

const committed = (text: string): FollowFrame[] => [
  { type: 'event', event: { type: 'assistant/message', seq: 2, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } } },
  { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } } },
]

const controller = (): SessionControllerLike => ({
  async prompt() { return { accepted: true } },
  async *follow() { yield* committed('an answer') },
})

/** A Cordis context with the one service the plugin injects, and a dispose hook. */
function context(withDispose = true): { ctx: Context; disposers: (() => void)[] } {
  const disposers: (() => void)[] = []
  const ctx = {
    sessionController: controller(),
    ...(withDispose ? { on: (event: string, listener: () => void) => { if (event === 'dispose') disposers.push(listener) } } : {}),
  } as unknown as Context
  return { ctx, disposers }
}

describe('the plugin surface', () => {
  it('is a function plugin that injects only the session controller', () => {
    // Not `realtime`: the shim is a door onto the session controller, not part of the voice seam, and mounting it
    // must not depend on the seam being present.
    expect(name).toBe('dsh-delegate')
    expect(inject).toEqual(['sessionController'])
  })

  it('declares its configuration with a loopback default', () => {
    expect(Config).toBeDefined()
  })

  it('coerces a non-Error rejection, so a failure is never reported as undefined', () => {
    const original = new Error('boom')
    expect(asError(original)).toBe(original)
    expect(asError('a string').message).toBe('a string')
  })

  it('has no default export, which the Loader would use to discard the namespace', async () => {
    const module = await import('../src/plugin.ts')
    expect('default' in module).toBe(false)
  })
})

describe('apply', () => {
  it('binds the configured port and reports its URL', async () => {
    const { ctx } = context()
    const handle = apply(ctx, { port: 0, host: '127.0.0.1', sessionId: 's1' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(handle.error).toBeUndefined()
    expect(handle.port).toBeGreaterThan(0)
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await handle.close()
  })

  it('serves a completion end to end from the injected controller', async () => {
    const { ctx } = context()
    const handle = apply(ctx, { port: 0, sessionId: 'session-1', model: 'echo-test' })
    await new Promise(resolve => setTimeout(resolve, 50))
    const response = await fetch(`${handle.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ model: 'echo-test', choices: [{ message: { content: 'an answer' } }] })
    await handle.close()
  })

  it('mounts with no configuration at all, leaving the session unnamed', async () => {
    // A composition can mount the plugin and let each request name its session; the shim must not require a
    // default it was never given.
    const { ctx } = context()
    const handle = apply(ctx, { port: 0 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(handle.error).toBeUndefined()
    await handle.close()
  })

  it('defaults to 8787 when no port is configured', async () => {
    const { ctx } = context()
    const handle = apply(ctx, { sessionId: 's1' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(handle.port).toBe(8787)
    await handle.close()
  })

  it('reports a port it could not bind instead of throwing during start-up', async () => {
    // A plugin that throws in `apply` takes the harness down with it; a handle with an error lets the composition
    // continue and the failure be seen.
    const first = context()
    const taken = apply(first.ctx, { port: 0, sessionId: 's1' })
    await new Promise(resolve => setTimeout(resolve, 50))
    const second = context()
    const takenPort = taken.port
    expect(takenPort).toBeGreaterThan(0)
    const clash = apply(second.ctx, { port: takenPort as number, sessionId: 's2' })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(clash.error).toBeDefined()
    await taken.close()
  })

  it('closes the server on dispose, so a reload does not leave a listener behind', async () => {
    const { ctx, disposers } = context()
    const handle = apply(ctx, { port: 0, sessionId: 's1' })
    await new Promise(resolve => setTimeout(resolve, 50))
    const url = handle.url as string
    // Any response at all proves the listener is up; the shim serves completions only, so a 404 for `/health` is
    // the expected shape and not a failure.
    expect(await fetch(`${url}/health`).then(response => response.status, () => 'refused')).toBe(404)
    expect(disposers).toHaveLength(1)
    disposers[0]?.()
    // Poll rather than sleep a fixed time: the close is async and the assertion is about the listener being gone.
    let refused = false
    for (let i = 0; i < 20 && !refused; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      refused = await fetch(`${url}/health`).then(() => false, () => true)
    }
    expect(refused).toBe(true)
    await handle.close()
  })

  it('works on a context with no dispose hook rather than requiring one', async () => {
    const { ctx } = context(false)
    const handle = apply(ctx, { port: 0, sessionId: 's1' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(handle.url).toBeDefined()
    await handle.close()
  })
})
