import { describe, expect, it } from 'vitest'
import {
  KNOWN_SERVER_EVENT_TYPES,
  contextAppend,
  inputAudioAppend,
  inputAudioMute,
  inputAudioUnmute,
  isKnownServerEvent,
  parseServerEvent,
  sessionClose,
  sessionStart,
} from '../src/wire.ts'

const parse = (frame: string) => JSON.parse(frame) as Record<string, unknown>

describe('parseServerEvent', () => {
  it('returns the frame when it carries a non-empty string type', () => {
    expect(parseServerEvent('{"type":"session.started"}')).toEqual({ type: 'session.started' })
  })

  it('returns null for anything that is not JSON', () => {
    expect(parseServerEvent('not json')).toBeNull()
    expect(parseServerEvent('')).toBeNull()
  })

  it('returns null for JSON that is not a plain object', () => {
    expect(parseServerEvent('[]')).toBeNull()
    expect(parseServerEvent('null')).toBeNull()
    expect(parseServerEvent('42')).toBeNull()
    expect(parseServerEvent('"session.started"')).toBeNull()
  })

  it('returns null when the type is absent, empty, or not a string', () => {
    expect(parseServerEvent('{}')).toBeNull()
    expect(parseServerEvent('{"type":""}')).toBeNull()
    expect(parseServerEvent('{"type":7}')).toBeNull()
  })

  it('passes an unknown type through, so the caller ignores it rather than throwing', () => {
    // A provider may add event types. Treating that as a session failure would turn provider drift
    // into an outage; the drift canary is what turns it into a signal.
    const event = parseServerEvent('{"type":"session.something.new","x":1}')
    expect(event).not.toBeNull()
    expect(isKnownServerEvent(event!)).toBe(false)
  })

  it('recognises every type this adapter claims to read', () => {
    for (const type of KNOWN_SERVER_EVENT_TYPES) {
      const event = parseServerEvent(JSON.stringify({ type }))
      expect(event).not.toBeNull()
      expect(isKnownServerEvent(event!)).toBe(true)
    }
  })
})

describe('sessionStart', () => {
  it('opens with client delegation, which is the mode this adapter answers in', () => {
    const frame = parse(sessionStart('gpt-live-1'))
    expect(frame).toEqual({
      type: 'session.start',
      session: { model: 'gpt-live-1', delegation: { type: 'client' } },
    })
  })

  it('omits audio and instructions rather than sending undefined', () => {
    // The endpoint rejects unknown fields, so a stray null is a failed session, not a default.
    const frame = parse(sessionStart('gpt-live-1', undefined, undefined))
    const session = frame.session as Record<string, unknown>
    expect('audio' in session).toBe(false)
    expect('instructions' in session).toBe(false)
  })

  it('carries an explicit voice and instructions when supplied', () => {
    const frame = parse(sessionStart('gpt-live-1', 'Be brief.', 'marin'))
    expect(frame.session).toEqual({
      model: 'gpt-live-1',
      instructions: 'Be brief.',
      audio: { output: { voice: 'marin' } },
      delegation: { type: 'client' },
    })
  })

  it('sends instructions even when empty, so a caller cannot silently get the provider default', () => {
    const frame = parse(sessionStart('gpt-live-1', '', undefined))
    expect((frame.session as Record<string, unknown>).instructions).toBe('')
  })
})

describe('client frames', () => {
  it('appends audio as base64 under the verified field name', () => {
    expect(parse(inputAudioAppend('AAA='))).toEqual({ type: 'session.input_audio.append', audio: 'AAA=' })
  })

  it('has mute and unmute and no end-of-utterance call', () => {
    expect(parse(inputAudioMute())).toEqual({ type: 'session.input_audio.mute' })
    expect(parse(inputAudioUnmute())).toEqual({ type: 'session.input_audio.unmute' })
    // `session.input_audio.commit` is deliberately absent: it does not exist, and endpointing is the
    // provider's. A builder for it would invite a competing turn boundary.
    expect(JSON.stringify([inputAudioMute(), inputAudioUnmute(), sessionClose()])).not.toContain('commit')
  })

  it('builds all three context appends with a correlation id and an explicit null delegation', () => {
    expect(parse(contextAppend('commentary', 'done', 'item_1', 'evt_1'))).toEqual({
      type: 'session.commentary.append',
      content: 'done',
      delegation_id: 'item_1',
      event_id: 'evt_1',
    })
    expect(parse(contextAppend('thinking', 'working', null, 'evt_2'))).toEqual({
      type: 'session.thinking.append',
      content: 'working',
      delegation_id: null,
      event_id: 'evt_2',
    })
    expect(parse(contextAppend('instructions', 'be terse', null, 'evt_3'))).toEqual({
      type: 'session.instructions.append',
      content: 'be terse',
      delegation_id: null,
      event_id: 'evt_3',
    })
  })

  it('closes with the verified close event', () => {
    expect(parse(sessionClose())).toEqual({ type: 'session.close' })
  })
})
