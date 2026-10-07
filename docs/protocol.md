# Protocol — GPT-Live-1 over WebSocket, verified

**Everything marked ✅ was observed on the wire on 2026-10-07** against
`wss://api.openai.com/v1/live/sessions`. Evidence: `spike/evidence/w1-m4-events.jsonl`.
Anything unverified is marked ❓ and must not be relied on.

## Transport

- WebSocket: `wss://api.openai.com/v1/live/sessions`, `Authorization: Bearer <key>`.
- WebRTC exists but is **not** used here; WebSocket is what both reference integrations use.
- The first message **must** be `session.start`. A passive socket receives nothing.

## `session.start`

```jsonc
{ "type": "session.start",
  "session": {
    "model": "gpt-live-1",
    "instructions": "…",
    "audio": { "output": { "voice": "marin" } },
    "delegation": { "type": "client" }
  } }
```

**Immutable after startup:** `model`, `instructions`, `audio.output.voice` (defaults to `marin`).
The endpoint **rejects unknown fields**, so a rejection is itself a schema answer. ✅

## Delegation — two modes, fixed at creation

| Mode | Config | Who works | Result returns via |
|---|---|---|---|
| **client** ✅ | `{"type":"client"}` | your application | `session.commentary.append` (spoken) / `session.thinking.append` (silent) |
| responses ❓ | `{"type":"responses","responses":{"model":"…"}}` | a hosted Responses backend | `response.item.create` + `response.create`, inside `response.event` envelopes |

Omitted or `null` = client mode. **The mode cannot change mid-session**; switching requires a new
session. Under client delegation, `response.item.create` is rejected outright:

```
invalid_request_error: "response.item.create requires Responses delegation."
```

> This plugin uses **client** delegation. `response.event` is a **server→client** envelope for the
> Responses path only — it is not a client event and never appears in client mode.

### Verified client-mode round trip ✅

```
-> session.start {model: gpt-live-1, voice: marin, delegation: {type: client}}
<- session.started                               ~1.1 s
<- session.instructions.appended                 (session-wide, delegation_id: null)
-> session.input_audio.append  ×89               50 ms base64 PCM16/24 kHz frames
<- session.input_transcript.delta ×11            the utterance, transcribed
<- session.output_audio.delta  ×74               7.40 s of speech back
<- session.output_transcript.delta ×6
<- session.delegation.created                    {id, type:"delegation", target:"client"}, offset_ms
-> session.thinking.append   {delegation_id: id, content: "…"}
-> session.commentary.append {delegation_id: id, content: "…"}
<- session.thinking.appended                     — injection confirmed
<- session.commentary.appended                   — injection confirmed
<- session.output_transcript.delta               the commentary, spoken aloud
<- session.usage.updated                         {"seconds": 7}
```

## Client → server events

| Event | Status |
|---|---|
| `session.start` | ✅ |
| `session.input_audio.append` | ✅ `{audio: "<base64 PCM16>"}` |
| `session.instructions.append` | ✅ `{content, delegation_id}` |
| `session.thinking.append` | ✅ `{content, delegation_id}` — silent context |
| `session.commentary.append` | ✅ `{content, delegation_id}` — spoken result |
| `session.update` | ❓ |
| `session.input_audio.mute` / `.unmute` | ❓ |
| `session.close` | ❓ |
| `response.item.create` · `response.create` | **invalid in client mode** |

**There is no `session.input_audio.commit`.** The server enumerated its own vocabulary when one was
sent. Endpointing is the engine's job — a commit is not merely unnecessary, it does not exist.

## Server → client events (all ✅)

`session.started` · `session.input_transcript.delta` · `session.output_transcript.delta` ·
`session.output_audio.delta` · `session.delegation.created` · `session.instructions.appended` ·
`session.thinking.appended` · `session.commentary.appended` · `session.usage.updated` ·
`session.closed` · `error`

## Audio

- Input: **base64 PCM16, 24 kHz, mono**, appended in 50 ms frames (= 2400 bytes/frame).
- Output: `session.output_audio.delta` carries base64 raw **mono 24 kHz signed PCM16 little-endian**.
- To make a test utterance: `say -o u.aiff "…"` → `ffmpeg -ar 24000 -ac 1 -f s16le u.pcm`.
  Verify it is real audio, not silence: `-af volumedetect` (a real clip measured mean −15.2 dB).

## Traps (each cost a run)

1. **The wrong event family.** Client delegation has *no* `response.*` path. Guessing at item types
   produces a ladder of rejections; the delegation mode decides the family, not the item shape.
2. **`session.*.appended` proves injection, not audibility.** Do not surface it as "delivered".
3. **A delegation carries no task text** — only `{id, type, target}` and `offset_ms`. Reconstruct
   intent from the input transcript plus application state.
4. **Appends are capped at 500 tokens.**
5. **Interruption does not cancel delegated work.** Handle late and orphaned results.
6. **Usage is audio-seconds**, emitted ~once/minute, final at `session.closed`.
7. **Errors name their field.** They are the fastest available specification — read them literally.

## Entitlement and billing (gotcha with a free check)

`GET /v1/models` lists `gpt-live-1` when the org has it, and **costs nothing**. Do that before
spending a session. A zero balance returns `credit_balance_exhausted` — a **billing** error, not an
entitlement one: by then authentication has already succeeded. Entitlement failure looks like
`400 model_not_found`. OpenAI moved API orgs to prepaid credits on 2026-07-24, so an org that never
topped up returns exactly the billing error.

## Drift checking

`scripts/protocol-canary.mjs` (`pnpm canary`) is the scheduled shape assertion against this endpoint.
It exists because the first signal of a vendor protocol change should be a red build, not a user bug
report.

It is cheap because the endpoint hands the check over: rejecting an unknown **client** event returns an
error that **enumerates the supported client events**. So one handshake — no audio, no conversation —
verifies that all eight events this project sends are still supported, and that
`session.input_audio.commit` still is not. Live: **11 client events reported, every one of ours among
them.**

Two limits, both found by running it rather than by reasoning about it:

- **A context-append acknowledgement needs audio in flight.** A `session.instructions.append` sent
  immediately after `session.started` — byte-identical to the frame that worked in W1 — elicits no
  `session.instructions.appended` and no error, because the provider does not begin applying context at
  a bare `session.start`. The canary therefore does not gate on an append ack: the recorded fixture
  covers that path, and the canary stays audio-free and deterministic.
- The provider's own **server → client** vocabulary is only partly reachable without audio. The canary
  asserts the two events a handshake and a rejection elicit, and claims no more.

The canary keeps its event list as a literal. A canary that read its expectations out of `wire.ts`
could only ever agree with `wire.ts`.

