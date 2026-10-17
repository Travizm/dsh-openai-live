---
title: "P6 — cost and latency on a fixed workload"
status: active
version: 1.0.0
created: 2026-10-17
domain: architecture
author: Travis Driessen (measured by Tara)
evidence: .recordings/deepgram-whats-the-weather.jsonl · scripts/record-deepgram-session.mjs · scripts/deepgram-cost.mjs
---

# P6 — cost and latency on a fixed workload

The chamber asked for a replay fixture and two numbers on a fixed workload: what a call-minute costs, and where
the time goes. Both now exist, measured from one recorded session rather than estimated.

## The workload

The same WAV as the input smoke — "What's the weather?", 16 kHz mono 16-bit, 1.15 s of speech — streamed in 20 ms
frames with 800 ms of trailing silence so end-of-turn detection has something to detect. Identical every run, so a
change in the numbers means a change in the system and not in the test.

## Measured

```
recording    .recordings/deepgram-whats-the-weather.jsonl · 245 frames
connection   3.04s  (the billed quantity)

latency
  first sound   1.95s  from the first frame
  audio out     2.48s across 119040 bytes
  audio in      1.95s across 62464 bytes
  frames        99 out · 146 in

transcripts
  · What's the weather?
  · I can't provide real-time weather updates.

cost         $0.003291 at byoLlm ($0.065/min)
```

## What the latency figure actually says

**The first audible response arrived at 1.95 s — which is exactly where the trailing silence ended.** Total input
audio was 1.95 s (1.15 s speech + 0.8 s silence), so the answer's audio began at end-of-turn, not after it. The
end-to-end figure is therefore dominated by **how long the provider waits before deciding the user has finished**,
not by synthesis: TTS streaming and the LLM round trip together cost less than one 20 ms frame at this resolution.

That is the number to tune, and `agent.listen.provider.eot_threshold` / `eot_timeout_ms` are the levers — now
carried through `buildSettings`. A 0.8 s silence requirement at the default threshold is a design choice, not a
constraint.

Two caveats on precision: frames are stamped at 20 ms pacing, so treat the figure as ±50 ms; and one sample is not
a distribution — `firstAudioMs` is a spot measurement, and the journal's `turnTimings` (P2) remain the source for
p50/p90.

## Cost

Deepgram's Voice Agent API bills **websocket connection time** and includes STT, LLM and TTS orchestration:

| Tier | $/min (PAYG) | When it applies |
|---|---|---|
| Standard | 0.075 | managed LLM and managed TTS |
| Standard — BYO TTS | 0.065 | your voice, their orchestration |
| **Custom — BYO LLM** | **0.065** | **A′: DSH is the only brain** |
| Custom — BYO LLM + TTS | 0.050 | Deepgram is a socket and a transcriber |
| Advanced | 0.163 | the premium tier |

*Source: `deepgram.com/pricing` → Voice Agent API, Pay As You Go, accessed 2026-10-17.*

Extended, because the per-minute figure is small and the hourly one is not: **$3.90/hour of connected voice** at the
A′ rate, and **$4.50/hour** at Standard. Two consequences worth stating:

1. **Idle connections bill.** The quantity is socket lifetime, so a session held open while nobody speaks costs the
   same as one in conversation. A voice agent that leaves the socket up between questions is paying for silence.
2. **The tier is a wiring decision, not a negotiation.** A′ (BYO LLM) is the cheapest of the two shapes we would
   actually run, and it is the topology already ratified — so the design and the bill point the same way.

The live runs in `docs/deepgram-live-run.md` used Deepgram's **managed** LLM proxy (no `think.endpoint`), so they
bill at Standard. The `byoLlm` figure above is what A′ will cost once the delegate shim is wired in.

## The fixture

`.recordings/deepgram-whats-the-weather.jsonl` — 245 frames, 16 KB, every frame in and out with `at`, `direction`,
`kind`, `bytes` and, for utterances, the `text`. It needs no key and no network to read, and it is the input to
`scripts/deepgram-cost.mjs`. What it is **not** yet is a replay transport the adapter can be driven from offline;
that would be the follow-on, and it belongs with `dsh-realtime-replay` rather than bolted on here.

## Reproduce

```bash
set -a; . ./.env; set +a
node scripts/record-deepgram-session.mjs              # records; needs a key, spends credit
node scripts/deepgram-cost.mjs .recordings/deepgram-whats-the-weather.jsonl --tier byoLlm
```
