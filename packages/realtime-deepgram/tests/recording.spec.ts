import { describe, expect, it } from 'vitest'
import { RATES_SOURCE, VOICE_AGENT_RATES, audioMs, cost, summarise } from '../src/index.ts'
import type { RecordingEntry } from '../src/index.ts'

const entry = (at: number, direction: 'in' | 'out', kind: string, extra: Partial<RecordingEntry> = {}): RecordingEntry =>
  ({ at, direction, kind, ...extra })

describe('audioMs', () => {
  it('converts linear16 bytes to milliseconds at the declared rate', () => {
    // 24 kHz mono 16-bit: 48 bytes per millisecond.
    expect(audioMs(48_000, 24_000)).toBe(1000)
    expect(audioMs(63_360, 24_000)).toBeCloseTo(1320, 6)
  })

  it('accounts for channels', () => {
    expect(audioMs(96_000, 24_000, 2)).toBe(1000)
  })
})

describe('summarise', () => {
  it('says nothing about an empty recording rather than dividing by zero', () => {
    expect(summarise([])).toEqual({
      connectionMs: 0, framesIn: 0, outputAudioBytes: 0, framesOut: 0, inputAudioBytes: 0, transcripts: [],
    })
  })

  it('measures connection time from the first frame to the last', () => {
    // The billed quantity: Deepgram's Voice Agent bills websocket connection time, so this is the number that
    // turns into money.
    const summary = summarise([entry(1_000, 'out', 'Settings'), entry(13_000, 'in', 'ConversationText')])
    expect(summary.connectionMs).toBe(12_000)
  })

  it('separates input and output audio, and counts frames both ways', () => {
    const summary = summarise([
      entry(0, 'out', 'Settings'),
      entry(10, 'out', 'audio', { bytes: 640 }),
      entry(20, 'out', 'audio', { bytes: 640 }),
      entry(300, 'in', 'audio', { bytes: 4_800 }),
      entry(400, 'in', 'ConversationText', { text: "What's the weather?" }),
    ])
    expect(summary.framesOut).toBe(3)
    expect(summary.framesIn).toBe(2)
    expect(summary.inputAudioBytes).toBe(1_280)
    expect(summary.outputAudioBytes).toBe(4_800)
  })

  it('reports when the first audible response arrived, relative to the start', () => {
    // This is the number a caller feels: not "the turn took 1.9 s" but "the first sound came 1.9 s in".
    const summary = summarise([
      entry(5_000, 'out', 'Settings'),
      entry(5_400, 'in', 'SettingsApplied'),
      entry(6_900, 'in', 'audio', { bytes: 100 }),
    ])
    expect(summary.firstAudioMs).toBe(1_900)
  })

  it('omits the first-audio figure when no audio arrived, rather than reporting zero', () => {
    // Zero would read as "instant", which is the opposite of "nothing was ever spoken".
    expect('firstAudioMs' in summarise([entry(0, 'out', 'Settings')])).toBe(false)
  })

  it('collects the transcript text, not the frame type', () => {
    const summary = summarise([
      entry(0, 'in', 'ConversationText', { text: "What's the weather?" }),
      entry(1, 'in', 'ConversationText', { text: 'Please provide your location.' }),
    ])
    expect(summary.transcripts).toEqual(["What's the weather?", 'Please provide your location.'])
  })

  it('does not list an utterance twice when History echoes it', () => {
    // The provider emits `ConversationText` and then a `History` record carrying the same words. Reading text from
    // every frame that has it doubled a two-turn transcript to four lines on a real recording.
    const summary = summarise([
      entry(0, 'in', 'ConversationText', { text: "What's the weather?" }),
      entry(1, 'in', 'History', { text: "What's the weather?" }),
      entry(2, 'in', 'ConversationText', { text: 'No idea.' }),
      entry(3, 'in', 'History', { text: 'No idea.' }),
    ])
    expect(summary.transcripts).toEqual(["What's the weather?", 'No idea.'])
  })

  it('counts an audio frame with no byte count as zero rather than NaN', () => {
    // A recorder that failed to measure a frame must not poison every total downstream with NaN.
    const summary = summarise([
      entry(0, 'in', 'audio'),
      entry(1, 'in', 'audio', { bytes: 100 }),
      entry(2, 'out', 'audio'),
      entry(3, 'out', 'audio', { bytes: 50 }),
    ])
    expect(summary.outputAudioBytes).toBe(100)
    expect(summary.inputAudioBytes).toBe(50)
  })

  it('ignores frames with no bytes and no text', () => {
    const summary = summarise([entry(0, 'in', 'LatencyReport'), entry(1, 'in', 'UserStartedSpeaking')])
    expect(summary.outputAudioBytes).toBe(0)
    expect(summary.transcripts).toEqual([])
  })
})

describe('cost', () => {
  it('costs a session at the published rate for its tier', () => {
    // One minute at the BYO-LLM rate, which is A′'s composition.
    const summary = summarise([entry(0, 'out', 'Settings'), entry(60_000, 'in', 'ConversationText')])
    expect(cost(summary, 'byoLlm')).toBe(0.065)
  })

  it('costs a short session pro-rata on connection time', () => {
    const summary = summarise([entry(0, 'out', 'Settings'), entry(6_000, 'in', 'ConversationText')])
    expect(cost(summary, 'standard')).toBeCloseTo(0.0075, 6)
  })

  it('costs nothing for a recording with no elapsed time', () => {
    expect(cost(summarise([]), 'standard')).toBe(0)
  })

  it('carries the published rates, cheapest for the most bring-your-own', () => {
    expect(VOICE_AGENT_RATES.standard).toBe(0.075)
    expect(VOICE_AGENT_RATES.byoLlm).toBe(0.065)
    expect(VOICE_AGENT_RATES.byoLlmAndTts).toBe(0.05)
    // The ordering is the argument for A′: the more DSH owns, the less the socket costs.
    expect(VOICE_AGENT_RATES.byoLlmAndTts).toBeLessThan(VOICE_AGENT_RATES.byoLlm)
    expect(VOICE_AGENT_RATES.byoLlm).toBeLessThan(VOICE_AGENT_RATES.standard)
  })

  it('names where the rates came from, so a report can be traced back', () => {
    expect(RATES_SOURCE).toContain('deepgram.com/pricing')
  })
})
