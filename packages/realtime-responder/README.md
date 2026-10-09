# dsh-realtime-responder

Answers what the voice model delegates, by asking the agent.

`dsh-realtime-agent` publishes a delegation and asks the bus for an answer. Without a listener the model
says, out loud, that it cannot take care of the request — which is honest and useless. This is that
listener: it admits a turn to a real DeepSeek Harness session and returns the agent's reply for the voice
model to speak.

## Requires the session controller

The row `inject`s `sessionController` (`@deepseek-ai/dsh-api-session-controller`, which a DSH profile
already mounts for its own UI). Where that service is absent the row **waits** rather than loading —
deliberate, and the reason the bundle-patch test asserts this row as the one that does not load under a
composition without it. A responder with no door that loaded anyway would be a plugin that silently never
answers.

## Configuration

| Field | Default | Notes |
|---|---|---|
| `sessionId` | **none** | The session the voice conversation is attached to. No default on purpose: a responder pointed at the wrong session would speak another conversation's reply, which is worse than not answering. |
| `answerTimeoutMs` | `45000` | How long to wait for the agent before declining. |
| `maxPromptChars` | `4000` | Character budget for the prompt admitted to the agent. |
| `redactSecrets` | `[]` | Values that must never be spoken or carried onto the bus, however they are spelled. |

## These four change without a restart

All four are **live** fields (`docs/control-plane-fields.md`), which is to say they are read at the
moment they are used and the seam's settings surface can change them while a conversation is running:

```
set realtime-responder.sessionId=session-4f2c9a1e-0d7b-4c58-9a30-2c6e5b81d7a4
set realtime-responder.answerTimeoutMs=90000
```

`sessionId` is the headline. It used to be a boot-time constant, and steering the voice at a different
session cost two restarts and a false lead; it now costs a message. A change takes effect on the **next**
turn — a turn already in flight keeps the session and the budgets it started with, rather than having
the ground moved under it.

Changing `redactSecrets` adds to the journal's secrets at the moment it is set, not at the next boot:
a secret that becomes redactable only after a restart is one the journal can write in the clear in
between. It is write-only — the surface never reports its value back.

A value the plugin's own rules reject is **refused with a reason** rather than clamped: an empty
`sessionId` answers *"sessionId must be non-empty"*, and a zero or fractional budget answers with the
field and the unit.

## The bound, stated plainly

A DSH agent turn can run for minutes. The delegation asking for the answer is bounded too — the agent's
`delegationTimeoutMs` — and **the smaller of the two bounds decides what is actually heard.** Set both to
the same value; the shipped patch sets both to 45 s.

## What it does not do yet

**It does not acknowledge and then come back.** The voice model waits, in silence, for the turn to finish;
past the bound the responder declines and the model speaks its own "I cannot take care of that". The
better shape — acknowledge immediately, narrate progress silently, speak the result when it lands — uses
primitives this project already ships (`appendThinking` for silent progress, `commentary.append` for
speech, both against the same delegation id). What is unverified is whether the provider keeps a
delegation open long enough for a late append, and that spike needs audio in flight, so it settles with
the client half rather than before it.

## Shape

A **function plugin**: named-exports `name` / `inject` / `Config` / `apply`, and no default export — a
default export makes the Loader discard the namespace, so the plugin loads and contributes nothing.

`src/turn.ts` holds the whole of the logic and takes its two impure edges (`admit`, `subscribe`) as
arguments, so every path is testable with plain fakes: no context, no socket, no credential, no spend.
`src/index.ts` is only the wiring.

```ts
export const name = 'realtime-responder'
export const inject = ['sessionController', 'realtime']
```

`realtime` is injected because the responder writes into the seam's journal and declares its settings on
the seam's surface; a turn that produced nothing is exactly what a reader needs to find afterwards, and
waiting for the seam is better than loading without it and journaling into nothing.
