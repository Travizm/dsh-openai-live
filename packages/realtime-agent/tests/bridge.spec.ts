import { describe, expect, it } from 'vitest'
import { MAX_APPEND_CHARS } from 'dsh-realtime'
import { answerDelegation, boundAppend, UNANSWERED_NOTICE, type DelegationAsker } from '../src/bridge.ts'
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
  await answerDelegation(session, DELEGATION, TRANSCRIPT, ask, timeoutMs)
  return appends
}

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

describe('answerDelegation', () => {
  it('speaks an answer marked spoken', async () => {
    const appends = await run(() => ({ text: 'Staging is green.', mode: 'spoken' }))
    expect(appends).toEqual([{ kind: 'commentary', text: 'Staging is green.', delegationId: 'item_1' }])
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
