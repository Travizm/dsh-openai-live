# Design — `dsh-openai-live`

**Status:** design record, current as of 2026-10-07. Supersedes the pre-build design where the
live protocol contradicted it (see [decisions.md](decisions.md) ADR-001).

> **Provenance.** The design was set by an adversarial review (Senge / Quinn / Chen / Haggai) run on
> 2026-10-07 before any code existed. That transcript is **not** in this repo — it lived in a chat
> session. What is reproduced below are the **invariants it converged on**, restated as constraints
> on the implementation, plus the protocol facts verified live the same day. Where an earlier
> assumption did not survive contact with the API, it is recorded as superseded rather than quietly
> dropped.

## Purpose

Give DeepSeek Harness a full-duplex voice capability it does not have, on `gpt-live-1` — the only
**live** (non-sunsetting) full-duplex voice model — with the delegation envelope treated as the
plugin's core domain rather than an add-on.

## Scope

**In:** the two plugin rows, the runtime contract bump, the conformance harness, the CI gates
(secret scan, keyless replay), publication as an npm package, and a marketplace submission.

**Out:** Windows-specific work, WebRTC transport (WebSocket only, as the reference implementations
also do), hosted Responses delegation as a *shipped* feature, and any hosted service of our own —
the plugin is installable from the npm artifact alone.

**Depends on:** a DSH install (`@deepseek-ai/dsh`, node `^22.19.0 || >=24`) and an OpenAI key with
`gpt-live-1`. No other runtime services.

## Architecture — two rows on one seam

```
        ┌──────────────────────────── DSH host ────────────────────────────┐
        │                                                                  │
  mic ──┤  row: openai-live  (provider)                                    │
        │    • owns the Live WebSocket session                             │
        │    • owns the audio transport (PCM16/24 kHz, 50 ms frames)        │
        │    • owns the TURN BOUNDARY  ← barge-in / endpointing live here   │
        │    • emits delegation notices upstream                           │
        │                                                                  │
        │  row: openai-live-agent  (delegation consumer)                   │
        │    • consumes session.delegation.created                          │
        │    • runs the DSH agent to satisfy it                            │
        │    • returns the result via the client-delegation path           │
        └──────────────────────────────────────────────────────────────────┘
```

The seam between the rows is **the delegation envelope**, and the contract carries it from v8 to v9.

**Why the provider owns the turn boundary.** Turn-taking is a property of the session, not of the
agent. If both rows negotiated it, barge-in would be resolved twice, differently, under load.
Observed in the live protocol: an interruption does *not* cancel delegated work, so "who owns the
turn" and "who owns the task" are genuinely separate questions and must not be conflated.

## Invariants

Each of these has a **test** attached; an invariant without a test is an intention. (Test coverage
arrives in W3 — until then these are asserted, and marked as such.)

1. **Fail-closed delegation.** An unresolvable, erroring or timed-out delegation must never
   auto-approve. Absence of a decision is a denial.
2. **No hand-rolled VAD.** Endpointing belongs to the engine. This was a design rule *before* the
   spike, and the spike confirmed the API has no `session.input_audio.commit` at all — the engine
   owns it and the rule is not merely preferred but enforced by the protocol.
3. **Credentials are a tested invariant.** No credential may reach a log, a committed fixture, a
   session transcript, or a published tarball — proven by a test that fails on a planted string,
   not by review.
4. **Keyless replay.** Conformance runs against recorded session fixtures and passes with **no API
   key in the environment**. CI must never need a secret to verify protocol handling.
5. **Drift canary.** A scheduled check compares the live event vocabulary against the recorded
   fixture and fails loudly on change — so an upstream protocol change is discovered by CI, not by
   a user.
6. **Ack ≠ delivery.** `session.*.appended` proves injection, not that the user heard anything.
   Nothing in the UI or the agent loop may treat them as equivalent.
7. **Interruption ≠ cancellation.** A barge-in leaves backend work running; a late or orphaned
   result must be handled explicitly rather than assumed away.
8. **Session config is immutable where the protocol says so.** `model`, `instructions` and
   `audio.output.voice` cannot change after `session.start`; the delegation mode cannot change
   without a new session. The design must not offer a UI affordance the protocol cannot honour.

## Session lifecycle

Derived from verified protocol behaviour, not assumption:

- one session per conversation; delegation mode fixed at creation
- instructions are extended with `session.instructions.append`, never replaced
- context injections capped at **500 tokens** each, and acknowledged individually
- usage is reported in **audio-seconds**, roughly once a minute, with a final figure at `session.closed`
- errors are typed and *specific* (they name the offending field) — they are a debugging surface,
  not an opaque failure

## Failure model

Fail closed at every boundary: an unrecognised event type is logged and ignored, never acted on;
an unanswerable delegation is reported as such rather than answered with a guess; an append that
is not acknowledged is retried or surfaced, never assumed.

## Cost model

Usage is billed in audio-seconds. The plugin must therefore expose the session's own usage figures
rather than estimate them, and the keyless-replay harness exists partly so that **CI costs nothing**.

## Distribution

npm package, `verified-npm` tier, provenance-attested, 2FA at publish. Built `lib/` shipped;
`dsh.bundle` declared. Publication is gated on the leak scan for the first push and a tarball
inspection before publish — the two irreversible acts.

## Status

| | Milestone | State |
|---|---|---|
| W1 | Protocol spike — handshake, audio, transcripts, delegation | ✅ **passed 2026-10-07** |
| W2 | Plugin skeleton — two rows, contract v9, fail-closed delegation | in progress |
| W3 | Conformance harness + keyless replay CI | not started |
| W4 | Secret-scan + provenance gates, drift canary | not started |
| W5 | Publication — GitHub → npm → marketplace | not started |
