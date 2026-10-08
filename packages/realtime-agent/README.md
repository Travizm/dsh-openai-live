# dsh-realtime-agent

**The consumer for the [`dsh-realtime`](../realtime) seam: it answers what the voice model delegates.**

A voice model that can hand work to the host is only useful if something picks it up. This plugin
holds a live session, records the conversation, and when the model raises a delegation it asks the
application — and then **either delivers the answer or says plainly that it cannot.**

## Why the delegation is the whole point

Everything else about realtime voice is transport. A fast handshake and clean audio are table stakes;
the thing that makes a voice model an *agent* is that it can ask for something in the middle of a
conversation and keep talking while it waits.

The protocol makes that deliberately hard to fudge. `session.delegation.created` carries
**metadata only** — `{id, target, offsetMs}` — and **no task text**:

```ts
interface RealtimeDelegation {
  id: string
  target: 'client' | 'responses'
  offsetMs: number
}
```

So intent has to be reconstructed. This plugin carries the conversation it has transcribed alongside
the delegation, because the consumer knows the conversation and only the application knows its own
state. Neither can do it alone, which is why the request carries one and is handed to the other.

## Answering

Listen on the bus. Listeners run in order, and the **first to return a non-empty answer wins** — that
is Cordis `serial` dispatch, so several responders can be registered and each can decline by
returning nothing:

```ts
ctx.on('realtime-agent/delegation', async (request) => {
  // request: { id, offsetMs, transcript, sessionId }
  const answer = await lookSomethingUp(request.transcript)
  return answer === undefined ? undefined : { text: answer, mode: 'spoken' }
})
```

`mode: 'spoken'` sends the text as commentary, which the model **says aloud** — use it when the person
in the conversation is waiting. `silent` (the default) sends it as thinking, which the model may use
without announcing it.

## Failing closed, out loud

Returning nothing is a decline, and it is never silent. If every responder declines, none is
registered, the responder throws, or the answer does not arrive within `delegationTimeoutMs`, the
model is told:

> *"Sorry — I can't take care of that right now."*

That is the seam's first invariant made audible: an unresolvable or erroring delegation **never
auto-approves**. The two failure modes it rules out are a fabricated answer and a silence the person
on the other end reads as comprehension.

## Configuration

```yaml
- name: dsh-realtime-agent
  config:
    provider: openai-live     # the registered realtime route
    model: gpt-live-1
    voice: marin              # optional; omitted keeps the provider default
    instructions: '…'         # optional; opening instructions for the session
    autoStart: false          # mounting must not, by itself, open a socket or spend credit
    delegationTimeoutMs: 10000
    maxTranscriptChars: 6000
```

A session is opened only when `autoStart` is set. `maxTranscriptChars` bounds the transcript carried
on each request: it is the **oldest** lines that are dropped, and the most recent line is always kept,
because a buffer that can hold nothing can answer nothing.

## How answers are kept deliverable

- **A long answer is cut, not rejected.** The seam bounds an append at 2000 characters and *throws*
  past it; a clearly-marked prefix beats losing the answer to an exception raised inside a handler.
- **A bad responder is a decline.** A synchronous throw, a rejection, or a malformed return all lead
  to the same honest notice rather than to an exception escaping the adapter's callback.
- **The bound is unref'd.** A timeout that loses the race cannot hold the process open, and there is
  no timer id to clear — so no failure path can leak one.
- **A closed session is not answered into.** Speaking into a released transport would raise a failure
  from inside a handler, so the handler declines to act instead.

## Tested

Per-file 100% coverage on all four axes, enforced. The delegation path is covered end to end through
the real seam, a real `serial` dispatch and a real session — including every way of declining, the
timeout, a responder that throws, and an answer longer than the seam allows.

## Licence

MIT.
