---
title: "P1 — Deepgram wire probe results"
status: active
version: 1.2.0
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
| 1 | `UpdatePrompt` is **replace-only** | ❌ **CONTRADICTED — it APPENDS** (resolved 2026-10-17 by P1c) | the provider's own outbound request to a BYO LLM carries **both** instructions after an update |
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

## How #1 was finally settled — P1c, reading the request instead of the answer

Every earlier attempt asked the *model* something and drew a conclusion. P1c asked the **provider**:

`scripts/deepgram-prompt-capture.mjs` is a stub OpenAI-compatible endpoint that logs the `messages` it receives and
answers with a fixed line. Pointed at it as `agent.think.endpoint`, the system message in each request *is* the
prompt the provider currently holds — no model, no sampling, no interpretation.

```
1. userTurns=1  "You are a probe. Reply with exactly: probe one."
2. userTurns=1  "You are a probe. Reply with exactly: probe one."
3. userTurns=1  "You are a probe. Reply with exactly: probe one."
4. userTurns=2  "You are a probe. Reply with exactly: probe one.
                 You are a probe. Every reply must end with the token ZULU."
```

Request 4 is the turn after `UpdatePrompt`. It carries the original **and** the new rule, joined by a newline.
**`UpdatePrompt` appends.** The four behavioural attempts below are kept because each failure is a lesson about
testing, and because the answer they reached by accident is the answer the request confirms.

Two incidental findings from the same run:

- **`agent.think.endpoint` is on `think`, not on `think.provider`.** The nested form is rejected with "Check the
  `agent.think` field against the API spec" — found here, after the unit tests had agreed with the wrong shape,
  because a builder and its tests can share the same mistake.
- **`UpdateThink` is not a reliable replace primitive for a BYO composition.** One run showed the post-update turn
  never reaching our endpoint (the agent answered from Deepgram's managed LLM instead — the whole think config,
  endpoint included, had been replaced). A second run, resending the endpoint, showed three requests all carrying
  the original prompt. So the operational conclusion is: do not depend on `UpdateThink` to change the prompt, and
  never send one without resending the endpoint.

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
