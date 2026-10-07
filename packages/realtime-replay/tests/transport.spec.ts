import { describe, expect, it } from 'vitest'
import type { RealtimeTransportHandlers } from 'dsh-realtime-openai'
import { ReplayTransportFactory } from '../src/transport.ts'
import type { RecordedFrame } from '../src/types.ts'

/** Wait for the transport's scheduled delivery to run. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function collector() {
  const messages: string[] = []
  const closes: Array<{ code: number; reason: string }> = []
  const errors: Error[] = []
  const handlers: RealtimeTransportHandlers = {
    onMessage: frame => messages.push(frame),
    onClose: (code, reason) => closes.push({ code, reason }),
    onError: error => errors.push(error),
  }
  return { handlers, messages, closes, errors }
}

const frame = (t: number, event: Record<string, unknown>): RecordedFrame => ({ t, event })

describe('ReplayTransportFactory', () => {
  it('records the endpoint and headers without connecting anywhere', async () => {
    const transports = new ReplayTransportFactory([frame(0, { type: 'session.started' })])
    const { handlers } = collector()
    await transports.connect('wss://replay.invalid/x', { Authorization: 'Bearer placeholder' }, handlers)
    expect(transports.urls).toEqual(['wss://replay.invalid/x'])
    expect(transports.headers[0]).toEqual({ Authorization: 'Bearer placeholder' })
    expect(transports.closed).toBe(false)
  })

  it('delivers the recording in order', async () => {
    const transports = new ReplayTransportFactory([
      frame(0, { type: 'session.started' }),
      frame(10, { type: 'session.usage.updated', usage: { seconds: 1 } }),
    ])
    const { handlers, messages } = collector()
    await transports.connect('wss://x', {}, handlers)
    expect(messages).toEqual([]) // nothing before the caller has had a chance to speak
    await tick()
    expect(messages.map(message => (JSON.parse(message) as { type: string }).type))
      .toEqual(['session.started', 'session.usage.updated'])
  })

  it('records every client frame it is given', async () => {
    const transports = new ReplayTransportFactory([])
    const { handlers } = collector()
    const transport = await transports.connect('wss://x', {}, handlers)
    transport.send('{"type":"session.start"}')
    transport.send('{"type":"session.input_audio.append","audio":"AA=="}')
    expect(transports.sent).toHaveLength(2)
    await tick()
  })

  it('stops playback once the session has released the transport', async () => {
    // Faithful to a real transport: once the peer has gone, nothing more arrives.
    const transports = new ReplayTransportFactory([
      frame(0, { type: 'session.closed', reason: 'done' }),
      frame(10, { type: 'session.usage.updated', usage: { seconds: 9 } }),
    ])
    const { handlers, messages } = collector()
    const transport = await transports.connect('wss://x', {}, handlers)
    transport.close()
    await tick()
    expect(messages).toEqual([])
    expect(transports.closed).toBe(true)
  })

  it('answers a client context append, echoing the correlation id', async () => {
    const transports = new ReplayTransportFactory([])
    const { handlers, messages } = collector()
    const transport = await transports.connect('wss://x', {}, handlers)
    transport.send('{"type":"session.commentary.append","content":"x","event_id":"evt_1"}')
    expect(messages).toEqual([]) // acknowledged on a macrotask, never before the send returns
    await tick()
    expect(JSON.parse(messages[0] ?? '{}')).toEqual({
      type: 'session.commentary.appended',
      client_event_id: 'evt_1',
    })
  })

  it('answers an append that carries no correlation id without inventing one', async () => {
    const transports = new ReplayTransportFactory([])
    const { handlers, messages } = collector()
    const transport = await transports.connect('wss://x', {}, handlers)
    transport.send('{"type":"session.thinking.append","content":"x"}')
    await tick()
    expect(JSON.parse(messages[0] ?? '{}')).toEqual({ type: 'session.thinking.appended' })
  })

  it('does not answer a client frame that is not a context append', async () => {
    const transports = new ReplayTransportFactory([])
    const { handlers, messages } = collector()
    const transport = await transports.connect('wss://x', {}, handlers)
    transport.send('{"type":"session.input_audio.append","audio":"AA=="}')
    transport.send('{"type":"session.input_audio.mute"}')
    transport.send('not json at all')
    transport.send('{"noType":true}')
    transport.send('"a string"')
    await tick()
    expect(messages).toEqual([])
  })

  it('withholds an acknowledgement once the transport is closed', async () => {
    const transports = new ReplayTransportFactory([])
    const { handlers, messages } = collector()
    const transport = await transports.connect('wss://x', {}, handlers)
    transport.send('{"type":"session.commentary.append","content":"x"}')
    transport.close()
    await tick()
    expect(messages).toEqual([])
  })
})
