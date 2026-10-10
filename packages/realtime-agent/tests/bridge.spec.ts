import { describe, expect, it } from 'vitest'
import { MAX_APPEND_CHARS } from 'dsh-realtime'
import { answerDelegation, boundAppend, toSpeech, UNANSWERED_NOTICE, type DelegationAsker } from '../src/bridge.ts'
import type { AgentTranscriptLine } from '../src/types.ts'

/** A session that records what was appended to it. */
function recorder(): {
  appends: Array<{ kind: 'commentary' | 'thinking'; text: string; delegationId: string | undefined }>
  session: {
    id: string
    appendCommentary(text: string, delegationId?: string): Promise<void>
    appendThinking(text: string, delegationId?: string): Promise<void>
  }
} {
  const appends: Array<{ kind: 'commentary' | 'thinking'; text: string; delegationId: string | undefined }> = []
  return {
    appends,
    session: {
      id: 'sess-1',
      appendCommentary(text, delegationId) {
        appends.push({ kind: 'commentary', text, delegationId })
        return Promise.resolve()
      },
      appendThinking(text, delegationId) {
        appends.push({ kind: 'thinking', text, delegationId })
        return Promise.resolve()
      },
    },
  }
}

const DELEGATION = { id: 'item_1', target: 'client', offsetMs: 4800 } as const
const TRANSCRIPT: AgentTranscriptLine[] = [{ kind: 'input', text: 'is staging ok?' }]
const TIMEOUT_MS = 50

const run = async (ask: DelegationAsker, timeoutMs: number = TIMEOUT_MS) => {
  const { appends, session } = recorder()
  await answerDelegation(session, DELEGATION, TRANSCRIPT, ask, timeoutMs, () => undefined)
  return appends
}

/** The same call with the acknowledgements kept, which is not the same thing as deliveries. */
const runRecordingAcks = async (ask: DelegationAsker) => {
  const { session } = recorder()
  const acknowledged: string[] = []
  await answerDelegation(session, DELEGATION, TRANSCRIPT, ask, TIMEOUT_MS,
    (append, delegationId) => { acknowledged.push(`${append}:${delegationId}`) })
  return acknowledged
}

describe('acknowledgements', () => {
  it('reports an accepted append, for the delegation it was for', async () => {
    const acknowledged = await runRecordingAcks(
      () => Promise.resolve({ text: 'staging is green', mode: 'spoken' }),
    )

    // The acknowledgement and nothing more: it says the provider took the append, not that anyone
    // heard it. That distinction is the whole of invariant 6, and a row of the fault matrix.
    expect(acknowledged).toEqual(['commentary:item_1'])
  })

  it('acknowledges the notice it speaks when there is no answer to give', async () => {
    // The empty answer takes a different append and is still an acknowledgement — the provider
    // accepted it. Reporting nothing here would hide the case the matrix exists to separate.
    const acknowledged = await runRecordingAcks(() => Promise.resolve(undefined))

    expect(acknowledged).toEqual(['commentary:item_1'])
  })
})

describe('boundAppend', () => {
  it('leaves text within the bound untouched', () => {
    expect(boundAppend('short', 100)).toBe('short')
    expect(boundAppend('short', 5)).toBe('short')
  })

  it('cuts over-long text and marks it, within the bound', () => {
    const result = boundAppend('x'.repeat(5000))
    expect(result.length).toBe(MAX_APPEND_CHARS)
    expect(result.endsWith('[truncated]')).toBe(true)
  })

  it('degrades to the marker prefix when the ceiling is shorter than the marker', () => {
    // The contract is "never longer than maxChars", and it has to hold for every ceiling, not just
    // the one the seam happens to use.
    const result = boundAppend('x'.repeat(5000), 5)
    expect(result.length).toBe(5)
    expect(' [truncated]'.startsWith(result)).toBe(true)
  })
})

describe('toSpeech', () => {
  it('drops fence lines and keeps what they enclosed', () => {
    // A fence is markup; the snippet inside it is content, and dropping content would be the shaper
    // deciding what the answer meant.
    expect(toSpeech('before\n```json\n{"a":1}\n```\nafter')).toBe('before\n{"a":1}\nafter')
  })

  it('drops the markers a speaker would have read out', () => {
    expect(toSpeech('# Heading\n> quoted\n- bullet\n1. ordered\n2) also ordered'))
      .toBe('Heading\nquoted\nbullet\nordered\nalso ordered')
  })

  it('drops a thematic break, which is a line of nothing else', () => {
    expect(toSpeech('above\n\n---\n\nbelow')).toBe('above\n\nbelow')
  })

  it('says a link text rather than its target', () => {
    // The measured case: the target was a file path, and it was read out character by character.
    expect(toSpeech('From [package.json](/Users/asd/dev/dsh-openai-live/package.json#L3):'))
      .toBe('From package.json:')
    expect(toSpeech('![diagram](https://example.com/x.png)')).toBe('diagram')
  })

  it('drops the markers of emphasis and inline code', () => {
    expect(toSpeech('**0.6.6.** and *emphasis* and `code`')).toBe('0.6.6. and emphasis and code')
  })

  it('leaves an underscore alone, because a word is likelier than emphasis', () => {
    // Deliberate omission, and the reason is the cost of guessing wrongly: `_emphasis_` and
    // `dsh_openai_live` are the same shape, and unscrambling the second corrupts a name.
    expect(toSpeech('the dsh_openai_live package')).toBe('the dsh_openai_live package')
  })

  it('leaves a bare URL alone, because it is the author own text', () => {
    // The instruction is what should have kept it out of an answer meant for an ear.
    expect(toSpeech('see https://example.com/docs for more')).toBe('see https://example.com/docs for more')
  })

  it('collapses the whitespace the removals leave behind', () => {
    expect(toSpeech('a    b\t\tc\n\n\n\nd')).toBe('a b c\n\nd')
  })

  it('is idempotent, so a second pass cannot keep eating a reply', () => {
    const once = toSpeech('**0.6.6.**\n\nFrom [x](/y):\n\n- one')
    expect(toSpeech(once)).toBe(once)
  })

  it('reshapes the answer that was actually read out, into something an ear can take', () => {
    // Verbatim from a live relay, before this existed: markdown, a link whose target is a file path, and
    // a fenced json block, all of it spoken character for character. The snippet still reads oddly — the
    // frame on the relayed request is what should stop it being written — but nothing is markup now.
    const measured = '**0.6.6.**\n\nFrom [dsh-openai-live/package.json](/Users/asd/dev/dsh-openai-live/package.json#L3):\n\n```json\n"name": "dsh-openai-live",\n"version": "0.6.6",\n```'
    expect(toSpeech(measured))
      .toBe('0.6.6.\n\nFrom dsh-openai-live/package.json:\n\n"name": "dsh-openai-live",\n"version": "0.6.6",')
  })
})

describe('answerDelegation', () => {
  it('speaks an answer marked spoken', async () => {
    const appends = await run(() => ({ text: 'Staging is green.', mode: 'spoken' }))
    expect(appends).toEqual([{ kind: 'commentary', text: 'Staging is green.', delegationId: 'item_1' }])
  })

  it('shapes a spoken answer, because that channel is read out loud', async () => {
    const appends = await run(() => ({ text: '**Green** on [staging](/deploys/1).', mode: 'spoken' }))
    expect(appends).toEqual([{ kind: 'commentary', text: 'Green on staging.', delegationId: 'item_1' }])
  })

  it('leaves the silent channel alone, because it is context rather than speech', async () => {
    // The same text, deliberately unshaped: markdown is a perfectly good way to hand a model a snippet,
    // and a reply that is never spoken has no ear to be noise in.
    const appends = await run(() => ({ text: '**Green** on [staging](/deploys/1).' }))
    expect(appends).toEqual([{ kind: 'thinking', text: '**Green** on [staging](/deploys/1).', delegationId: 'item_1' }])
  })

  it('shapes before it bounds, so the truncation marker is never reshaped away', async () => {
    const appends = await run(() => ({ text: `**${'y'.repeat(MAX_APPEND_CHARS + 500)}**`, mode: 'spoken' }))
    expect(appends[0]!.text.length).toBe(MAX_APPEND_CHARS)
    expect(appends[0]!.text.endsWith('[truncated]')).toBe(true)
  })

  it('defaults to silent, so an answer is not announced unless it asked to be', async () => {
    const appends = await run(() => ({ text: 'Deployed 12:04.' }))
    expect(appends).toEqual([{ kind: 'thinking', text: 'Deployed 12:04.', delegationId: 'item_1' }])
  })

  it('honours an explicit silent mode', async () => {
    const appends = await run(() => ({ text: 'Noted.', mode: 'silent' }))
    expect(appends).toEqual([{ kind: 'thinking', text: 'Noted.', delegationId: 'item_1' }])
  })

  it('carries the delegation id back, so the answer correlates with the ask', async () => {
    const appends = await run(() => ({ text: 'ok', mode: 'spoken' }))
    expect(appends[0]!.delegationId).toBe('item_1')
  })

  it('trims an answer before delivering it', async () => {
    const appends = await run(() => ({ text: '   padded   ', mode: 'spoken' }))
    expect(appends[0]!.text).toBe('padded')
  })

  it('cuts an over-long answer to the seam bound rather than letting the append throw', async () => {
    const appends = await run(() => ({ text: 'y'.repeat(MAX_APPEND_CHARS + 500), mode: 'spoken' }))
    expect(appends[0]!.text.length).toBe(MAX_APPEND_CHARS)
  })

  it('tells the model plainly when every responder declined', async () => {
    const appends = await run(() => undefined)
    expect(appends).toEqual([{ kind: 'commentary', text: UNANSWERED_NOTICE, delegationId: 'item_1' }])
  })

  it('treats an empty answer as a decline', async () => {
    const appends = await run(() => ({ text: '' }))
    expect(appends[0]!.text).toBe(UNANSWERED_NOTICE)
  })

  it('treats a whitespace-only answer as a decline', async () => {
    const appends = await run(() => ({ text: '   ' }))
    expect(appends[0]!.text).toBe(UNANSWERED_NOTICE)
  })

  it('treats a responder that throws synchronously as a decline, not an exception', async () => {
    const appends = await run(() => { throw new Error('responder exploded') })
    expect(appends).toEqual([{ kind: 'commentary', text: UNANSWERED_NOTICE, delegationId: 'item_1' }])
  })

  it('treats a responder that rejects as a decline', async () => {
    const appends = await run(() => Promise.reject(new Error('responder rejected')))
    expect(appends).toEqual([{ kind: 'commentary', text: UNANSWERED_NOTICE, delegationId: 'item_1' }])
  })

  it('treats a malformed answer as a decline rather than delivering nonsense', async () => {
    const appends = await run((() => ({ text: 42 })) as unknown as DelegationAsker)
    expect(appends).toEqual([{ kind: 'commentary', text: UNANSWERED_NOTICE, delegationId: 'item_1' }])
  })

  it('tells the model plainly when no responder answers within the bound', async () => {
    const appends = await run(
      () => new Promise(resolve => { setTimeout(() => { resolve({ text: 'too late' }) }, 60) }),
      5,
    )
    expect(appends).toEqual([{ kind: 'commentary', text: UNANSWERED_NOTICE, delegationId: 'item_1' }])
  })

  it('asks with the delegation, the session and the conversation reconstructed so far', async () => {
    const seen: unknown[] = []
    await run((request) => { seen.push(request); return { text: 'ok' } })
    expect(seen).toEqual([{
      id: 'item_1',
      offsetMs: 4800,
      transcript: TRANSCRIPT,
      sessionId: 'sess-1',
    }])
  })
})
