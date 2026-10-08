import { describe, expect, it } from 'vitest'
import { attachAudioSocket, toBytes } from '../src/bridge.ts'
import type { AudioSocket } from '../src/types.ts'

/**
 * A socket that records what it was asked to do, and lets a test play the server side of the wire.
 * Loose by construction and cast once: the bridge only ever calls `send`/`close`/`terminate`/`on`, and
 * pinning the fake to the interface's overloads buys nothing but noise.
 */
function fakeSocket() {
  const sent: Uint8Array[] = []
  const closed: { code: number | undefined; reason: string | undefined }[] = []
  let terminates = 0
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const socket = {
    send: (data: Uint8Array) => { sent.push(data) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    terminate: () => { terminates += 1 },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return socket
    },
  } as unknown as AudioSocket
  const fire = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  return { socket, sent, closed, fire, terminates: (): number => terminates }
}

const deps = (over: Partial<Parameters<typeof attachAudioSocket>[1]> = {}) => {
  const mic: Uint8Array[] = []
  const detached: number[] = []
  const unsubscribed: number[] = []
  let emit: ((pcm16: Uint8Array) => void) | undefined
  return {
    mic,
    detached,
    unsubscribed,
    /** Play the host side: deliver output audio as the bus event would. */
    output: (pcm16: Uint8Array): void => { emit?.(pcm16) },
    value: {
      emitMic: (pcm16: Uint8Array) => { mic.push(pcm16) },
      subscribeAudio: (listener: (pcm16: Uint8Array) => void) => {
        emit = listener
        return () => { unsubscribed.push(1) }
      },
      maxFrameBytes: 3,
      onDetach: () => { detached.push(1) },
      ...over,
    },
  }
}

describe('toBytes', () => {
  it('passes a Uint8Array straight through, and a Buffer is one', () => {
    const bytes = new Uint8Array([1, 2])
    expect(toBytes(bytes)).toBe(bytes)
    expect(Array.from(toBytes(Buffer.from([3, 4])))).toEqual([3, 4])
  })

  it('concatenates the fragment array ws produces for a fragmented frame', () => {
    // `ws` hands back RawData: assuming a single buffer is how a pipeline works small and corrupts large.
    expect(Array.from(toBytes([Buffer.from([1]), Buffer.from([2, 3])]))).toEqual([1, 2, 3])
  })

  it('wraps an ArrayBuffer', () => {
    expect(Array.from(toBytes(new Uint8Array([5, 6]).buffer))).toEqual([5, 6])
  })

  it('falls back to Buffer.from for any other raw source', () => {
    expect(Array.from(toBytes(new SharedArrayBuffer(2)))).toEqual([0, 0])
  })
})

describe('attachAudioSocket', () => {
  it('carries a binary frame to the microphone seam', () => {
    const { socket, fire } = fakeSocket()
    const harness = deps()
    attachAudioSocket(socket, harness.value)
    fire('message', Buffer.from([1, 2]), true)
    expect(harness.mic.map(frame => Array.from(frame))).toEqual([[1, 2]])
  })

  it('normalises a fragmented frame before emitting it', () => {
    const { socket, fire } = fakeSocket()
    const harness = deps()
    attachAudioSocket(socket, harness.value)
    fire('message', [Buffer.from([1]), Buffer.from([2, 3])], true)
    expect(harness.mic.map(frame => Array.from(frame))).toEqual([[1, 2, 3]])
  })

  it('ignores a text frame — nothing on this wire is JSON', () => {
    const { socket, fire } = fakeSocket()
    const harness = deps()
    attachAudioSocket(socket, harness.value)
    fire('message', Buffer.from('{"hello":true}'), false)
    expect(harness.mic).toEqual([])
  })

  it('sends host output audio to the client', () => {
    const { socket, sent } = fakeSocket()
    const harness = deps()
    attachAudioSocket(socket, harness.value)
    const pcm16 = new Uint8Array([7, 8])
    harness.output(pcm16)
    expect(sent).toEqual([pcm16])
  })

  it('drops output audio once the socket has gone, rather than buffering it', () => {
    const { socket, sent, fire } = fakeSocket()
    const harness = deps()
    attachAudioSocket(socket, harness.value)
    fire('close')
    harness.output(new Uint8Array([1]))
    expect(sent).toEqual([])
  })

  it('closes the connection on an oversized frame without emitting it', () => {
    const { socket, closed, fire } = fakeSocket()
    const harness = deps({ maxFrameBytes: 2 })
    attachAudioSocket(socket, harness.value)
    fire('message', Buffer.from([1, 2, 3]), true)
    expect(harness.mic).toEqual([])
    expect(closed).toEqual([{ code: 1009, reason: 'frame too large' }])
    expect(harness.detached).toHaveLength(1)
  })

  it('unsubscribes exactly once when close and error both arrive', () => {
    const { socket, fire } = fakeSocket()
    const harness = deps()
    attachAudioSocket(socket, harness.value)
    fire('close')
    fire('error', new Error('gone'))
    expect(harness.unsubscribed).toHaveLength(1)
    expect(harness.detached).toHaveLength(1)
  })

  it('stops and terminates on the returned disposer, even if it runs twice', () => {
    const { socket, terminates } = fakeSocket()
    const harness = deps()
    const dispose = attachAudioSocket(socket, harness.value)
    dispose()
    dispose()
    expect(harness.unsubscribed).toHaveLength(1)
    expect(harness.detached).toHaveLength(1)
    expect(terminates()).toBe(2)
  })
})
