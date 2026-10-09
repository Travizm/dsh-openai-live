# W1 — the delegation envelope, closed

**Date:** 2026-10-07 · **Status:** ✅ **PASS** · **Evidence:** `spike/evidence/w1-m4-events.jsonl`
**Spike:** `spike/live-session.mjs` (v4) · **Utterance:** `spike/fixtures/audio/deleg.pcm`

## The result

One session, zero errors, full loop:

| t | Direction | Event |
|---|---|---|
| 675 ms | — | socket open |
| 1123 ms | ← | `session.started` |
| 2471 ms | ← | `session.instructions.appended` (session-wide, `delegation_id: null`) |
| 5713 ms | → | utterance complete (89 frames, 4.45 s) |
| 6604 ms | ← | **`session.delegation.created`** `target=client`, `offset_ms=4600` |
| 6604 ms | → | `session.thinking.append` (silent progress) |
| 6604 ms | → | `session.commentary.append` (result, spoken aloud) |
| 7405 ms | ← | `session.thinking.appended` · `session.commentary.appended` |
| 8791 ms+ | ← | output transcript: **"Staging is healthy:"** — the delegated result, spoken verbatim |

Input transcript: *"Please check the deployment status of the staging environment and tell me the result."*
Output audio: 74 deltas = **7.40 s** @ 24 kHz PCM16. Usage: `{"seconds": 7}`.

## The finding that mattered: two delegation modes

`response.item.create` is **not** the reply path for client delegation. It is rejected with:

```
invalid_request_error: "response.item.create requires Responses delegation."
```

GPT-Live-1 has **two mutually exclusive delegation modes**, chosen at session creation:

| Mode | Config | Who does the work | Result returns via |
|---|---|---|---|
| **Client** ← *this plugin* | `delegation: { type: "client" }` | Your application (an existing agent or orchestrator) | `session.commentary.append` (spoken) / `session.thinking.append` (silent) |
| Responses | `delegation: { type: "responses", responses: { model: … } }` | A hosted Responses backend the Live service manages | `response.item.create` + `response.create`, in `response.event` envelopes |

**DSH is an external agent, so client delegation is the correct mode for this plugin.** Under it,
the `response.*` client events are simply invalid, and are not part of our path.

> **Correction to earlier notes.** `response.event` is a **server→client envelope** carrying nested
> Responses-delegation events — it is *not* a client event, and it never appears in client
> delegation. An earlier note recorded it as a GPT-Live-1 client API type; that was wrong.

## Client vocabulary — observed, not assumed

**Client → server** (verified by use unless marked):

| Event | Status |
|---|---|
| `session.start` | ✅ used |
| `session.input_audio.append` | ✅ used (50 ms frames, base64 PCM16) |
| `session.instructions.append` | ✅ used — `{content, delegation_id: null}` |
| `session.thinking.append` | ✅ used — silent context |
| `session.commentary.append` | ✅ used — spoken result |
| `session.close` | not yet exercised |
| `session.update`, `session.input_audio.mute` / `.unmute` | not yet exercised |
| `response.item.create`, `response.create` | **invalid under client delegation** |

**Server → client** (all observed):

`session.started` · `session.input_transcript.delta` · `session.output_transcript.delta` ·
`session.output_audio.delta` · `session.delegation.created` · `session.instructions.appended` ·
`session.thinking.appended` · `session.commentary.appended` · `session.usage.updated` · `session.closed` · `error`

**There is no `session.input_audio.commit`.** The server enumerated its own vocabulary when I sent
one: endpointing belongs to the engine, not the client. This matches the design rule *no hand-rolled
VAD* — and vindicates it.

## Facts the design must now carry

1. **Immutable after startup:** `model`, `instructions`, `audio.output.voice` (defaults to `marin`).
   Extend instructions with `session.instructions.append` instead.
2. **Delegation mode cannot change mid-session** — switching modes requires a new session; setting
   `delegation` to `null` on a running Responses session fails with `immutable_field_update`.
3. **Append content is capped at 500 tokens.**
4. **An `*.appended` ack proves injection, not that the user heard it.** These are different
   guarantees and the design must not conflate them.
5. **Interruption does not cancel delegated work.** A spoken barge-in leaves backend work running
   and a late result can still arrive — the consumer must handle late and orphaned results
   explicitly. This *is* the "provider owns the turn boundary" rule, now observed rather than assumed.
6. **`session.delegation.created` carries no task text** — only `id`, `type`, `target`, `offset_ms`.
   The consumer must reconstruct intent from the input transcript plus application state.
7. **`session.usage.updated` reports audio-seconds, cumulative**, emitted every **~15 s** (measured
   intervals 14.95–15.10 s — see `docs/usable-window.md`), and `session.closed` carries a `reason` plus the
   final value. The count advances with the session; a session whose timeline has stopped reports a value
   that appears not to move.

## Consequence for the runtime contract (v8 → v9)

The bump carries the **client-delegation** vocabulary above — the append trio, the
`delegation.created` envelope, and the usage/closed shape. The `response.*` family belongs to a
separate, optional Responses-delegation capability and should be scoped as its own story rather
than bundled into v9.

## Residual risk to watch

A community report (2026-09-22) describes Responses delegation returning `403 model_not_found` for
models the project *does* hold, attributed by OpenAI to project permission-cache staleness. It
affects the **Responses** path only, and client delegation worked around it. One more reason this
plugin's client-delegation choice is the lower-risk one — but if a Responses-mode row is ever added,
that bug is a known hazard.
