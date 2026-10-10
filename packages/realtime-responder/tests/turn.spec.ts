import { describe, expect, it, vi } from 'vitest'
import type { DelegationRequest } from 'dsh-realtime-agent'
import { answerText, createTurnRunner, phraseTable, promptFrom, stepTool, type MilestonePolicy, type TurnDeps, type TurnStep } from '../src/turn.ts'
import type { SessionEventLike } from '../src/types.ts'

const request = (transcript: readonly { kind: 'input' | 'output'; text: string }[]): DelegationRequest => ({
  id: 'item_1',
  offsetMs: 0,
  sessionId: 'sess-1',
  transcript,
} as unknown as DelegationRequest)

/**
 * An appended assistant message, **shaped the way `session/event` actually delivers one**.
 *
 * There is no `sessionId` field, on purpose. The harness calls a `session/event` listener as
 * `(session, event)`: the owning session is the **first argument** and the event carries only
 * `{ type, seq, time, data }`. This helper used to attach a `sessionId` to the event, which is the shape
 * the `answerText` filter read — so the suite agreed with the code while the running plugin could never
 * match an answer and every delegated turn timed out. Doubles are wired as production wires them, or they
 * are a second bug wearing the first one's coat.
 */
const message = (content: unknown, turn = 1): SessionEventLike => ({
  type: 'assistant/message',
  surfaceOp: 'append',
  data: { turn, message: { content } },
})

/**
 * The session's own turn boundary.
 *
 * The runner answers only the turn its own admission started, so a test that expects an answer must open
 * that turn first — and must open it **after** the admission has settled, because a latch armed before
 * then would belong to whatever was already running. Production emits one of these on every turn; a
 * fixture that omits it is a fixture for a sequence that cannot happen.
 */
const turnStart = (turn = 1): SessionEventLike => ({ type: 'turn/start', data: { turn } })

/** The session these turns are admitted to. Supplied **beside** each event, never on it. */
const SESSION = 'sess-1'

const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value })

/** A frame short enough to leave room for the questions these tests ask. */
const FRAME = 'Relayed from the voice conversation.'

describe('promptFrom', () => {
  it('puts the frame in front of the conversation, joined in order with empty lines dropped', () => {
    expect(promptFrom(request([
      { kind: 'input', text: 'is staging ok?' },
      { kind: 'input', text: '' },
      { kind: 'output', text: 'checking' },
    ]), 1_000, FRAME)).toBe(`${FRAME}\nis staging ok?\nchecking`)
  })

  it('gives the question the room the frame leaves, so the whole prompt is inside the budget', () => {
    // The frame is part of what is admitted. A budget that counted the question alone would be a budget
    // the controller sees exceeded, by exactly the length of the frame.
    const prompt = promptFrom(request([{ kind: 'input', text: 'abcdefghijklmnop' }]), FRAME.length + 5, FRAME)
    expect(prompt).toBe(`${FRAME}\nabcd`)
    expect(prompt.length).toBeLessThanOrEqual(FRAME.length + 5)
  })

  it('truncates on the budget, because a rejected prompt is worse than a short one', () => {
    expect(promptFrom(request([{ kind: 'input', text: 'abcdefghij' }]), 4, FRAME)).toBe('abcd')
  })

  it('sends the bare question when the budget cannot carry the frame at all', () => {
    // Degradation rather than half-application: the frame is dropped whole, and it can never eat the
    // question it exists to introduce — the question is the part nothing downstream can reconstruct.
    expect(promptFrom(request([{ kind: 'input', text: 'abcdefghij' }]), FRAME.length, FRAME)).toBe('abcdefghij')
  })

  it('sends the bare question when no frame is configured', () => {
    expect(promptFrom(request([{ kind: 'input', text: 'is staging ok?' }]), 1_000, '')).toBe('is staging ok?')
  })

  it('yields nothing for a transcript that carried no text, frame or not', () => {
    // Framing must not manufacture a prompt out of silence. A turn with nothing to ask is **declined**
    // before the admission, and a prompt that was only the frame would have the controller admit one.
    expect(promptFrom(request([{ kind: 'input', text: '' }]), 100, FRAME)).toBe('')
  })

  it('counts a multibyte body against the same code-unit budget', () => {
    // Every CJK character here is one code unit, so the cut is three of them: the budget is a count of
    // code units, not of graphemes, and that is the bound the seam has always applied.
    expect(promptFrom(request([{ kind: 'input', text: '日本語のテキスト' }]), FRAME.length + 4, FRAME))
      .toBe(`${FRAME}\n日本語`)
  })
})

describe('answerText', () => {
  it('reads the text blocks of an appended assistant message', () => {
    expect(answerText(message([text('Staging is green.')]))).toBe('Staging is green.')
  })

  it('joins multiple text blocks in order', () => {
    expect(answerText(message([text('one'), text('two')]))).toBe('one\ntwo')
  })

  it('ignores anything that is not an assistant message', () => {
    expect(answerText({ type: 'assistant/chunk' })).toBeUndefined()
  })

  // Which session an answer belongs to is the **runner's** decision now, not this function's: the session
  // is not on the event, so a filter here could only ever have matched nothing. Covered in
  // `createTurnRunner` below, and again end-to-end in `plugin.spec.ts`.

  it('ignores a replayed message — only an append is news', () => {
    expect(answerText({ ...message([text('history')]), surfaceOp: 'replace' })).toBeUndefined()
  })

  it('ignores a payload with no content array', () => {
    expect(answerText({ type: 'assistant/message', surfaceOp: 'append' })).toBeUndefined()
    expect(answerText(message('not-an-array'))).toBeUndefined()
  })

  it('skips blocks that are not text — nulls, primitives, other kinds', () => {
    expect(answerText(message([
      null,
      'a bare string',
      { type: 'reasoning', text: 'thinking' },
      text('real'),
    ]))).toBe('real')
  })

  it('skips a text block whose text is not a string', () => {
    expect(answerText(message([{ type: 'text', text: 7 }, text('real')]))).toBe('real')
  })

  it('treats whitespace-only content as no answer at all', () => {
    expect(answerText(message([text('   ')]))).toBeUndefined()
  })
})

describe('stepTool', () => {
  it('names the tool a `tool/call` reports', () => {
    expect(stepTool({ type: 'tool/call', data: { name: 'read_file' } })).toBe('read_file')
  })

  it('needs no surface op, because a tool call is not a surface event', () => {
    // The trap this test exists for. `answerText` filters on `surfaceOp === 'append'`, and a filter copied
    // from it drops every step — silently and for ever — because `SurfaceEventType` is
    // `system/message · user/message · assistant/message · tool/result` and a `tool/call` is not among
    // them, so it carries no `surfaceOp` at all. The event type is the whole filter.
    expect(stepTool({ type: 'tool/call', data: { name: 'terminal' } })).toBe('terminal')
  })

  it('ignores every other kind of event', () => {
    expect(stepTool({ type: 'assistant/message', surfaceOp: 'append', data: { name: 'read_file' } })).toBeUndefined()
    expect(stepTool({ type: 'tool/result', data: { name: 'read_file' } })).toBeUndefined()
    expect(stepTool({})).toBeUndefined()
  })

  it('ignores a call that names no tool, rather than narrating a blank', () => {
    expect(stepTool({ type: 'tool/call', data: {} })).toBeUndefined()
    expect(stepTool({ type: 'tool/call', data: { name: '' } })).toBeUndefined()
    expect(stepTool({ type: 'tool/call', data: { name: 7 } })).toBeUndefined()
    expect(stepTool({ type: 'tool/call' })).toBeUndefined()
  })
})

describe('phraseTable', () => {
  it('reads `tool=phrase` entries', () => {
    expect([...phraseTable(['read_file=Reading a file.', 'terminal=Running a command.'])])
      .toEqual([['read_file', 'Reading a file.'], ['terminal', 'Running a command.']])
  })

  it('splits on the first `=`, so a phrase may contain one', () => {
    expect(phraseTable(['x=A= B.']).get('x')).toBe('A= B.')
  })

  it('trims around the separator', () => {
    expect(phraseTable(['  read_file  =  Reading a file.  ']).get('read_file')).toBe('Reading a file.')
  })

  it('attributes nothing for an entry that names no tool, or names no phrase', () => {
    // Degrading to the fallback is the whole of it: a mistyped entry can never half-apply itself, and can
    // never turn a tool's name into prose.
    expect([...phraseTable(['no separator', '=No name.', 'read_file=', '   =   ', '']).values()]).toEqual([])
  })
})

describe('narration', () => {
  /** A policy thunk, because a turn reads its policy once, at the start — see `MilestonePolicy`. */
  const policy = (over: Partial<MilestonePolicy> = {}) => (): MilestonePolicy => ({
    phrase: (tool: string) => `Starting ${tool}.`,
    intervalMs: 4_000,
    maxSpoken: 3,
    speak: true,
    ...over,
  })

  /** A runner wired for narration, and the steps it reported. */
  const narrating = (over: Partial<TurnDeps> = {}) => {
    const steps: TurnStep[] = []
    const listeners: ((event: SessionEventLike, sessionId: string) => void)[] = []
    const run = createTurnRunner({
      sessionId: () => SESSION,
      maxPromptChars: () => 1_000,
      frame: () => FRAME,
      answerTimeoutMs: () => 50,
      admit: () => Promise.resolve(),
      subscribe: (listener) => { listeners.push(listener); return () => undefined },
      onStep: (step) => { steps.push(step) },
      ...over,
    })
    return { listeners, steps, run }
  }

  const call = (name: string, turn = 1): SessionEventLike => ({ type: 'tool/call', data: { name, turn } })

  it('speaks a step for a tool call, addressed to the turn it belongs to', async () => {
    const { listeners, steps, run } = narrating({ milestone: policy() })
    const pending = run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()

    // A message event first: not every event is a step, and the runner must not narrate one that is not.
    listeners[0]!(turnStart(), SESSION)
    listeners[0]!(message([text('green')]), SESSION)
    listeners[0]!(call('read_file'), SESSION)

    expect(steps).toEqual([{ id: 'item_1', channel: 'commentary', text: 'Starting read_file.' }])
    await expect(pending).resolves.toEqual({ kind: 'answered', text: 'green' })
  })

  it('holds a rapid step back to `thinking`, rather than speaking over itself', async () => {
    // Pacing, and the reason it is measured against the clock rather than counted: an agent's steps arrive
    // in bursts, and a burst read out loud is slower than the work it is describing.
    const { listeners, steps, run } = narrating({ milestone: policy({ intervalMs: 60_000 }) })
    void run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()
    listeners[0]!(turnStart(), SESSION)

    listeners[0]!(call('read_file'), SESSION)
    listeners[0]!(call('terminal'), SESSION)

    // The first is immediate — a turn that has said nothing has nothing to be paced against.
    expect(steps.map(step => step.channel)).toEqual(['commentary', 'thinking'])
    expect(steps[1]!.text).toBe('Starting terminal.')
  })

  it('speaks again once the interval has passed', async () => {
    vi.useFakeTimers()
    try {
      const { listeners, steps, run } = narrating({ milestone: policy({ intervalMs: 4_000 }) })
      void run(request([{ kind: 'input', text: 'q' }]))
      await Promise.resolve()
      listeners[0]!(turnStart(), SESSION)

      listeners[0]!(call('read_file'), SESSION)
      vi.advanceTimersByTime(4_000)
      listeners[0]!(call('terminal'), SESSION)

      expect(steps.map(step => step.channel)).toEqual(['commentary', 'commentary'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops speaking at the cap, and keeps carrying the steps silently', async () => {
    const { listeners, steps, run } = narrating({ milestone: policy({ intervalMs: 0, maxSpoken: 3 }) })
    void run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()
    listeners[0]!(turnStart(), SESSION)

    for (const name of ['read', 'write', 'edit', 'run']) listeners[0]!(call(name), SESSION)

    // Four steps, three of them spoken: the fourth is still reported, so a reader can see it happened.
    expect(steps.map(step => step.channel)).toEqual(['commentary', 'commentary', 'commentary', 'thinking'])
    expect(steps).toHaveLength(4)
  })

  it('says nothing aloud when narration is switched off', async () => {
    const { listeners, steps, run } = narrating({ milestone: policy({ speak: false }) })
    void run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()
    listeners[0]!(turnStart(), SESSION)

    listeners[0]!(call('read_file'), SESSION)

    expect(steps).toEqual([{ id: 'item_1', channel: 'thinking', text: 'Starting read_file.' }])
  })

  it('narrates nothing when the caller supplied no policy, or no sink for it', async () => {
    // Both halves are optional and each alone must be inert: a caller that has not thought about narration
    // gets silence, not a plugin talking over their conversation.
    const noPolicy = narrating()
    void noPolicy.run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()
    noPolicy.listeners[0]!(turnStart(), SESSION)
    noPolicy.listeners[0]!(call('read_file'), SESSION)
    expect(noPolicy.steps).toEqual([])

    // A sinkless runner is built here rather than through `narrating`, because `onStep` has to be *absent*
    // and not present-and-undefined: `exactOptionalPropertyTypes` is on, as it is for the rest of the repo.
    const sinklessListeners: ((event: SessionEventLike, sessionId: string) => void)[] = []
    const sinkless = createTurnRunner({
      sessionId: () => SESSION,
      maxPromptChars: () => 1_000,
      frame: () => FRAME,
      answerTimeoutMs: () => 50,
      admit: () => Promise.resolve(),
      subscribe: (listener) => { sinklessListeners.push(listener); return () => undefined },
      milestone: policy(),
    })
    void sinkless(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()
    sinklessListeners[0]!(turnStart(), SESSION)
    sinklessListeners[0]!(call('read_file'), SESSION)
    // Nothing to assert on but the absence itself: the turn simply does not report a step.
    expect(sinklessListeners).toHaveLength(1)
  })

  it('ignores a step from another session, as it ignores an answer from one', async () => {
    const { listeners, steps, run } = narrating({ milestone: policy() })
    void run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()
    listeners[0]!(turnStart(), SESSION)

    listeners[0]!(call('read_file'), 'sess-2')

    expect(steps).toEqual([])
  })
})

describe('createTurnRunner', () => {
  const deps = (over: Partial<TurnDeps> = {}) => {
    const admitted: string[] = []
    const listeners: ((event: SessionEventLike, sessionId: string) => void)[] = []
    let unsubscribed = 0
    const run = createTurnRunner({
      sessionId: () => SESSION,
      maxPromptChars: () => 1_000,
      frame: () => FRAME,
      answerTimeoutMs: () => 50,
      admit: (prompt) => { admitted.push(prompt); return Promise.resolve() },
      subscribe: (listener) => { listeners.push(listener); return () => { unsubscribed += 1 } },
      ...over,
    })
    return { admitted, listeners, unsubscribed: () => unsubscribed, run }
  }

  it('admits the turn framed, then returns the answer when it lands', async () => {
    const { admitted, listeners, unsubscribed, run } = deps()
    const pending = run(request([{ kind: 'input', text: 'is staging ok?' }]))
    await Promise.resolve()
    // Through the runner, not only through `promptFrom`: this is the assertion that the framing the
    // plugin configures is the framing that reaches the controller.
    expect(admitted).toEqual([`${FRAME}\nis staging ok?`])
    listeners[0]!(turnStart(), SESSION)
    listeners[0]!(message([text('green')]), SESSION)
    await expect(pending).resolves.toEqual({ kind: 'answered', text: 'green' })
    expect(unsubscribed()).toBe(1)
  })

  it('subscribes before admitting, so an answer on the same tick is not lost', () => {
    const { listeners, run } = deps()
    void run(request([{ kind: 'input', text: 'q' }]))
    // Synchronously, before the admission has settled.
    expect(listeners).toHaveLength(1)
  })

  it('adopts the turn the harness started before the admission settled', async () => {
    // **The order a running app actually produces**, and the one that made a relayed answer disappear. The
    // harness emits `turn/start` for our own prompt before the controller's promise resolves, so a latch
    // that arms only after the await misses its own turn and then discards the answer as somebody else's.
    // Measured on a running app: the harness produced the answer two seconds later (`turn/end: completed`,
    // step 1) while the journal showed `prompt.admitted` and then `window.elapsed`, with no
    // `answer.received` at all. Every other test here emits the start after the admission has settled, which
    // is why the shipped version passed its own suite.
    let settle!: () => void
    const gate = new Promise<void>((resolve) => { settle = resolve })
    const { listeners, run } = deps({ admit: () => gate })
    const pending = run(request([{ kind: 'input', text: 'is staging ok?' }]))
    await Promise.resolve()

    // Our turn begins while the admission is still in flight; only then is the admission accepted.
    listeners[0]!(turnStart(7), SESSION)
    settle()
    await Promise.resolve()

    listeners[0]!(message([text('green')], 7), SESSION)
    await expect(pending).resolves.toEqual({ kind: 'answered', text: 'green' })
  })

  it('adopts nothing when the admission was refused, so a refusal cannot speak a start it saw', async () => {
    // The reason the adoption happens after the await rather than in the handler: a start seen while the
    // admission was in flight belongs to our prompt only if that prompt was queued at all.
    let reject!: (error: Error) => void
    const gate = new Promise<void>((_resolve, fail) => { reject = fail })
    const { listeners, run } = deps({ admit: () => gate })
    const pending = run(request([{ kind: 'input', text: 'is staging ok?' }]))
    await Promise.resolve()

    listeners[0]!(turnStart(7), SESSION)
    reject(new Error('session/model-unavailable'))
    await expect(pending).resolves.toEqual({ kind: 'refused', reason: 'session/model-unavailable' })
  })

  it('ignores unrelated events while waiting for its own answer', async () => {
    const { listeners, run } = deps()
    const pending = run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()
    listeners[0]!(turnStart(), SESSION)
    listeners[0]!({}, SESSION)
    listeners[0]!({ type: 'assistant/chunk' }, SESSION)
    listeners[0]!(message([text('green')]), SESSION)
    await expect(pending).resolves.toEqual({ kind: 'answered', text: 'green' })
  })

  it('ignores an answer from another session, so one conversation cannot answer for another', async () => {
    // The comparison that used to be made against a field the event does not carry — which made *every*
    // event a non-match, and every turn a timeout. It is made here, from the id the subscriber supplies.
    const { listeners, run } = deps()
    const pending = run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()
    listeners[0]!(turnStart(), SESSION)
    listeners[0]!(message([text('elsewhere')]), 'sess-2')
    listeners[0]!(message([text('green')]), SESSION)
    await expect(pending).resolves.toEqual({ kind: 'answered', text: 'green' })
  })

  it('does not speak a turn nobody delegated, when the session is already busy with one', async () => {
    // The regression this correlation exists for. A message typed into the chat while the voice waits is a
    // turn of its own, and its answer must not come out of the voice's mouth. Before the latch, the *first*
    // assistant message in the session settled the turn — so this passed as "the session answered" while a
    // person's typed question was being read aloud.
    const { listeners, run } = deps()
    const pending = run(request([{ kind: 'input', text: 'is staging ok?' }]))
    await Promise.resolve()

    // Somebody else's turn, already running: its start was emitted before this admission. Its answer
    // arrives while the voice is still waiting, and settles nothing.
    listeners[0]!(message([text('a reply to something somebody typed')], 3), SESSION)
    await expect(Promise.race([pending, Promise.resolve('still open')])).resolves.toBe('still open')

    // Now this admission's own turn, and only then does the run end.
    listeners[0]!(turnStart(4), SESSION)
    listeners[0]!(message([text('green')], 4), SESSION)
    await expect(pending).resolves.toEqual({ kind: 'answered', text: 'green' })
  })

  it('keeps the turn it latched first, so a later one cannot answer for this admission', async () => {
    // A session can begin another turn while the voice waits: ours was queued behind whatever was running,
    // and something else can arrive behind ours. The latch is the *first* turn after the admission, and
    // re-latching on a later one would hand this turn's answer to somebody else's work.
    const { listeners, run } = deps()
    const pending = run(request([{ kind: 'input', text: 'is staging ok?' }]))
    await Promise.resolve()

    listeners[0]!(turnStart(4), SESSION)
    listeners[0]!(turnStart(5), SESSION)
    listeners[0]!(message([text('from the later turn')], 5), SESSION)
    await expect(Promise.race([pending, Promise.resolve('still open')])).resolves.toBe('still open')

    listeners[0]!(message([text('green')], 4), SESSION)
    await expect(pending).resolves.toEqual({ kind: 'answered', text: 'green' })
  })

  it('reports a step of somebody else turn as nothing, rather than narrating it', async () => {
    // The same gate on the silent channel: a typed turn's tool calls are not this conversation's progress,
    // and announcing them would be the plugin describing work nobody asked the voice to do.
    const steps: TurnStep[] = []
    const listeners: ((event: SessionEventLike, sessionId: string) => void)[] = []
    const run = createTurnRunner({
      sessionId: () => SESSION,
      maxPromptChars: () => 1_000,
      frame: () => FRAME,
      answerTimeoutMs: () => 50,
      admit: () => Promise.resolve(),
      subscribe: (listener) => { listeners.push(listener); return () => undefined },
      milestone: () => ({ phrase: () => 'Working on it.', intervalMs: 0, maxSpoken: 3, speak: true }),
      onStep: (step) => { steps.push(step) },
    })
    void run(request([{ kind: 'input', text: 'q' }]))
    await Promise.resolve()

    listeners[0]!({ type: 'tool/call', data: { turn: 3, name: 'read_file' } }, SESSION)
    expect(steps).toEqual([])

    listeners[0]!(turnStart(4), SESSION)
    listeners[0]!({ type: 'tool/call', data: { turn: 4, name: 'read_file' } }, SESSION)
    expect(steps).toHaveLength(1)
  })

  it('declines without admitting when the transcript carried no text', async () => {
    const { admitted, run } = deps()
    await expect(run(request([{ kind: 'input', text: '' }]))).resolves.toEqual({ kind: 'declined' })
    expect(admitted).toEqual([])
  })

  it('says it timed out when nothing answers, and stops listening', async () => {
    const { unsubscribed, run } = deps({ answerTimeoutMs: () => 5 })
    await expect(run(request([{ kind: 'input', text: 'q' }]))).resolves.toEqual({ kind: 'timeout' })
    expect(unsubscribed()).toBe(1)
  })

  it("carries the controller's own reason when it refuses the admission", async () => {
    // The whole point of the patch: this string used to be discarded in a `catch {}`, which is why the
    // foundational failure could not be diagnosed from outside the plugin.
    const { unsubscribed, run } = deps({ admit: () => Promise.reject(new Error('session/model-unavailable')) })
    await expect(run(request([{ kind: 'input', text: 'q' }])))
      .resolves.toEqual({ kind: 'refused', reason: 'session/model-unavailable' })
    expect(unsubscribed()).toBe(1)
  })

  it('carries a bare string rejection as the reason', async () => {
    const { run } = deps({ admit: () => Promise.reject('controller said no') })
    await expect(run(request([{ kind: 'input', text: 'q' }])))
      .resolves.toEqual({ kind: 'refused', reason: 'controller said no' })
  })

  it('states the absence rather than inventing a reason when the rejection carries no message', async () => {
    const { run } = deps({ admit: () => Promise.reject(new Error('')) })
    await expect(run(request([{ kind: 'input', text: 'q' }])))
      .resolves.toEqual({ kind: 'refused', reason: 'the session controller refused the prompt' })
  })

  it('states the absence for a rejection that is neither an Error nor a string', async () => {
    const { run } = deps({ admit: () => Promise.reject({ code: 500 }) })
    await expect(run(request([{ kind: 'input', text: 'q' }])))
      .resolves.toEqual({ kind: 'refused', reason: 'the session controller refused the prompt' })
  })

  it('reads the session and the budgets once per turn, so a change lands on the next one', async () => {
    // S2 story 1's test target: a change **during** an active delegation. This is the mechanism that
    // makes it survivable — the turn in flight keeps the values it started with, and the next turn
    // sees the new ones. Reading per event instead would move the session an answer is expected on
    // under a turn that is already running.
    let session = 'sess-1'
    let budget = 1_000
    let frame = FRAME
    const admitted: string[] = []
    const listeners: ((event: SessionEventLike, sessionId: string) => void)[] = []
    const run = createTurnRunner({
      sessionId: () => session,
      maxPromptChars: () => budget,
      frame: () => frame,
      answerTimeoutMs: () => 50,
      admit: (prompt) => { admitted.push(prompt); return Promise.resolve() },
      subscribe: (listener) => { listeners.push(listener); return () => undefined },
    })

    const inFlight = run(request([{ kind: 'input', text: 'abcdefghij' }]))
    // Re-steered, re-budgeted and re-framed while that turn is still open.
    session = 'sess-2'
    budget = 4
    frame = 'Q'

    // The turn that started on sess-1 is still answered by sess-1, with the budget and the frame it
    // started with — a frame read per event would have let a change re-word a prompt already admitted.
    expect(admitted).toEqual([`${FRAME}\nabcdefghij`])
    await Promise.resolve()
    listeners[0]!(turnStart(1), 'sess-1')
    listeners[0]!(message([text('from one')], 1), 'sess-1')
    await expect(inFlight).resolves.toEqual({ kind: 'answered', text: 'from one' })

    // The next turn uses the new session, the new budget, and the new frame — two characters of question,
    // because the frame it now carries leaves room for exactly that.
    const next = run(request([{ kind: 'input', text: 'abcdefghij' }]))
    expect(admitted[1]).toBe('Q\nab')
    await Promise.resolve()
    listeners[1]!(turnStart(2), 'sess-1')
    listeners[1]!(message([text('from two')], 2), 'sess-1')
    listeners[1]!(turnStart(2), 'sess-2')
    listeners[1]!(message([text('from two')], 2), 'sess-2')
    await expect(next).resolves.toEqual({ kind: 'answered', text: 'from two' })
  })
})
