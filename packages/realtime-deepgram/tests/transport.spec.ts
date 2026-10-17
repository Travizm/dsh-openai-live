import { describe, expect, it } from 'vitest'
import { openTransport } from '../src/index.ts'
import type { SocketLike, TransportHandlers } from '../src/index.ts'
import type { ServerFrame } from '../src/index.ts'

type Listener = (...args: never[]) => void

class FakeSocket implements SocketLike {
  readonly sent: (string | Uint8Array)[] = []
  closes = 0
  private readonly listeners = new Map<string, Listener[]>()

  send(data: string | Uint8Array): void { this.sent.push(data) }
  close(): void { this.closes += 1 }
  on(event: 'message' | 'close' | 'error', listener: Listener): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }
  emit(event: 'message' | 'close' | 'error', ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args)
  }
}

const recorder = (): TransportHandlers & { frames: ServerFrame[]; audio: Uint8Array[]; errors: Error[]; closes: (string | undefined)[] } => {
  const frames: ServerFrame[] = []
  const audio: Uint8Array[] = []
  const errors: Error[] = []
  const closes: (string | undefined)[] = []
  return {
    frames, audio, errors, closes,
    onFrame: frame => { frames.push(frame) },
    onAudio: bytes => { audio.push(bytes) },
    onError: error => { errors.push(error) },
    onClose: reason => { closes.push(reason) },
  }
}

describe('openTransport', () => {
  it('routes a text frame through the JSON parser to onFrame', () => {
    const socket = new FakeSocket()
    const handlers = recorder()
    openTransport(socket, handlers)
    socket.emit('message', '{"type":"SettingsApplied"}')
    expect(handlers.frames).toEqual([{ type: 'SettingsApplied' }])
  })

  it('routes a binary frame to onAudio as bytes, not through the parser', () => {
    // A transport that guessed would feed audio into JSON.parse, and the resulting error would look like a
    // protocol failure rather than a routing bug.
    const socket = new FakeSocket()
    const handlers = recorder()
    openTransport(socket, handlers)
    socket.emit('message', new Uint8Array([1, 2, 3]))
    expect(handlers.audio).toHaveLength(1)
    expect(Array.from(handlers.audio[0] ?? [])).toEqual([1, 2, 3])
    expect(handlers.errors).toHaveLength(0)
  })

  it('reports a frame that is neither text nor bytes', () => {
    const socket = new FakeSocket()
    const handlers = recorder()
    openTransport(socket, handlers)
    socket.emit('message', 42)
    expect(handlers.errors[0]?.message).toContain('neither text nor bytes')
  })

  it('reports unparseable text instead of dropping it', () => {
    // A provider that starts sending something else is a fact the session needs; silence is how it becomes a
    // mystery.
    const socket = new FakeSocket()
    const handlers = recorder()
    openTransport(socket, handlers)
    socket.emit('message', 'not json')
    expect(handlers.errors[0]?.message).toContain('not JSON')
  })

  it('passes a close reason through when the socket gave one', () => {
    const socket = new FakeSocket()
    const handlers = recorder()
    openTransport(socket, handlers)
    socket.emit('close', 'going away')
    expect(handlers.closes).toEqual(['going away'])
  })

  it('reports a close with no reason as undefined rather than an empty string', () => {
    const socket = new FakeSocket()
    const handlers = recorder()
    openTransport(socket, handlers)
    socket.emit('close')
    expect(handlers.closes).toEqual([undefined])
  })

  it('passes an Error through and wraps anything else', () => {
    const socket = new FakeSocket()
    const handlers = recorder()
    openTransport(socket, handlers)
    const original = new Error('socket died')
    socket.emit('error', original)
    socket.emit('error', 'a string')
    expect(handlers.errors[0]).toBe(original)
    expect(handlers.errors[1]?.message).toBe('a string')
  })

  it('serialises a client frame and sends audio as bytes', () => {
    const socket = new FakeSocket()
    const transport = openTransport(socket, recorder())
    transport.send({ type: 'KeepAlive' })
    transport.sendAudio(new Uint8Array([9]))
    expect(socket.sent[0]).toBe('{"type":"KeepAlive"}')
    expect(socket.sent[1]).toBeInstanceOf(Uint8Array)
  })

  it('refuses to send after it is closed, rather than writing into a dead socket', () => {
    const socket = new FakeSocket()
    const transport = openTransport(socket, recorder())
    void transport.close()
    expect(() => transport.send({ type: 'KeepAlive' })).toThrow('closed')
    expect(() => transport.sendAudio(new Uint8Array([1]))).toThrow('closed')
  })

  it('closes the socket once, however many times it is asked', async () => {
    const socket = new FakeSocket()
    const transport = openTransport(socket, recorder())
    await transport.close()
    await transport.close()
    expect(socket.closes).toBe(1)
  })

  it('treats a socket-initiated close as closed, so a later send does not write into it', async () => {
    const socket = new FakeSocket()
    const transport = openTransport(socket, recorder())
    socket.emit('close')
    expect(() => transport.send({ type: 'KeepAlive' })).toThrow('closed')
    await transport.close()
    expect(socket.closes).toBe(0)
  })
})
