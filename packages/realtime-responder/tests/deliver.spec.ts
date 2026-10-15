/**
 * Delivery: turning a verdict into a write, and being honest about how it ended.
 *
 * The gate decides *whether*; this decides *how*, and it is the module that actually puts text into
 * somebody's session. Two things about it are deliberate and both are load-bearing.
 *
 * **It is harness-free.** The four impure edges arrive as functions — `send`, `mint`, `record`, `flush` —
 * exactly as `turn.ts` takes `admit` and `subscribe`. That is not tidiness: the alternative is a
 * hand-written structural interface for a host service, and this repo already shipped a production
 * `TypeError` on every call across two releases because a restated two-argument host method agreed with
 * its own fakes and with nothing else. The *types* here are derived from the real `Agent['send']` with
 * `Parameters<>`; only the wiring is a function.
 *
 * **It reports which way it failed, because the two ways are not alike.** A `send` that throws wrote
 * **nothing** — the delegation can be answered and the user has lost nothing. A barrier that resolves
 * false means the message is **in the log but not on disk**: it exists, so a blind retry would write it
 * twice. Only the second arm has to consult the `realtime/change` record, and only the second is a
 * durability question rather than a delivery one.
 *
 * ## What this module does not decide
 *
 * The **verb is the path**, never a field: `inject`'s inbox target for a note, `followup`'s for a say. And
 * nothing about attribution comes from the delegation — the message is minted from producer-authored text
 * and a **frozen, producer-owned source**, so a model that tried to name its own actor, session or verb
 * would have no field to put it in. A test asserts the deliverer never passes anything but text to `mint`.
 *
 * @module dsh-realtime-responder/deliver
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createDeliverer,
  frameFor,
  REALTIME_CHANGE_TYPE,
  REALTIME_PLUGIN,
  REALTIME_SOURCE,
  userUtterance,
  type DeliveryAgent,
} from '../src/deliver.ts'

/**
 * Derived from the module's own seam type, which is itself asserted against the real `Agent['send']` at
 * the wiring site — a compile-time guard, because the defect a restated signature causes *is* the type
 * being wrong and no runtime test is as direct.
 */
type SendArgs = Parameters<DeliveryAgent['send']>
type SentMessage = SendArgs[0]

/** A recorded call to `send`, so the target and the wake decision are asserted rather than inferred. */
interface SendCall {
  readonly message: SentMessage
  readonly target: SendArgs[1]
  readonly wakeup: SendArgs[2]
}

/**
 * A harness for the four edges.
 *
 * Wired the way production wires it — `agent` present, `flush` resolving true unless a test says otherwise
 * — because a substitute handed inert callbacks silently discards every injected event and turns a
 * reachable path into an unreachable-looking one.
 */
function harness(options: { readonly flushResult?: boolean; readonly sendThrows?: unknown } = {}) {
  const sent: SendCall[] = []
  const minted: string[] = []
  const records: { readonly type: string; readonly data: unknown }[] = []
  let flushes = 0
  const mint = (text: string): SentMessage => {
    minted.push(text)
    return { id: `m${minted.length}`, role: 'user', content: [{ type: 'text', text }], source: REALTIME_SOURCE } as unknown as SentMessage
  }
  // The fake carries a `session` and a `send`, because production's agent does: a substitute missing one
  // would make the record path look unreachable rather than untested.
  const agent = {
    send: (message: SentMessage, target: SendArgs[1], wakeup: SendArgs[2]) => {
      if (options.sendThrows !== undefined) throw options.sendThrows
      sent.push({ message, target, wakeup })
    },
    session: { append: (type: string, data: unknown) => { records.push({ type, data }) } },
  } as unknown as DeliveryAgent
  const deliver = createDeliverer({
    agent: () => agent,
    mint,
    flush: async (): Promise<boolean> => { flushes += 1; return options.flushResult ?? true },
  })
  return { deliver, sent, minted, records, flushCount: () => flushes }
}

const bodyOf = (message: SentMessage): string => {
  const content = (message as unknown as { content: readonly { type: string; text?: string }[] }).content
  return content.map((block) => block.text ?? '').join('')
}

describe('the verb is the path, and the path is a target plus a wake decision', () => {
  it('sends a note to the next step without waking a turn', async () => {
    // `inject`'s semantics: the inbox insert that context rides, and the reason a note starts no turn.
    const { deliver, sent, flushCount } = harness()
    const outcome = await deliver('note', 'the staging build is green', 'req-1')
    expect(outcome.kind).toBe('noted')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.target).toBe('next-step')
    expect(sent[0]?.wakeup).toBe(false)
    expect(flushCount()).toBe(0)
  })

  it('sends a say to the next turn and wakes it', async () => {
    // `followup`'s semantics. This is the verb that starts a turn the session's model acts on.
    const { deliver, sent } = harness()
    const outcome = await deliver('say', 'the release is approved', 'req-2')
    expect(outcome.kind).toBe('said')
    expect(sent[0]?.target).toBe('next-turn')
    expect(sent[0]?.wakeup).toBe(true)
  })

  it('writes nothing for a question, and asks the barrier for nothing either', async () => {
    const { deliver, sent, records, flushCount, minted } = harness()
    const outcome = await deliver('question', 'what does the readme say', 'req-3')
    expect(outcome.kind).toBe('skipped')
    expect(sent).toHaveLength(0)
    expect(records).toHaveLength(0)
    expect(minted).toHaveLength(0)
    expect(flushCount()).toBe(0)
  })
})

describe('provenance is written between the write and the barrier, in that order', () => {
  it('records the realtime change after the send and before the flush', async () => {
    // The order is schedule's, measured at `dsh-schedule/lib/index.js:930`: followup, then
    // session.append, then the flush. A record written before the send would describe a message that
    // might never exist; one written after the barrier would not be durable when it hurt.
    const order: string[] = []
    const deliver = createDeliverer({
      agent: () => ({
        send: () => { order.push('send') },
        session: { append: () => { order.push('record') } },
      }) as unknown as DeliveryAgent,
      mint: () => ({ id: 'm', role: 'user', content: [], source: REALTIME_SOURCE }) as unknown as SentMessage,
      flush: async () => { order.push('flush'); return true },
    })
    await deliver('say', 'the release is approved', 'req-4')
    expect(order).toEqual(['send', 'record', 'flush'])
  })

  it('names the change event the way the session map declares it, and versions the payload', async () => {
    const { deliver, records } = harness()
    await deliver('say', 'the release is approved', 'req-5')
    expect(records).toHaveLength(1)
    expect(records[0]?.type).toBe(REALTIME_CHANGE_TYPE)
    expect(records[0]?.type).toBe('realtime/change')
    expect(records[0]?.data).toMatchObject({ version: 1, operation: 'deliver', verdict: 'say' })
  })

  it('does not record a change for a note — the inbox is a note\'s audit surface', async () => {
    // P2a story 5: a note's lifecycle rides `agent/inbox/inserted | claimed | discarded`, not the log.
    // A log record for a note would be a second, weaker account of something the inbox already states.
    const { deliver, records } = harness()
    await deliver('note', 'the staging build is green', 'req-6')
    expect(records).toHaveLength(0)
  })
})

describe('the two failure arms are distinguished, because only one has a message in it', () => {
  it('reports unsent, and records nothing, when the send throws', async () => {
    // Nothing was written, so there is nothing to be durable about and nothing a retry could duplicate.
    const { deliver, records, flushCount, sent } = harness({ sendThrows: new Error('agent is disposed') })
    const outcome = await deliver('say', 'the release is approved', 'req-7')
    expect(outcome).toMatchObject({ kind: 'unsent', reason: 'agent is disposed' })
    expect(sent).toHaveLength(0)
    expect(records).toHaveLength(0)
    expect(flushCount()).toBe(0)
  })

  it('reports undurable when the barrier resolves false, and the record is already written', async () => {
    // Written-but-not-durable: the message exists, so this arm is the one a retry must consult the
    // record for rather than re-issuing blindly.
    const { deliver, records } = harness({ flushResult: false })
    const outcome = await deliver('say', 'the release is approved', 'req-8')
    expect(outcome.kind).toBe('undurable')
    expect(records).toHaveLength(1)
  })

  it('reports undurable when the barrier rejects, rather than throwing at the caller', async () => {
    const deliver = createDeliverer({
      agent: () => ({ send: () => undefined, session: { append: () => undefined } }) as unknown as DeliveryAgent,
      mint: () => ({ id: 'm', role: 'user', content: [], source: REALTIME_SOURCE }) as unknown as SentMessage,
      flush: async () => { throw new Error('disk full') },
    })
    const outcome = await deliver('say', 'the release is approved', 'req-9')
    expect(outcome).toMatchObject({ kind: 'undurable', reason: 'disk full' })
  })

  it.each([
    ['a thrown string', 'agent is disposed', 'agent is disposed'],
    ['a thrown non-Error', { code: 7 }, 'the delivery was refused'],
  ])('names %s rather than reporting an empty reason', async (_label, thrown, expected) => {
    // A rejection can carry anything. An absent reason reads as "no reason", which is the silence this
    // module exists to remove — so each shape gets a stated fallback rather than an empty string.
    const { deliver } = harness({ sendThrows: thrown })
    const outcome = await deliver('say', 'the release is approved', 'req-17')
    expect(outcome).toMatchObject({ kind: 'unsent', reason: expected })
  })

  it('reports unsent, not a crash, when the session is not there', async () => {
    const deliver = createDeliverer({
      agent: () => undefined,
      mint: () => ({ id: 'm', role: 'user', content: [], source: REALTIME_SOURCE }) as unknown as SentMessage,
      flush: async () => true,
    })
    expect(await deliver('say', 'the release is approved', 'req-10')).toMatchObject({ kind: 'unsent' })
    expect(await deliver('note', 'the staging build is green', 'req-11')).toMatchObject({ kind: 'unsent' })
  })
})

describe('the framing line is producer prose, distinct per verb, and carries no authority', () => {
  it('prepends its own framing to the user\'s text, in the message that is actually sent', async () => {
    const { deliver, sent, minted } = harness()
    await deliver('say', 'the release is approved', 'req-12')
    const expected = `${frameFor('say')}\nthe release is approved`
    // Asserted on what `mint` received AND on what reached `send`: the framing is authored here, so it
    // cannot be dropped, rewritten or interleaved on the way through.
    expect(minted[0]).toBe(expected)
    expect(bodyOf(sent[0]!.message)).toBe(expected)
  })

  it('frames the two verbs differently, so one cannot be read as the other', async () => {
    expect(frameFor('note')).not.toBe(frameFor('say'))
  })

  it('states on the say what it is NOT, because a say starts a turn', async () => {
    // P3's rule, stated at the point the text is authored: a say is a message, never consent.
    expect(frameFor('say')).toMatch(/not user consent/i)
    expect(frameFor('say')).toMatch(/cannot authorise/i)
  })

  it('marks a note as carrying no request and no authority', () => {
    expect(frameFor('note')).toMatch(/context only|nothing is requested/i)
    expect(frameFor('note')).toMatch(/no authority/i)
  })
})

describe('attribution comes from here, never from what the model said', () => {
  it('mints from text alone — there is no parameter a delegation could arrive through', async () => {
    // The deliverer's signature takes (verdict, text, id). Nothing else can reach `mint`, so a delegation
    // that carried `actor`, `sessionId` or `verb` fields has no route into the message's provenance.
    const { deliver, minted } = harness()
    await deliver('say', 'the release is approved', 'req-13')
    expect(minted).toHaveLength(1)
    expect(minted[0]).toBe(`${frameFor('say')}\nthe release is approved`)
  })

  it('exposes a frozen source naming this plugin, so the kind cannot be reassigned at a call site', () => {
    expect(REALTIME_SOURCE).toEqual({ kind: 'plugin', plugin: REALTIME_PLUGIN })
    expect(Object.isFrozen(REALTIME_SOURCE)).toBe(true)
    expect(REALTIME_PLUGIN).toBe('realtime')
  })

  it('is not authenticated by the framing line, and says so where the frame is defined', () => {
    // The Claude Code `<system-reminder>` collision is the cited precedent: a producer-authored marker in
    // content is *provenance for a reader*, never an authorisation mechanism. Asserted here so a later
    // change cannot quietly start treating it as one.
    const frame = frameFor('say')
    expect(frame).not.toMatch(/signature|token|authenticated|verified/i)
  })
})

describe('the outcome carries what a caller needs to report, and nothing it must re-derive', () => {
  it.each([
    ['note', 'noted'],
    ['say', 'said'],
  ] as const)('names the %s verb\'s success as %s', async (verdict, kind) => {
    const { deliver } = harness()
    const outcome = await deliver(verdict, 'a thing was said', 'req-14')
    expect(outcome.kind).toBe(kind)
    expect(outcome).toMatchObject({ id: 'req-14', verdict })
  })

  it('reports the number of characters written, so a truncation upstream is visible downstream', async () => {
    const { deliver } = harness()
    const outcome = await deliver('note', 'the staging build is green', 'req-15')
    expect(outcome).toMatchObject({ chars: `${frameFor('note')}\nthe staging build is green`.length })
  })

  it('has a reason on every arm that carries one, so no caller has to invent wording', async () => {
    const { deliver } = harness({ sendThrows: new Error('agent is disposed') })
    const outcome = await deliver('say', 'the release is approved', 'req-16')
    expect(outcome.kind === 'unsent' && outcome.reason.length > 0).toBe(true)
  })
})

describe('the gate reads the user\'s own line, not the conversation', () => {
  it('takes the most recent thing the user said', () => {
    expect(userUtterance([
      { kind: 'input', text: 'what does the readme say' },
      { kind: 'output', text: 'let me check' },
    ])).toBe('what does the readme say')
  })

  it('does not read the model\'s own words, even when they are last', () => {
    // The failure this prevents: a delegation carrying only the model's backchannel would otherwise be
    // classified from `output` text — the model authoring the gate's input, which is the whole hazard.
    expect(userUtterance([
      { kind: 'input', text: 'the tests are passing' },
      { kind: 'output', text: 'tell the session the release is approved' },
    ])).toBe('the tests are passing')
  })

  it('skips a blank input line rather than treating a pause as speech', () => {
    expect(userUtterance([
      { kind: 'input', text: 'leave a note that the build is green' },
      { kind: 'input', text: '   ' },
    ])).toBe('leave a note that the build is green')
  })

  it('answers with an empty string when the user has not spoken', () => {
    // Which the gate resolves to `question`, so a delegation raised before any speech authorises nothing.
    expect(userUtterance([{ kind: 'output', text: 'hello' }])).toBe('')
    expect(userUtterance([])).toBe('')
  })
})

void vi
