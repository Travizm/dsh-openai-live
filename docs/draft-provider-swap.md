# Draft — Swappable voice providers behind the `dsh-realtime` seam

**Status:** draft, for chamber review — **superseded by `docs/voice-seam-chamber.md`** (ratified 2026-10-17).
Kept for the record: §3's options and §6's roadmap sketch are the input the chamber ruled on, not live plans.
**Author:** Chief Forge Orchestrator, 2026-10-17.
**Scope:** `dsh-openai-live` (ADR-007: non-governed standalone product repo).

## 1. The question

The seam is provider-neutral in design but has only ever been implemented against one protocol
(GPT-Live-1, client delegation). The CEO wants **swappable voice models** — specifically the cheap
cascade measured at ~$0.04/min (Deepgram Flux STT + DeepSeek Flash + Cartesia Sonic TTS) instead of
~$0.055–0.080/min for a hosted duplex model — but is unsure which architecture is correct or what
the roadmap to it is.

## 2. What exists today (evidence)

| Fact | Value | Source |
|---|---|---|
| Seam surface | `sendAudio` / `muteInput` / `appendCommentary` / `appendThinking` / `appendInstructions` / `close` | `packages/realtime/src/types.ts` |
| Delegation model | Provider hands the app a turn (`target: 'client'`); app writes the spoken words | ADR-001 |
| Endpointing | Deliberately **not** in the seam — "a client-side detector would be a second, competing turn boundary" | `types.ts:160` |
| VAD | Forbidden to hand-roll | ADR-004 |
| Tool vocabulary | **None.** No `tools` field anywhere in `RealtimeSessionOptions` | `types.ts:56` |
| Append ceiling | `MAX_APPEND_CHARS = 2000` — a local proxy for the provider's 500-token limit | `types.ts:220` |
| Usage | Audio-seconds only | `types.ts:103` |
| CI contract | Keyless replay backend drives the real adapter from a recording | ADR-003 |
| Gate | per-file 100% on `packages/*/src` | `dsh-plugin-development` |
| Package set | `realtime` (seam), `-openai`, `-replay`, `-responder`, `-agent`, `-audio-ws` | `package.json` |
| Highest ADR | ADR-009 | `docs/decisions.md` |

## 3. Three candidate architectures

### Option A — Deepgram orchestrates, DSH is the LLM
Deepgram Voice Agent holds one socket. `agent.listen.provider` = Flux (turn detection included);
`agent.think.provider.type = "open_ai"` + `agent.think.endpoint` points at **DSH** exposing an
OpenAI-compatible `/v1/chat/completions`; `agent.speak.provider.type = "cartesia"`.

- One socket, no Python, no second runtime.
- Turn detection bought, not built (consistent with ADR-004).
- DSH stays the single brain: its tools, skills, sessions and permissions all apply to the voice turn.
- `dsh-realtime-responder` is **replaced** by a completions shim over `SessionController['prompt']`.
- Documented price: BYO LLM + TTS **$0.050/min**; Deepgram-managed Cartesia is in the Standard tier.

### Option B — Deepgram orchestrates, DSH is a tool server
Same socket, but `agent.think.provider` is a managed LLM and DSH registers
`agent.think.functions[]`, answering `FunctionCallRequest`.

- Cheapest wiring, but the **provider's** LLM decides what to say while DSH owns the skills.
- Two brains, two tool loops, one transcript. DSH's permissions become advisory.
- Rejected as the default on ADR-001's own reasoning (a second orchestrator beside DSH).

### Option C — Pipecat sidecar
Python process hosting the pipeline; a thin Node adapter translates seam events ↔ Pipecat frames.

- Buys WebRTC/SIP transport and end-to-end barge-in control.
- Costs a second runtime: both sides of the hand-off instrumented, replay cannot cover the Python
  half, and the keyless CI guarantee (ADR-003) weakens.
- Also: **a cascade behind this seam is a second harness in series** (Pipecat ears/mouth → DSH brain).

### Option D — Do nothing (keep GPT-Live-1 only)
$0.055–0.080/min, client delegation already verified on the wire, tool surface unchanged.

## 4. Seam deltas required (independent of architecture choice)

1. **Add `tools?: OpenAIToolSchema[]`** to `RealtimeSessionOptions` — today the seam cannot express a
   tool at all.
2. **Add `onFunctionCall` + `respondFunctionCall(id, result)`**, or side-step with server-side
   `functions[].endpoint`.
3. **Relax `RealtimeTranscript`** to allow utterance granularity (`final` always true).
4. **Make `onUsage` optional** with a coded "provider does not report", never `seconds: 0`.
5. **Split `appendInstructions`** into replace vs append semantics (Deepgram only replaces).
6. **Pin `channels: 1`** — Deepgram `Settings` has no channel field.
7. **Re-home `appendThinking`** — no Deepgram equivalent exists mid-turn; `UpdatePrompt` is replace-only.

## 5. Known capability gaps under Deepgram

| Seam capability | Under Deepgram | Consequence |
|---|---|---|
| `appendCommentary` (app-authored speech) | `InjectAgentMessage` only | app can inject a canned line, not author a turn |
| `appendThinking` (silent context) | none mid-turn | the narration channel degrades to inject-only |
| `muteInput` | none | adapter drops frames locally |
| `onUsage` | no seconds event documented | usage becomes unknown, not zero |
| Transcript deltas | utterance-level only | UI must render whole utterances |
| Delegation | none | the delegation loop is dead under this provider |

## 6. Roadmap sketch (to be ruled on)

- **P0** Decide the architecture (this document).
- **P1** Seam widening: tools + function-call vocabulary + transcript/usage/instruction relaxations,
  behind feature flags so the GPT-Live-1 path is untouched.
- **P2** `dsh-realtime-deepgram` adapter + `Settings` builder.
- **P3** Completions shim (`/v1/chat/completions` → `SessionController['prompt']`).
- **P4** Replay fixture for the Deepgram path (ADR-003 parity).
- **P5** Settings registry entries (ADR-009) for provider selection and Flux thresholds.

## 7. Open questions for the chamber

1. Is Option A actually right, or does the cascade's second harness make it the wrong shape?
2. Should the seam stay "duplex-provider-shaped" when one provider is a cascade, or does it need two
   capabilities (duplex session vs cascade)?
3. Does a provider swap compete with the roadmap's stated highest-value work (the diagnostics layer)?
4. What is the minimum slice that proves the swap without a rewrite — and what is the honest cost?
5. What happens to `dsh-realtime-responder` and `dsh-realtime-audio-ws` under each option?
