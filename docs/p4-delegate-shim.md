---
title: "P4 — the delegate completions shim, split in two"
status: active
version: 1.0.0
created: 2026-10-17
domain: architecture
author: Travis Driessen
---

# P4 — the delegate completions shim, split in two

The chamber's P4 reads: *"`dsh-delegate` completions shim over `SessionController['prompt']`"*, ~1 day. Reading
the controller's own types shows that the plan was **half a plan**, and the missing half is the hard one.

## The finding

`SessionController.prompt()` is an **admission**, not a call:

```ts
@Remote('prompt')
prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
// SessionPromptValue = { readonly accepted: true }
```

It enqueues a turn and returns an acknowledgement. Nothing in the return value is the answer. An HTTP handler
that returned `{ accepted: true }` to a caller expecting a completion would be a shim that silently answers
nothing — and, worse, would look correct in a log.

The answer has to be assembled from the controller's other surface:

```ts
@Remote({ mode: 'stream' })
follow(request: SessionFollowRequest, signal): AsyncIterable<SessionFollowFrame>
```

`SessionFollowFrame` is `snapshot | { type: 'event', event } | { type: 'assistant-stream', frame }`, and the
assistant stream's terminal frame carries:

```ts
{ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq } }
```

So the text is **not** reliably in the streamed frames: `frame.chunk` is an opaque `JsonValue` (the provider's
own chunk shape), and the authoritative message is the durable record the `end` marker points at by `seq`. An
implementation that concatenated raw chunks would be provider-specific and would drift the first time the
provider changed its delta shape — the same class of mistake the metrics module exists to avoid.

## What that means

| | What | Risk |
|---|---|---|
| **P4a** | Translation: OpenAI `messages` → `SessionPromptRequest`, and answer → completion response. Pure. | low — exhaustively testable, no clock, no socket |
| **P4b** | Follow-stream assembly + the HTTP surface: correlate *this* request's committed record, serialise per session, handle abandons, serve `/v1/chat/completions`. | high — concurrency, cancellation, partial turns |

**Both halves are now built**, all files at 100% coverage:

| File | What it owns |
|---|---|
| `packages/dsh-delegate/src/protocol.ts` | P4a — OpenAI messages ⇄ `SessionPromptRequest` ⇄ completion |
| `packages/dsh-delegate/src/frames.ts` | P4b — reading the answer out of the follow stream |
| `packages/dsh-delegate/src/settle.ts` | P4b — admit, follow, one turn at a time per session |
| `packages/dsh-delegate/src/server.ts` | P4b — `POST /v1/chat/completions`, coded refusals, loopback by default |

Hazards 1–3 below are handled; 4 and 5 remain open, and so does the end-to-end test against a live controller.

## P4a — what is shipped

- `toPromptRequest(body, now?)` → `PromptRequestMirror`, which is structurally the harness's
  `SessionPromptRequest` (source: `@deepseek-ai/dsh-api-session-controller` `src/types.ts`, v0.1.5-rc.2). The
  mirror is declared locally because the harness package is not a build dependency here; P4b should replace it
  with the real import the moment it is.
- Roles are rendered into the text (`[system] …`, `[user] …`) because `PromptContentPart` has no role channel.
  Dropping roles reads identically in a test and changes meaning in a conversation.
- Refusals are **coded**: `NO_MESSAGES`, `UNSUPPORTED_CONTENT` (a parts array, with its index named),
  `MALFORMED_REQUEST`. Nothing is stringified into a prompt.
- `toCompletion(text, …)` omits `usage` rather than inventing token counts — the shim never sees them, and a
  fabricated figure is one a caller bills against.

## P4b — the design, and how each hazard is handled

1. ✅ **Correlate by record, not by chunk.** `follow({ address, assistantStream: true })`, then on
   `end → committed` read the durable record at `seq` and take its text. Provider-independent by construction.
2. ✅ **Serialise per session** (`settle.ts`, proven by a concurrency counter, not by log order). Two completions admitted to one session produce one interleaved trajectory; the
   "next assistant message" is then not necessarily *this* request's. One in-flight completion per session, a
   queue behind it, and a documented refusal rather than a wrong answer when the queue is full.
3. ✅ **Abandons are failures** (`ATTEMPT_ABANDONED`). `{ kind: 'abandoned' }` means no committed message. Return a coded error; never a
   completion with an empty `content`, which reads to a caller as "the model said nothing".
4. ⬜ **The endpoint must be reachable from the provider.** Deepgram's managed cloud cannot reach
   `127.0.0.1:…`. Pointing `agent.think.endpoint` at the shim for P1c requires a public URL (a tunnel or a
   deployed host). That is a deployment constraint for the probe, not a code one — but it is the reason P1c
   is "half a day with a capture" rather than twenty minutes.
5. ⬜ **`stream: true` is not implemented** — refused by name with `STREAM_UNSUPPORTED`. If the provider requires SSE, that is a third piece (chunk framing +
   `[DONE]`), and it should be built against a real client rather than guessed at.

## One defect the tests caught in P4b

The first implementation called `follow()` and then `prompt()`, with a comment claiming it subscribed first. It
did not: an async generator executes on its **first `next()`**, so the subscription began *after* admission — the
exact race the comment described. The failing test was the one asserting the order. The fix starts a pump
before the prompt and awaits both, which is what the comment always said.

A second test caught something subtler: asserting serialisation by log *order* passes under parallel execution
too, because both designs log `follow` then `prompt` twice. It now counts turns in flight and asserts the
maximum is 1 — a measurement, not an inference.

## Why the split is worth recording

The plan estimated P4 at a day and treated it as one job. It is one job with a pure half and a concurrent half,
and the pure half is the part a reviewer can be certain about. Naming that boundary is the difference between
"the shim is 50% done" and "the shim's safe half is done and the risky half has a design with its hazards
enumerated" — and it stops the next session from re-deriving the `prompt()` discovery from scratch.
