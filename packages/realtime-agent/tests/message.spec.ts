/**
 * The voice's message: identity at construction, and immutability after it.
 *
 * This is the one place a message written into somebody's session is created, so the assertions here are
 * about the two properties nothing downstream can repair: **who wrote it**, and whether that can change.
 *
 * @module dsh-realtime-agent/tests/message
 */

import { describe, expect, it } from 'vitest'
import { mintVoiceMessage } from '../src/message.ts'
import { VOICE_PLUGIN, VOICE_SOURCE } from '../src/source.ts'

const textOf = (message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
  message.content.map((block) => block.text ?? '').join('')

describe('the message carries its producer, stamped at construction', () => {
  it('names this plugin as the source kind, so the log can tell it from the user typing', () => {
    // The whole point of the source: a voice message and a typed message are both user-role and both
    // actionable, and this field is the only thing that distinguishes them after the fact.
    expect(mintVoiceMessage('a note').source).toEqual({ kind: 'plugin', plugin: VOICE_PLUGIN })
  })

  it('is a user-role message, because that is the channel a session acts on', () => {
    expect(mintVoiceMessage('a note').role).toBe('user')
  })

  it('carries the text it was given, verbatim and alone', () => {
    // Framing is the caller's job — it is the responder's own prose about what the message is and is not.
    // Minting does not rewrite, trim or add to it.
    expect(textOf(mintVoiceMessage('the release is approved'))).toBe('the release is approved')
  })

  it('gives every message a distinct identity', () => {
    // The harness mints the id. Two messages with one id would make the log unable to name one of them, and
    // an idempotency check downstream would silently drop a genuine second write.
    expect(mintVoiceMessage('same text').id).not.toBe(mintVoiceMessage('same text').id)
  })

  it('is frozen, so the durable record cannot be rewritten after the event', () => {
    // A message in the log is re-read long after it was written, and its provenance is the field that has to
    // stay put for the record to mean anything.
    expect(Object.isFrozen(mintVoiceMessage('a note'))).toBe(true)
  })
})

describe('the source is one frozen value, not a shape rebuilt per call', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(VOICE_SOURCE)).toBe(true)
  })

  it('uses the general plugin kind rather than inventing a key', () => {
    // `plugin` is what `dsh-schedule` writes and what the runtime honours; a bespoke kind would be a key
    // nothing else understands.
    expect(VOICE_SOURCE.kind).toBe('plugin')
    expect(VOICE_PLUGIN).toBe('realtime')
  })
})
