# dsh-realtime

**A realtime voice capability seam for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

DSH ships ~40 `ctx.*` capability seams (`ctx.llm`, `ctx.tools`, `ctx.subagents`, …) and **no voice
seam of any kind**. This package is the proposal and the implementation of that missing seam: a
provider registry over the live-session vocabulary, plus the adapter base every voice backend extends.

> **Status: staged.** This is a third-party proposal, not an official `@deepseek-ai` package. It is
> built to the harness's package conventions so it can be contributed upstream without restructuring.

## The model

A **provider registry**, mirroring `ctx.llm`:

```ts
export const name = 'realtime-openai-live'
export const inject = ['realtime']

export function apply(ctx: Context, config: Config) {
  ctx.realtime.registerAdapter(['openai-live'], new OpenAiLiveAdapter(config))
}
```

The seam is deliberately thin. It owns four things:

| Owned here | Owned by the adapter |
|---|---|
| Route registration, all-or-nothing, disposed with the fiber | The transport (WebSocket, WebRTC, in-process) |
| Provider metadata and advisory model catalogues | Wire encoding and decoding |
| Append bounds (`MAX_APPEND_CHARS`) and coded failures | Token accounting and provider error mapping |
| The journal, and the settings registry a running plugin can be steered by | Which of its own fields are live — and what a change means |

## What the seam deliberately does not have

- **No end-of-utterance call.** Endpointing belongs to the voice provider. A client-side detector
  would be a second, competing turn boundary — and the protocol family this targets has no commit
  event at all, so the absence is enforced upstream, not merely preferred here.
- **No turn management.** Turn-taking is session state, not conversation state. `sendAudio` pushes
  frames and callbacks deliver what happens; nothing here decides who speaks next.
- **No auto-answer for delegations.** `onDelegation` hands the consumer a delegation and the
  consumer decides. There is no default path that answers on the consumer's behalf, because a
  default that resolves work the application has not authorised is exactly the failure this design
  refuses to make possible.

## Failure semantics

Failures that prevent a session opening are **thrown** from `session()`. Failures after a session
opened are delivered to `handlers.onError` — a session that dies mid-conversation must not look like
a rejected request. Codes are stable and branchable; message text is not part of the API.

## Settings: what a running plugin can be re-steered by

`docs/control-plane-fields.md` is the design gate: every field is **live** (read at the moment of use),
**session-bound** (carried in the provider's `session.start`, so only a new session can change it) or
**restart-bound** (claimed once at load). `ctx.realtime.settings` is that classification in code —
`packages/realtime/src/settings.ts` — so a change to a field the protocol cannot honour is *refused with
the reason* rather than accepted and ignored.

```ts
ctx.effect(function* () {
  const release = ctx.realtime.settings.register(name, [
    {
      field: 'sessionId',
      kind: 'string',
      scope: 'live',
      get: () => live.sessionId,          // read at the moment of use — never a copy
      set: (value: string) => { live.sessionId = value },
    },
  ])
  yield () => { release() }
}, 'my-plugin.settings')
```

A key is `<owner>.<field>`. `apply(key, text)` parses by the declared kind, refuses anything the field's
class cannot honour (`UNKNOWN_SETTING`, `FROZEN_SETTING`, `INVALID_SETTING`) with a reason written to be
relayed verbatim, journals a successful change as `config.changed` **by key and not by value**, and
reports the value the plugin now holds. A field declared `secret` is write-only: the surface never
reports its value back.

## Registration and disposal

`registerAdapter` validates the whole candidate set before mutating anything, so a rejected
registration leaves the registry exactly as it was. The registration is created through `ctx.effect`,
so it is withdrawn with the contributing fiber — HMR unmounts routes rather than leaking them.

## Known limitations and deferred work

- **Append bounds are characters, not tokens.** The provider's real limit is 500 tokens. Counting
  tokens exactly would bind this seam to a tokenizer it does not own, so `MAX_APPEND_CHARS` is a
  documented conservative proxy. An adapter that can count tokens should tighten it rather than
  widening the seam's promise.
- **No session resumption.** The protocol fixes provider, model, voice and delegation mode at
  startup; a seam-level `resume` would advertise a capability the wire cannot honour.
- **The model catalogue is advisory.** Absence from `listModels` must never become request rejection.
- **Build layout deviates from the harness's.** A `@deepseek-ai` package compiles to `lib/types` and
  ships a separately bundled `lib/index.js`; this repo compiles flat to `lib/`. The `main`/`types`
  entries and the `.ts`-extension import style match, so the source is portable — but packaging must
  be reconciled before an upstream PR. Tracked here rather than silently diverging.
