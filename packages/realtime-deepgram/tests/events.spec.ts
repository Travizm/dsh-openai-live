import { describe, expect, it } from 'vitest'
import {
  toInjectionRefusal,
  toLatency,
  toProviderError,
  toTranscript,
  toUpdateAck,
} from '../src/index.ts'

describe('toTranscript', () => {
  it('maps a user utterance to an input transcript and an assistant one to output', () => {
    expect(toTranscript({ type: 'ConversationText', role: 'user', content: 'Say exactly: probe one.' }))
      .toEqual({ kind: 'input', text: 'Say exactly: probe one.', final: true })
    expect(toTranscript({ type: 'ConversationText', role: 'assistant', content: 'probe one.' }))
      .toEqual({ kind: 'output', text: 'probe one.', final: true })
  })

  it('always marks the fragment final, because this provider does not send partials', () => {
    // A consumer that received `final: false` here would concatenate consecutive utterances into one — which on
    // this provider merges two different things that were said.
    expect(toTranscript({ type: 'ConversationText', role: 'assistant', content: 'a whole sentence' })?.final).toBe(true)
  })

  it('ignores frames that are not utterances, and utterances it cannot read', () => {
    expect(toTranscript({ type: 'AgentAudioDone' })).toBeUndefined()
    expect(toTranscript({ type: 'ConversationText', role: 'system', content: 'x' })).toBeUndefined()
    expect(toTranscript({ type: 'ConversationText', role: 'assistant', content: '   ' })).toBeUndefined()
    expect(toTranscript({ type: 'ConversationText', role: 'assistant' })).toBeUndefined()
  })
})

describe('toLatency', () => {
  it('converts the provider\'s seconds to milliseconds, per stage', () => {
    const latency = toLatency({
      type: 'LatencyReport',
      total_latency: 0.512,
      ttt_token_latency: 0.449,
      tts_latency: 0.063,
    })
    expect(latency).toEqual({ totalMs: 512, firstTokenMs: 449, speakMs: 63 })
  })

  it('falls back to the text-boundary figure when the token figure is absent', () => {
    // The provider sends both in one turn and sometimes only one; `ttt_text_latency` is the sibling of the token
    // figure and the next best measurement of the same thing.
    expect(toLatency({ type: 'LatencyReport', ttt_text_latency: 0.456 })).toEqual({ firstTokenMs: 456 })
  })

  it('returns nothing when no stage number is present, rather than an empty measurement', () => {
    // `{}` would be counted as a sample by anything that averages what it is given.
    expect(toLatency({ type: 'LatencyReport', something_new: 1 })).toBeUndefined()
    expect(toLatency({ type: 'LatencyReport', total_latency: -1 })).toBeUndefined()
    expect(toLatency({ type: 'Welcome' })).toBeUndefined()
  })

  it('omits stages the provider did not report', () => {
    expect(toLatency({ type: 'LatencyReport', total_latency: 0.5 })).toEqual({ totalMs: 500 })
  })
})

describe('toUpdateAck', () => {
  it('distinguishes the two acknowledgements, which are the boundary a turn must wait for', () => {
    // A turn started before the ack runs under the OLD prompt — proved on the wire during P1, where asking early
    // produced an answer carrying both the old and the new rule.
    expect(toUpdateAck({ type: 'PromptUpdated' })).toBe('prompt')
    expect(toUpdateAck({ type: 'ThinkUpdated' })).toBe('think')
  })

  it('says nothing for any other frame', () => {
    expect(toUpdateAck({ type: 'SettingsApplied' })).toBeUndefined()
  })
})

describe('toInjectionRefusal', () => {
  it('passes the provider\'s own reason through', () => {
    expect(toInjectionRefusal({ type: 'InjectionRefused', message: 'agent is speaking' })).toBe('agent is speaking')
  })

  it('supplies a reason when the provider gives none, so the caller is not left with an empty string', () => {
    expect(toInjectionRefusal({ type: 'InjectionRefused' })).toBe('the provider refused the injected message')
    expect(toInjectionRefusal({ type: 'InjectionRefused', message: '  ' })).toBe('the provider refused the injected message')
  })

  it('says nothing for a frame that is not a refusal', () => {
    expect(toInjectionRefusal({ type: 'AgentAudioDone' })).toBeUndefined()
  })
})

describe('toProviderError', () => {
  it('surfaces the description, which is the only reason the probe\'s settings mistake was findable', () => {
    expect(toProviderError({ type: 'Error', description: 'Check the agent.listen.provider.type field against the API spec.' }))
      .toContain('agent.listen.provider.type')
  })

  it('supplies a description when the provider gives none', () => {
    expect(toProviderError({ type: 'Error' })).toBe('the provider reported an error')
    expect(toProviderError({ type: 'Error', description: '' })).toBe('the provider reported an error')
  })

  it('says nothing for a frame that is not an error', () => {
    expect(toProviderError({ type: 'Welcome' })).toBeUndefined()
  })
})
