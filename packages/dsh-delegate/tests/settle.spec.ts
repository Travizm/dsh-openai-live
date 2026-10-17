import { beforeEach, describe, expect, it } from 'vitest'
import { ask, resetQueues } from '../src/index.ts'
import type { FollowFrame, PromptRequestMirror, SessionControllerLike } from '../src/index.ts'

const request = (id = 's1'): PromptRequestMirror => ({
  requestId: 'req-1', sessionId: id, mode: 'queue', content: [{ type: 'text', text: '[user] hi' }],
})

const committed = (seq: number, text: string): FollowFrame[] => [
  { type: 'event', event: { type: 'assistant/message', seq, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } } },
  { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq } } },
]

/** A controller whose follow stream is whatever the test says it is. */
function controller(
  frames: FollowFrame[] | 'hold',
  options: { log?: string[]; rejectPrompt?: boolean } = {},
): SessionControllerLike {
  return {
    async prompt() {
      if (options.rejectPrompt) throw new Error('admission refused')
      options.log?.push('prompt')
      return { accepted: true }
    },
    async *follow(_request, signal) {
      options.log?.push('follow')
      if (frames === 'hold') {
        // Never finishes on its own: the only way out is the abort. An already-aborted signal must throw here
        // too — a listener added after the abort never fires, which is a hang rather than a failure.
        if (signal.aborted) throw new Error('aborted')
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
        return
      }
      for (const frame of frames) yield frame
    },
  }
}

beforeEach(() => { resetQueues() })

describe('ask', () => {
  it('returns the answer from the committed record', async () => {
    await expect(ask(controller(committed(4, 'probe one.')), request())).resolves.toEqual({ kind: 'answer', text: 'probe one.' })
  })

  it('subscribes to the stream before admitting, so no frame is missed', async () => {
    // The harness can emit the instant the prompt is accepted; a follower that subscribes afterwards races it.
    const log: string[] = []
    const c: SessionControllerLike = {
      async prompt() { log.push('prompt'); return {} },
      async *follow() { log.push('follow'); yield* committed(1, 'ok') },
    }
    await ask(c, request())
    expect(log).toEqual(['follow', 'prompt'])
  })

  it('reports an abandoned attempt as a coded failure', async () => {
    const c: SessionControllerLike = {
      async prompt() { return {} },
      async *follow() { yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'abandoned' } } } },
    }
    await expect(ask(c, request())).resolves.toMatchObject({ kind: 'failure', code: 'ATTEMPT_ABANDONED' })
  })

  it('reports a commit it cannot read as unresolved', async () => {
    const c: SessionControllerLike = {
      async prompt() { return {} },
      async *follow() { yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 } } } },
    }
    await expect(ask(c, request())).resolves.toMatchObject({ kind: 'failure', code: 'ANSWER_UNRESOLVED' })
  })

  it('reports a stream that ends without a terminal frame, rather than hanging', async () => {
    await expect(ask(controller([]), request())).resolves.toEqual({
      kind: 'failure', code: 'ANSWER_UNRESOLVED', message: 'the follow stream ended without a terminal frame',
    })
  })

  it('times out with a coded failure instead of waiting forever', async () => {
    // The timers are injected: a turn budget test that sleeps is a test that fails on a loaded machine.
    const result = await ask(controller('hold'), request(), {
      timeoutMs: 50,
      setTimeoutFn: fn => { void Promise.resolve().then(fn); return 1 },
      clearTimeoutFn: () => {},
    })
    expect(result).toMatchObject({ kind: 'failure', code: 'TURN_TIMEOUT' })
    expect(result.kind === 'failure' ? result.message : '').toContain('50 ms')
  })

  it('rethrows a failure that is not a timeout, rather than mislabelling it', async () => {
    // An admission rejected by the harness is not a timeout, and reporting it as one would send a caller to
    // tune a budget that was never the problem.
    const c: SessionControllerLike = {
      async prompt() { throw new Error('admission refused') },
      async *follow() { yield* committed(1, 'never reached') },
    }
    await expect(ask(c, request())).rejects.toThrow('admission refused')
  })

  it('serialises per session, so two callers cannot interleave into one trajectory', async () => {
    // Measure the property, do not infer it from log order: two turns in one session must never be in flight at
    // once, and a concurrency counter is the only assertion that cannot be satisfied by the wrong behaviour.
    let inFlight = 0
    let maxInFlight = 0
    const c: SessionControllerLike = {
      async prompt() { return {} },
      async *follow(_r, _s) {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          // Hold the turn open across a macrotask, so an unserialised pair would overlap here.
          await new Promise(resolve => setTimeout(resolve, 5))
          yield* committed(1, 'ok')
        } finally {
          inFlight -= 1
        }
      },
    }
    const results = await Promise.all([ask(c, request('s1')), ask(c, request('s1')), ask(c, request('s1'))])
    expect(results.map(result => result.kind)).toEqual(['answer', 'answer', 'answer'])
    expect(maxInFlight).toBe(1)
  })

  it('does not let a rejected turn poison the queue behind it', async () => {
    const log: string[] = []
    let first = true
    const c: SessionControllerLike = {
      async prompt() { if (first) { first = false; throw new Error('one-shot failure') } log.push('prompt'); return {} },
      async *follow() { yield* committed(1, 'second answer') },
    }
    const failed = ask(c, request('s2'))
    const next = ask(c, request('s2'))
    await expect(failed).rejects.toThrow('one-shot failure')
    await expect(next).resolves.toEqual({ kind: 'answer', text: 'second answer' })
    expect(log).toEqual(['prompt'])
  })

  it('resets its queues, so an unloaded plugin leaves nothing behind', async () => {
    await ask(controller(committed(1, 'ok')), request())
    resetQueues()
    await expect(ask(controller(committed(1, 'ok again')), request())).resolves.toEqual({ kind: 'answer', text: 'ok again' })
  })
})
