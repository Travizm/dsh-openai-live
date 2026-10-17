---
title: "Voice Provider Swap — Design Chamber"
status: ratified
version: 1.1.1
created: 2026-10-17
ratified: 2026-10-17
ratification:
  decisions: "D-PS-001 … D-PS-006 — all ratified YES, no exceptions"
  adrs: "ADR-010 (harness demoted to driver), ADR-011 (capabilities declared and refused), ADR-012 (instrument before the second provider), ADR-013 (Pipecat deferred)"
domain: chamber
tags: [chamber, design, dsh, realtime, voice, deepgram, cartesia]
chamber:
  composition: "Senge (complex adaptive systems), Quinn (quality architecture), Haggai (agentic systems architecture)"
  presiding: "Chief Forge Orchestrator"
  convergent: true
  verdict: "The seam is right; the unit it swaps is wrong. Swap speech front-ends behind a declared-capability seam, keep DSH the only brain, and build the journal before the second adapter."
source:
  - "docs/draft-provider-swap.md (the draft under review)"
  - "packages/realtime/src/types.ts (the seam contract)"
  - "docs/decisions.md ADR-001 … ADR-009"
  - "docs/roadmap.md (the diagnostics diagnosis)"
  - "developers.deepgram.com — Configure the Voice Agent; TTS Models (accessed 2026-10-17)"
  - "Cekura S2S benchmark, 2026-10-14 (cascade 82.9% pass³ vs Grok 3.0 81.7%)"
regulated: false
governance_note: "Non-governed product repo per ADR-007; no vault publication, no governed-write gate."
---

# Swappable Voice Providers — Design Chamber

**Senge × Quinn × Haggai** | Presiding: Chief Forge Orchestrator | 2026-10-17

---

## §1 — Problem Diagnosis: the seam swaps the wrong unit

### 1.1 Evidence

| Claim in the draft | What the evidence says |
|---|---|
| "The seam is provider-neutral" | Neutral in *vocabulary*, but its unit is a **duplex session**: one provider, one socket, one turn boundary, one delegation target (`types.ts:151-210`) |
| "Deepgram is another provider" | Deepgram Voice Agent is a **hosted harness** — it owns STT→LLM→TTS orchestration, function dispatch, speculative replies and its own context window (`context_length`, `agent.context.messages`) |
| "Swap = new adapter package" | Correct for the *transport*; incorrect for the *delegation* — Deepgram has no delegation, so `dsh-realtime-responder` has no counterpart |
| "~$0.04/min cascade" | Unfalsifiable as stated: Deepgram bills connected minutes, DeepSeek bills tokens, Cartesia bills characters. Three units, no fixed workload |
| "OptA/B/C are provider choices" | A and B differ in **who owns turn semantics**, not which vendor |

### 1.2 The structural problem

The draft treats this as a **vendor selection** problem. It is a **boundary** problem. Three different things are being called "a provider":

1. a duplex model that owns ears, mouth *and* turn boundary (GPT-Live-1, PersonaPlex, VoiceChat);
2. a hosted harness that owns ears, mouth, turn boundary *and* the decision of when to consult a brain (Deepgram Voice Agent);
3. a component library with no turn semantics at all (raw Deepgram Flux ASR + Cartesia TTS).

The seam was designed against (1). Deepgram is (2). The cheap cascade, properly assembled, is (3). No single interface should claim all three.

---

## §2 — Senge: boundary, leverage, and the missing sensing loop

**System boundary.** The seam draws its boundary around "a provider session". That boundary is drawn *inside* the speech front-end rather than around it. A boundary drawn one level too low is why the diffusion of the cascade into the plugin feels like a rewrite instead of an addition.

**Core domain placement.** DSH's core domain is the agent loop — tools, skills, sessions, permissions, memory. Speech is *supporting*: necessary, not differentiating. Option B (Deepgram's LLM decides, DSH answers functions) moves the decision of *what to say* into a supporting-domain vendor. That is the fracture line, and it is exactly the reasoning ADR-001 already used to reject Responses delegation — the same argument applies one layer down and the draft did not notice.

**Leverage point (Meadows).** Adding an adapter is a **parameter** change — the weakest level. The leverage is at **rules and information flows**: the seam's own contract, and the information that tells you whether a swap succeeded. The roadmap already names it: *"failures here are invisible."* A second provider added to a system with no sensing mechanism multiplies unknowns rather than options.

**Feedback structure.** Reinforcing loop: each unobservable provider swap adds a failure class nobody can attribute → debugging cost rises → willingness to swap falls → the seam ossifies back into one implementation. The system's response to the draft's proposal, unmodified, is *less* swappability.

**Complexity vector.** Option C (Pipecat sidecar) is a **shallow module**: a pass-through boundary that moves complexity from the adapter into operations — two runtimes, two lifecycles, two logs — without reducing any of it. Option A′, by contrast, is a **deep module**: a cascade hidden behind a session-shaped interface. Deep is right; *deceptive* is not. The interface must declare what it cannot do.

**Second-order effect to expect.** With any hosted harness, error attribution moves off your stack. The seam's `REALTIME_ERROR_CODES` will start reporting a class of failure whose cause is three vendors away. Design the classification now or inherit a taxonomy that lies.

---

## §3 — Quinn: what would prove a swap worked?

**The unfalsifiable requirement.** "Swappable" has no pass/fail criterion in the draft. It needs one: *for a fixed scenario corpus, adapter A and adapter B produce the same observable seam behaviour*. That is a **provider conformance suite** — one spec, run against both adapters — and it does not exist. Without it, "swappable" is an adjective, not a property.

**Coverage is not conformance.** Per-file 100% on `packages/*/src` measures which lines ran. It cannot detect that `appendThinking` silently does nothing under Deepgram. Every capability gap must be a **declared refusal with a coded error**, or the passing suite becomes the false positive my sixth filter exists to catch.

**Reproducibility (ADR-003).** The keyless replay backend is the CI contract. A Deepgram adapter without a recorded fixture drops CI from "proves the product" to "proves compilation". Fixture is not optional and is not Phase-last.

**Measurement, not assertion.** The cost claim needs a fixed workload — N calls × M minutes × one transcript — measured against both routes, reporting the *billing unit actually charged*. Likewise latency: Cekura measured the cascade at 2.17 s against 1.34 s for the best duplex model. That regression is invisible without per-stage instrumentation, and it is the single most likely reason a user rejects the cheaper route.

**Audit before design.** Every row of the draft's §5 capability-gap table marked "none documented" is a `❓`, not a fact. This repo's own discipline — ✅ observed on the wire, ❓ documented-only — says probe before specifying. Four assumptions are load-bearing: `UpdatePrompt` replace-only, `InjectAgentMessage` mid-turn, absence of a usage event, utterance-level `ConversationText`.

**The hidden regression risk.** Widening `RealtimeSessionOptions` with `tools` changes a `peer`-visible type. Under `exactOptionalPropertyTypes`, an added optional field is safe; a changed required one is a break. The GPT-Live-1 path must be untouched, and a test must prove it is.

---

## §4 — Haggai: this is harness composition, not model swapping

**Layer mapping.** Two layers are being conflated. The **model** layer supplies speech in/out. The **runtime/harness** layer owns turn boundaries, tool dispatch, context assembly, and orchestration. GPT-Live-1 with client delegation *is a model* that hands the turn decision to the harness. Deepgram Voice Agent *is a harness* — it orchestrates STT, LLM, TTS, speculative replies and function dispatch. Option A therefore does not swap a model; it **nests a harness inside your harness**.

**Principle 3 (the harness is the OS).** Two harnesses cannot both be the OS. The resolution is a demotion, not a negotiation: Deepgram must be reduced to a **device driver** — transport, ASR, TTS, barge-in signalling — and prevented from owning *what is said*. Concretely: `agent.think.provider.type = "open_ai"` with `agent.think.endpoint` pointing at DSH, and **no `agent.think.functions`**. DSH's tools stay inside DSH's own loop. Declaring DSH's real tool schemas to Deepgram would create **two tool registries** that drift, which is the same anti-pattern as parallel identity registries.

**Principle 4 (memory is the hardest problem).** Deepgram's `agent.context.messages` and `context_length` are a second memory store. There must be one record: the DSH session. Deepgram's context is a cache, rebuilt from DSH at session start and after reconnect — never the source of truth.

**Principle 12 (observability).** A cascade produces **two trajectories**: Deepgram's turn decisions and DSH's tool loop. Without a shared correlation id, a failed call cannot be attributed to ears, brain or mouth. This is a design requirement on the journal, not a nice-to-have.

**Principle 11 (evaluation).** The literature's warning applies precisely: agent evaluation is harder than model evaluation because partial credit matters. A voice turn can be "correct words, wrong timing" or "right timing, wrong words", and the seam currently collapses both into one transcript stream.

**Verdict on Pipecat.** It solves a real problem at the wrong layer for this repo: transport and barge-in are *device-driver* concerns, and Deepgram already supplies them. Adopt Pipecat when the requirement is SIP/WebRTC or hands-on barge-in control, not to obtain a cheap cascade.

---

## §5 — Convergent findings

### C-1: The seam's unit is a speech front-end, not a provider session — UNANIMOUS
Senge: the boundary is drawn one level too low, which is why every addition feels structural.
Quinn: without a conformance suite over a declared contract, "swappable" cannot be tested.
Haggai: model and harness layers are conflated; the interface must state which it is speaking to.

### C-2: Capability gaps must be declared and refused, never silently degraded — UNANIMOUS
Senge: a deceptive interface is worse than a narrower one.
Quinn: a silent no-op passes every coverage gate and is undetectable from outside.
Haggai: an undeclared capability loss is how a "successful" migration loses a feature.

### C-3: DSH must remain the only brain; Deepgram is demoted to a device driver — UNANIMOUS
Senge: core domain must not move to a supporting-domain vendor.
Quinn: two brains makes task success unattributable — the exact thing evaluation cannot tolerate.
Haggai: two harnesses cannot both own turn semantics; one must be demoted.

### C-4: Sensing before swapping — the journal is a precondition, not a parallel track — UNANIMOUS
Senge: the swap's own success signal is missing, and the loop ossifies without it.
Quinn: cost and latency claims are unmeasurable without per-stage instrumentation.
Haggai: two trajectories need correlation or there is no debugging story.

### C-5: The sidecar (Pipecat) is deferred, not rejected — UNANIMOUS
Senge: a shallow pass-through that relocates complexity into operations.
Quinn: it weakens the keyless CI guarantee (ADR-003) for no gain to this requirement.
Haggai: transport is a device-driver concern; Deepgram already satisfies it.

### C-6: The cost claim must be measured on a fixed workload, in each vendor's own billing unit — UNANIMOUS
Senge: an unmeasured parameter change cannot justify a structural one.
Quinn: connected minutes, tokens and characters are not interchangeable.
Haggai: rubric before deployment — that is the same rule as the evaluation plan.

---

## §6 — System architecture

### 6.1 Option A′ — the ratified shape

```
microphone ──► dsh-realtime-deepgram (driver)
                     │  Settings: listen=Flux, speak=cartesia, think=open_ai@endpoint
                     ▼
              Deepgram Voice Agent  ──(turn detected, speculative reply)──►
                     │  POST /v1/chat/completions
                     ▼
              dsh-delegate (shim)  ──►  SessionController['prompt']  ──►  DSH tools/skills/session
                     │  text
                     ▼
              Deepgram → Cartesia → speaker
```

Three demotions, each with an owner:
1. Deepgram owns **when** to speak, never **what**.
2. DSH owns what, with its own tools — no `agent.think.functions`.
3. Cartesia is a **speak provider inside Deepgram**, so there is no second socket and no second vendor integration.

### 6.2 Capability declaration (replaces seam-splitting)

```ts
export interface RealtimeCapabilities {
  appendThinking: boolean      // false for deepgram
  appAuthoredSpeech: boolean   // false for deepgram (InjectAgentMessage only)
  functionCalls: boolean       // false in A′ by design
  usageReporting: boolean      // false for deepgram (❓ until probed)
  transcriptDeltas: boolean    // false for deepgram (utterance-level)
  inputMute: boolean           // false for deepgram (adapter-local)
}
```
`RealtimeProviderInfo` gains `capabilities?: RealtimeCapabilities`. A call into an unsupported capability throws `REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED` — a *new* code, never a widened existing one.

### 6.3 Metric source-of-truth matrix

| Metric | Authoritative source | Binary check | Tolerance |
|---|---|---|---|
| Turn latency p50/p90 | adapter stage timestamps, journalled | present for every turn | ≤ pre-registered budget |
| Conformance | shared suite vs both adapters | exit code 0 on both | zero divergence |
| Capability honesty | declared vs exercised | every `false` throws when called | exact |
| Cost per call-minute | vendor invoice line, fixed workload | arithmetic reproduces | ±5% |
| Barge-in rate | journal `interrupted` events / 1,000 calls | recorded, not inferred | trend |
| Attribution | one correlation id across both trajectories | 100% of turns | exact |

### 6.4 Verification gate — `voice-swap-verify`

Trigger: any change under `packages/realtime*`. Computes: (1) conformance suite green on every registered adapter; (2) every declared `false` capability throws a coded error when invoked; (3) replay fixture replays keylessly; (4) GPT-Live-1 path unchanged (golden transcript of a replayed session); (5) journal emits the six metrics above. PASS requires all five; any missing is WARN, never silent.

### 6.5 Observability

One `correlationId` per user turn, minted at the driver, carried into the completions request, echoed in the response, journalled by both sides. A turn with no matching id on either side is a defect, not a gap.

### 6.6 Special case — reconnect

Deepgram's context is a cache. On reconnect the driver **rebuilds** `agent.context.messages` from the DSH session's last N turns; it never trusts the provider's retained context. Test: kill the socket mid-turn, assert the next turn's context matches the DSH record.

---

## §7 — Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Two brains creep back in (a `functions` array appears) | 🔴 | ADR clause forbids `agent.think.functions` in A′; conformance test asserts its absence |
| Silent capability loss ships | 🟠 | Capability declaration + coded refusals + gate item 2 |
| Latency regression invisible | 🟠 | Per-stage journal + p50/p90 gate |
| Cost claim unverifiable | 🟡 | Fixed workload measurement, invoice-based |
| Second memory store diverges | 🟠 | Rebuild-from-DSH on reconnect; test kills the socket |
| Widening `RealtimeSessionOptions` breaks the peer contract | 🟡 | Optional-only additions; GPT-Live-1 golden transcript |

---

## §8 — Implementation pathway

| Phase | What | Effort | Depends on |
|---|---|---|---|
| **P0** | Ratify D-PS-001…006 | — | this document |
| **P1** | **Wire probe** (1 day): confirm the four ❓ assumptions against the live socket — `UpdatePrompt` replace-only, `InjectAgentMessage` mid-turn, no usage event, utterance-level `ConversationText`. Licence to specify. **RUN 2026-10-17 — see `docs/p1-wire-probe-results.md`: three confirmed; `UpdatePrompt` replace-vs-append is UNRESOLVED (four confounded tests), so `promptUpdate` declares `'unknown'` and the adapter must gate every turn on `PromptUpdated`/`ThinkUpdated`.** | ~1d | P0 |
| **P2** | Journal + per-stage instrumentation (roadmap Layer 1, unchanged scope) | as planned | P0 |
| **P3** | Capability declaration + `CAPABILITY_UNSUPPORTED` + conformance suite skeleton. **DONE 2026-10-17** — `packages/realtime/src/capabilities.ts` (`RealtimeCapabilities`, `requireCapability`, `assertPromptUpdate`, `auditCapabilities`), the new code, and `tests/capabilities.spec.ts`. Deepgram is declared from probe evidence (`DEEPGRAM_CAPABILITIES`); OpenAI's declaration is deferred to a story that audits its adapter rather than guessed now. | ~0.5d | P0 |
| **P4** | `dsh-delegate` completions shim over `SessionController['prompt']`. **DONE 2026-10-17** — translation (P4a), follow-stream assembly + HTTP surface (P4b), and the Cordis plugin (`src/plugin.ts`) that mounts it on the `sessionController` service, so it is mountable rather than merely specified. **Note:** `prompt()` admits rather than answers; the answer comes from `follow()`'s committed record. | ~1d | — |
| **P5** | `dsh-realtime-deepgram`: transport, `Settings` builder, event translation, adapter, plugin. **DONE 2026-10-17** — `packages/realtime-deepgram`: `settings.ts` (built from the probe's accepted frame; refuses blank/loopback endpoints and out-of-range EOT thresholds), `events.ts` (utterance transcripts marked `final`, `LatencyReport` → per-stage ms, the update acknowledgement as a first-class signal), `transport.ts` (socket injected, text vs binary decided in one place), `session.ts` (appendInstructions resolves on the ack; appendThinking refuses by code; mute adapter-side), `adapter.ts` (waits for `SettingsApplied`, so it cannot hand out an alive-but-inert session) and `plugin.ts` (route registered with its capabilities; the key registered as a journal secret before the adapter exists). **Remains:** the live end-to-end run. | ~2–3d | P1, P3, P4 |
| **P6** | Replay fixture + cost/latency measurement on a fixed workload. **DONE 2026-10-17** — `packages/realtime-deepgram/src/recording.ts` (summarise + cost, from connection time), `scripts/record-deepgram-session.mjs` (records a real session from the socket), `scripts/deepgram-cost.mjs`, and the fixture `.recordings/deepgram-whats-the-weather.jsonl`. Measured: 3.04 s connected, first sound 1.95 s (at end-of-turn — EOT dominates, not synthesis), $0.0033 a call at the A′ rate ($3.90/hour). See `docs/p6-cost-and-latency.md`. | ~1.5d | P5 |
| **P7** | *(deferred)* Pipecat sidecar — only if SIP/WebRTC becomes a requirement | — | a real requirement |

**Minimum slice that proves the swap without a rewrite:** P1 → P4 → P5 with the GPT-Live-1 path untouched, capabilities declared, and a single recorded fixture. That is ~4–5 days and it either works or it doesn't.

---

## §9 — Disposition of draft findings

| Draft §4 delta | Disposition |
|---|---|
| 1. Add `tools` to `RealtimeSessionOptions` | **Rejected for A′.** No function channel; DSH's tools stay in DSH. Revisit only if a provider forces it. |
| 2. `onFunctionCall` / `respondFunctionCall` | **Deferred** with 1. |
| 3. Relax `RealtimeTranscript` | **Accepted** — utterance granularity, declared. |
| 4. `onUsage` optional | **Accepted** — becomes `usageReporting: false` + coded refusal, never `seconds: 0`. |
| 5. Split `appendInstructions` replace/append | **Accepted** — capability-declared, not split. |
| 6. Pin `channels: 1` | **Accepted** — adapter-local. |
| 7. Re-home `appendThinking` | **Accepted as refusal.** Narration degrades to `InjectAgentMessage`. |
| Option B (tool server) | **Rejected** — ADR-001's reasoning applies one layer down. |
| Option C (Pipecat) | **Deferred to P7.** |

---

## §10 — CEO decisions

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D-PS-001 | Adopt **A′**: DSH is the only brain; Deepgram is demoted to a device driver with no `functions` array | YES / NO / MODIFY | **YES** — the only shape that keeps core domain in DSH (C-3) |
| D-PS-002 | Sequence the journal layer **before** the second adapter | YES / NO | **YES** — C-4; the swap is unmeasurable without it |
| D-PS-003 | Declare capabilities with coded refusals rather than splitting the seam into duplex/cascade interfaces | YES / NO | **YES** — C-2; one surface, honest about its edges |
| D-PS-004 | Defer Pipecat to P7, gated on a real SIP/WebRTC requirement | YES / NO | **YES** — C-5 |
| D-PS-005 | Run the one-day wire probe (P1) before any adapter work | YES / NO | **YES** — four load-bearing assumptions are currently ❓ |
| D-PS-006 | Keep GPT-Live-1 as the **default** provider; Deepgram ships as the cheap route | YES / NO | **YES** — spend no credibility on an unproven route |

---

*Chamber convened 2026-10-17. Six convergent findings, all unanimous. The seam survives; its unit changes from "provider session" to "declared-capability speech front-end", and the second implementation arrives only after the instrument that can see it.*
