---
title: "P1 — Deepgram wire probe results"
status: active
version: 1.0.0
created: 2026-10-17
domain: architecture
author: Travis Driessen (probe run by Tara, at the CEO's instruction)
evidence: scripts/deepgram-probe.mjs, run 2026-10-17
---

# P1 — Deepgram wire probe results

D-PS-005 said: run the one-day probe before any adapter work, because four load-bearing assumptions were
**documented only** (❓). Three hold. **One does not**, and it is the one the design leans on hardest.

Probed against `wss://agent.deepgram.com/v1/agent/converse` with a live key, Flux (`flux-general-en`, v2) for
listening, `open_ai / gpt-4o-mini` for thinking, Aura-2 for speaking. Every verdict below is a receipt from the
recorded transcript, not a reading of the docs — because on the decisive question **the docs contradict
themselves**.

## Verdicts

| # | Assumption (chamber, D-PS-005) | Verdict | Receipt |
|---|---|---|---|
| 1 | `UpdatePrompt` is **replace-only** | ❌ **CONTRADICTED — it appends** | `UpdatePrompt` acked with `PromptUpdated`, applied before the next turn; the following answer was `"probe one ZULU."` — the original instruction survived *and* the new rule arrived |
| 2 | `InjectAgentMessage` is accepted **mid-turn** | ✅ CONFIRMED | the injected sentence came back as assistant text (`A step is running.`) with **no `InjectionRefused`** in 181 frames |
| 3 | There is **no usage event** | ✅ CONFIRMED | 181 frames, no event carrying usage/billing/seconds; the server vocabulary observed was `Welcome`, `SettingsApplied`, `UserStartedSpeaking`, `ConversationText`, `History`, `EndOfTurn`, `LatencyReport`, `AgentAudioDone`, `PromptUpdated` |
| 4 | `ConversationText` is **utterance-level**, not deltas | ✅ CONFIRMED | each frame carries `role` + a complete utterance, e.g. `role="assistant", content="probe one."` |

**Bonus, unasked for:** `LatencyReport` arrives during every turn with **provider-reported stage timings** —
`ttt_token_latency` ≈ 0.42–0.50 s, `tts_latency` ≈ 0.06 s, `total_latency` ≈ 0.48–0.50 s. ADR-012 wants
per-stage turn latency; on this provider part of that instrument is **reported rather than reconstructed**,
which is strictly better evidence than what the journal derives today.

## The finding: there is no replace primitive

Deepgram's own documentation disagrees with itself on this exact point:

- `developers.deepgram.com/docs/voice-agent-update-prompt` — *"`UpdatePrompt` will add to – not replace – the
  current prompt."*
- `developers.deepgram.com/docs/voice-agent-conversation-context` — *"The new prompt replaces the system
  prompt for the rest of the session."*

The wire settles it: **append**. This is precisely why D-PS-005 insisted on the probe, and it is worth stating
plainly that reading either page alone would have produced a confident, wrong design.

### What it costs the seam

1. **`promptUpdate` cannot be declared as `replace`.** The capability type must carry the mode
   (`'append' | 'replace'`) and Deepgram declares `append` — the same treatment ADR-011 gives every other
   place the providers differ.
2. **DSH's session-prompt replacement has no direct expression here.** Appending per turn grows the prompt
   monotonically, and managed LLMs cap the prompt at **25,000 characters** (BYO LLMs are uncapped). An adapter
   that appends on every milestone would eventually fail a session that the OpenAI path runs indefinitely.
3. **The chamber's "re-home `appendInstructions`" disposition (line 237) is now wrong** — it assumed the
   provider gave a replace primitive and DSH had to move its append behaviour elsewhere. The reverse is true:
   the provider only appends, so DSH's *replace* semantics are the part that needs re-homing.
4. **Untested, and cheap to test next (P1b):** whether `UpdateThink` (the sibling of `UpdatePrompt`, which
   carries a provider *and* a prompt) replaces rather than appends. If it does, the adapter has a path and the
   consequence above collapses to a mapping. If it does not, Deepgram cannot host sessions that re-home their
   prompt, and that belongs in the capability matrix as a hard limitation.

## Method notes — two of this probe's own tests were invalid first

Recorded because a probe that reports a false verdict is worse than no probe:

1. **The first version of check 1 could not discriminate.** It sent `prompt: "…probe two."` and then
   immediately `prompt: "…probe one."`, reinstating the original — so *replace and append both* produce
   "probe one". It also re-fired the whole sequence on every `AgentAudioDone`, spending 54 turns before the
   guard expired. Replaced with a single additive, detectable rule (`end ZULU`), which separates the cases.
2. **Asking the model to report its own instructions was no better.** Asked what phrase its instructions
   required, it answered "probe one." — indistinguishable from a model echoing its own earlier line from a
   long history. Only a *behavioural* marker the old prompt does not contain distinguishes replace from append.

Both are the same failure this repo keeps finding elsewhere: **a test whose pass condition is satisfiable by
two different realities proves nothing.** The verdict above is the one that survived a test that can tell them
apart.

## Cost

Four probe runs, roughly 110 agent turns in total (one of them the 54-turn erroneous run), on Flux + Aura-2
with `gpt-4o-mini`. Fractions of a cent per turn; the whole session is well under a dollar.

## Reproduce

```bash
set -a; . ./.env; set +a
pnpm probe:deepgram -- --plan                    # what it will send, no network
pnpm probe:deepgram -- --out deepgram-probe.json # ~2 turns, verdicts + full transcript
```

Exit `0` = nothing contradicted · `1` = an assumption contradicted (today: `1`, on check 1) · `2` = the probe
could not conclude.
