---
title: "P1 — Deepgram wire probe results"
status: active
version: 1.1.0
created: 2026-10-17
updated: 2026-10-17
domain: architecture
author: Travis Driessen (probe run by Tara, at the CEO's instruction)
evidence: scripts/deepgram-probe.mjs, runs 2026-10-17
---

# P1 — Deepgram wire probe results

D-PS-005 said: run the probe before any adapter work, because four load-bearing assumptions were **documented
only** (❓). **Three hold. One is unresolved — and it took four attempts, each invalidated by its own control,
to establish that a client cannot settle it behaviourally at all.**

Probed against `wss://agent.deepgram.com/v1/agent/converse` with a live key: Flux (`flux-general-en`, v2) for
listening, `open_ai / gpt-4o-mini` for thinking, Aura-2 for speaking.

> **This file previously reported #1 as "CONTRADICTED — it appends".** That verdict came from a run whose
> question was sent *before* the update's acknowledgement, so the turn was produced under the old prompt. It
> is retracted: the receipt was a race, not semantics. The record of how it survived to a written verdict is
> in "Why #1 is unresolved" below.

## Verdicts

| # | Assumption (D-PS-005) | Verdict | Receipt |
|---|---|---|---|
| 1 | `UpdatePrompt` is **replace-only** | ⚠️ **UNRESOLVED** | four tests, all confounded; a client cannot observe the prompt the provider holds |
| 2 | `InjectAgentMessage` is accepted **mid-turn** | ✅ CONFIRMED | the injected sentence returned as assistant text, no `InjectionRefused` in 160–181 frames |
| 3 | There is **no usage event** | ✅ CONFIRMED | no event carrying usage/billing/seconds in any run; observed vocabulary: `Welcome`, `SettingsApplied`, `UserStartedSpeaking`, `ConversationText`, `History`, `EndOfTurn`, `LatencyReport`, `AgentAudioDone`, `PromptUpdated`, `ThinkUpdated` |
| 4 | `ConversationText` is **utterance-level**, not deltas | ✅ CONFIRMED | each frame carries `role` + a complete utterance, e.g. `role="assistant", content="probe one."` |

**Bonus:** `LatencyReport` arrives during every turn with **provider-reported stage timings** —
`ttt_token_latency` ≈ 0.42–0.50 s, `tts_latency` ≈ 0.06 s, `total_latency` ≈ 0.48–0.51 s. ADR-012 wants
per-stage turn latency; on this provider part of that instrument is **reported rather than reconstructed**.

## Established about prompt updates, whatever the semantics

1. **The update takes effect at the ack.** `UpdatePrompt` → `PromptUpdated`, `UpdateThink` → `ThinkUpdated`,
   and a rule in the update is observably in force afterwards (a "end every reply with ZULU" rule appears in
   the following answer).
2. **There is a race, and it is an adapter hazard.** A turn sent *before* the ack is produced under the **old**
   prompt. One run did exactly that and returned `"probe one ZULU."` — both rules live at once — which is what
   a mid-flight update looks like. **Gate every turn on `PromptUpdated` / `ThinkUpdated`.**
3. The documented 25,000-character prompt cap is **not enforced as a rejection** on this path: a single
   30,000-character prompt was accepted with no error.

## Why #1 is unresolved: four tests, four confounds

Recorded in full, because each failure is a different way to build a test that cannot answer its question.

| Attempt | Design | Why it failed |
|---|---|---|
| 1 | Send the new prompt, immediately send the old one back, read the answer | **Could not discriminate** — reinstating the original makes replace and append produce the same output. It also re-fired every turn (54 turns, then a timeout). |
| 2 | Update to "every reply ends with ZULU", ask, look for the marker | **Race, then sampling.** One run sent before the ack (both rules → false "append"); with the ack gate the marker was absent in another, because compliance with a mid-session rule is stochastic. |
| 3 | Two ~15,000-character prompts against the 25,000 cap; accumulation would exceed it | **Vacuous.** The positive control — one 30,000-character prompt — was accepted with no error, so the check could not have failed. A pass condition that cannot fail reads as a pass and means nothing. |
| 4 | Ask the model to enumerate its system-prompt rules verbatim | **Self-defeating.** The model refuses ("I can't disclose internal instructions"), and the ZULU in its refusal is *compliance with the new rule*, not a listed rule — so "ZULU present, original absent" was an artifact of the refusal. |

**There is no fifth behavioural test.** Under both semantics the model can answer identically: holding two
conflicting instructions it picks one, holding one it follows it. Separating them needs the *provider's* view of
the prompt, which a client cannot ask for.

## Design consequences

1. **Do not build on #1.** Declare `promptUpdate: 'unknown'`, not `'replace'`. The documentation contradicts
   itself — `voice-agent-update-prompt`: *"add to – not replace"*; `voice-agent-conversation-context`:
   *"replaces the system prompt"* — so neither page is authority. An unverified load-bearing fact inside a
   capability declaration is worse than an admitted unknown.
2. **Fence it instead of guessing.** Budget the prompt as if updates append: bound its length per session and
   never rely on a prior rule disappearing. That is correct under either semantics.
3. **Gate every turn on the ack** (above). The race is reproducible, and it is the class of defect that shows
   up under load — when a voice session is least forgiving.
4. **P1c, if it ever needs settling:** the only credible route is a BYO endpoint (`agent.think.endpoint`) the
   probe controls, so the request the provider actually sends to the LLM can be read off the wire. Half a day
   with a local HTTP capture — and the only test in this list capable of ending the question.

## Cost

Six probe runs, roughly 120 agent turns (54 of them the erroneous first run), on Flux + Aura-2 with
`gpt-4o-mini` — well under a dollar. The cap tests cost no model calls at all.

## Reproduce

```bash
set -a; . ./.env; set +a
pnpm probe:deepgram -- --plan                       # what it will send, no network
pnpm probe:deepgram -- --out deepgram-probe.json    # 2 turns: checks 2–4, and #1 as far as it goes
pnpm probe:deepgram -- --cap-probe --oversize       # the positive control for the cap hypothesis
```

Exit `0` = nothing contradicted · `1` = an assumption contradicted · `2` = the probe could not conclude ·
`3` = a control failed (the cap test cannot run on this path).
