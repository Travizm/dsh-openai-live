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
export const inject = ['sessionController']
```
