# S3 story 1 — the usable window, measured

**Date:** 2026-10-09 · **Status:** ✅ answered — the window is the session timeline, and it is as long as the
microphone is streaming
**Probe:** `spike/usable-window.mjs` · **Evidence:** `spike/evidence/usable-window-*.jsonl` (14 tracked runs)

> **Corrected the same day, an hour after it merged.** The first version of this document concluded that the
> window was the model's own turn and closed ≈2.7 s after `session.delegation.created`. That was wrong — and
> wrong in the direction that mattered, because it said narration could not be paced across a long wait,
> which is what story 3 exists to do. The cause was the probe: it stopped streaming input audio when the
> utterance ended, and **the session timeline advances with its audio**. The wrong reading, and the
> observation that refuted it, are kept below rather than deleted — a reader who has not yet measured this
> will reason from the same two facts and reach the same conclusion.

## The result in one line

**The window is the session's timeline, and it advances for as long as the client's microphone is
streaming.** With the input stream kept alive — which is what a real client does, and what the vendor
documents — a delegated result was placed **3 s, 45 s and 90 s** after `session.delegation.created`, with
**zero** errors, and 24 spoken milestones across a 46-second window were all placed. **The plan's design is
buildable as written and story 3 is unblocked.**

## What was measured

One session per run, `wss://api.openai.com/v1/live/sessions`, `gpt-live-1`, `delegation: { type: 'client' }`,
each streaming `spike/fixtures/audio/deleg.pcm` (4.44 s: *"check the deployment status of the staging
environment"*). One variable moves per run, and from run ten onward it is the one that decides everything:
**whether the input stream stays alive after the utterance.**

**With the input stream kept alive (`KEEPALIVE=1`, digital silence — see [Why the first reading was
wrong](#why-the-first-reading-was-wrong)):**

| run | agent turn | appends | placed | last placed send, past `delegation.created` | timeline |
|---|---|---|---|---|---|
| `final` @3 s | 3 s | 1 | **1** | **+3004 ms** | 13.4 s |
| `final` @45 s | 45 s | 1 | **1** | **+45006 ms** | 55.6 s |
| `final` @90 s | 90 s | 1 | **1** | **+90007 ms** | 99.4 s |
| `frontier` | silent probe, 1 s cadence | 25 | **25** | +24034 ms | 31.1 s |
| `milestone` @45 s | 45 s, milestones every 2 s | 24 | **24** | +46037 ms | 53.5 s |

Every controlled turn in the plan delivered, and so did a milestone stream spanning the whole wait.
`context_injection_incomplete` was **0** in all five runs. Injection latency across the 52 placements: 602 /
748 / 959 ms (min / median / max).

**With the input stream stopped when the utterance ended (the first nine runs):**

| run | appends | placed | timeline stopped at | note |
|---|---|---|---|---|
| `frontier` | 30 | 5 | +2637 ms | the probe's own cadence, frozen mid-stream |
| `final` @3 s / @45 s / @90 s | 1 each | **0** | +2390 … +2994 ms | the plan's turns, all missed |
| `milestone` @45 s | 24 | 2 | +2899 ms | transcript cut mid-clause reading a milestone |
| `stall` @45 s | 24 | 1 | +2644 ms | "keep talking while you wait", cut mid-clause |
| `interrupt` | 1 | 1 | +12517 ms | placed because the barge-in **restarted the audio** |
| `timeout` @45 s | 0 | — | +2390 ms | client gave up; provider neither expired nor complained |

Cost: fourteen sessions, 10.4 session-minutes, ≈US$0.52 at the published $0.05 per voice-session minute
(billed per second, no rounding). Every append was ≤61 bytes, far under the 500-token cap; the cap itself was
measured in story 2 and is not re-measured here.

## The mechanism

The vendor states it, and the runs confirm it — in that order, which is the order it should have been read
in:

> *"A Live session's timeline advances with its audio, so text sent to a session whose microphone is not
> streaming is **deferred rather than delivered**."* — *Managing GPT-Live sessions*

> *"The acknowledgment arrives when the session timeline reaches the estimated end of added context … If the
> session timeline **stops**, the acknowledgment can remain pending."* — same page

> *"Active session time includes time when the user speaks, the assistant speaks, both are silent, or the
> backend is working."* — *Cost optimization*

Three consequences, each measured here:

1. **The output audio is one continuous track for the life of the session, silent between replies.** 557
   deltas / 55.6 s over a 60-second session; 995 / 99.4 s over a 90-second one. The first nine runs' "7.2 s
   of output audio" was not the model's turn — it was how long the timeline ran before the probe stopped
   feeding it.
2. **`start_ms` / `end_ms` are positions on that timeline, and they advance in step with real time.** In the
   frontier run the 25 placements landed at start offsets 5400, 6400, 7400 … 29600 — exactly +1000 ms per
   1000 ms of cadence.
3. **`usage.seconds` is the same clock, and it is cumulative.** 14 / 56 / 101 seconds at close for 13.4 /
   55.6 / 99.4-second timelines, emitted roughly every 15 s. It only looked frozen in the earlier runs
   because the timeline was frozen.

## The three hypotheses, and what decided each

| # | hypothesis | verdict | the observation |
|---|---|---|---|
| 1 | completion tracks the local setting → ownership of the timeout is real | **the timeout is ours; the window is not** | The `timeout` run sent nothing and the provider neither expired the delegation nor complained for 45 s — so `delegationTimeoutMs` governs when *our client* stops waiting, and setting it to 45 s or 90 s is what let the result be sent at all. Real ownership, of the client's patience. It does not govern the window. |
| 2 | provider expiry is independent of it → we do not own the whole window | **not supported** | No expiry, error or event of any kind in sessions held open 45 s and 90 s with a delegation outstanding. |
| 3 | the window is the model's *generation* and it closes first | **refuted** | 25 silent (`thinking`) placements succeeded across 24 s while the model generated nothing, and the 90-second result landed. Placement requires the timeline to advance, not the model to speak. |

## Why the first reading was wrong

The first version of this document read `session.output_audio.delta` as "the model generating", so a 7.2 s
track looked like a 7.2 s turn, and placement stopping when the track stopped looked like *"the window is the
model's turn"*. Two things were wrong with that, and the codebase had already been told the first one:

- **The track is not the model.** 49 of 74 deltas were digital silence (RMS 0 on the decoded PCM). That part
  was caught in the first pass, from W1's full-payload evidence — and it was recorded as a curiosity instead
  of followed to its consequence, which is that the track measures the **session**, not the turn.
- **The track stops when the audio stops, and that was the probe's doing.** `dsh-realtime-audio-ws`'s client
  half captures through a `ScriptProcessorNode`, which fires on every buffer quantum **while connected** — so
  a real client streams frames continuously, silence included, and never freezes the timeline. The probe sent
  89 frames and then nothing.

The refutation was one run with one variable changed (`KEEPALIVE=1`): **25 of 25 placed, spanning 24 s**,
against 5 of 30 for the identical schedule without it. The vendor's sentence was the hypothesis; the run was
the observation. This is the repository's own pitfall in its purest form — *a negative is only as good as the
reach of the search behind it, and a variable that moves with the one under test will be read as its cause* —
with the probe's own behaviour as the variable that moved.

**What would falsify the corrected reading**, if it is ever doubted: a session whose microphone is streaming
continuously in which an append sent well after `delegation.created` is *not* acknowledged, or a session
whose microphone has stopped in which one *is*.

## What this means for the plugin — the load-bearing consequence

1. **The client half must keep audio frames flowing for the life of the call, including silence.** Ours does:
   `ScriptProcessorNode` fires while it is connected, so the plugin is correct **by construction** — but by
   construction is not the same as by test, and a client that stops when the user goes quiet silently loses
   every append. That deserves a regression test on the capture path, not a comment.
2. **`muteInput()` is a plausible window-freezer and must not be used while a delegation is outstanding.** It
   stops the provider *consuming* audio; whether a muted session's timeline keeps advancing is **not measured
   here**. The observation that would settle it: a session that mutes, streams nothing, and still places an
   append 30 s later.
3. **Narration can be paced across a long wait after all, and the milestones are spoken.** The `milestone`
   run placed 24 of 24 and the model read them out for 53.5 s ("Checking the deployment status now. Still
   checking. And still checking…"). Story 2's conclusion that milestones die with the turn is **wrong for the
   same reason**, and is corrected in `commentary-pacing.md`.
4. **A responder is not racing a two-second deadline.** It is bounded by the client's own
   `delegationTimeoutMs` — ours, and raisable — and by whether audio is in flight. A result arriving after the
   session has closed has nowhere to land; a result arriving 45 s into a live session lands and is spoken.
5. **Do not read the length of the emitted audio as the length of anything else** — not the model's utterance,
   not the turn, not the window. It is a playout track.

## Open questions, recorded rather than guessed

- **Does `session.input_audio.mute` freeze the timeline?** Unmeasured; one run answers it (see 2 above).
- **Is there an upper bound on the window?** None found up to 90 s, which is as far as this probe looked.
- **The turn-length question from the first version is now closed** — the "≈7.2 s cap" was the frozen
  timeline, not a cap: with the stream kept alive the model spoke for 53.5 s.

## Corrections carried to earlier documents

- **`docs/commentary-pacing.md` (story 2)** — its headline, *"an append is placed into the model's currently
  generating speech, or it is not placed at all"*, is **superseded**: placement requires the timeline to
  advance, and 25 silent appends were placed while the model generated nothing. Its run-1/run-4 "scope"
  post-mortem stands — it was the same confound, and its conclusions about *scope* are unaffected.
- **`docs/protocol.md` and `docs/w1-delegation-envelope.md`** — the claim this document made on the first
  pass, that `session.usage.updated` "does not accumulate", is **withdrawn**. It is cumulative, emitted
  roughly every 15 s, and it advances with the timeline.

## Reproduce

```bash
# KEEPALIVE=1 is the realistic shape: an open microphone streams silence when nobody is speaking.
KEEPALIVE=1 SHAPE=frontier PROBE_MS=1000 PROBE_UNTIL_MS=25000 \
  EVIDENCE=spike/evidence/usable-window-frontier-keepalive.jsonl node spike/usable-window.mjs
KEEPALIVE=1 SHAPE=final TURN_MS=45000  EVIDENCE=…/usable-window-final-45000-keepalive.jsonl  node spike/usable-window.mjs
KEEPALIVE=1 SHAPE=final TURN_MS=90000  EVIDENCE=…/usable-window-final-90000-keepalive.jsonl  node spike/usable-window.mjs
KEEPALIVE=1 SHAPE=milestone TURN_MS=45000 MILESTONE_MS=2000 \
  EVIDENCE=spike/evidence/usable-window-milestone-45000-keepalive.jsonl node spike/usable-window.mjs

# Without it the timeline freezes when the utterance ends — the defect this document is named after.
SHAPE=final TURN_MS=45000 EVIDENCE=spike/evidence/usable-window-final-45000.jsonl node spike/usable-window.mjs
```

Each run writes JSONL to `spike/evidence/` and prints a per-append table with send times, acknowledgement
latencies, injection offsets and any refusal verbatim, plus a `--- usable window ---` block. The key is read
from `OPENAI_LIVE_API_KEY` (or `VOICE_TOOLS_OPENAI_KEY` / `OPENAI_API_KEY`) and is never logged, written or
echoed; the evidence contains events only — audio payloads are reduced to a byte length, and the provider's
`session.id` is elided because it is `live_`-prefixed and reads as a token to a secret scanner.
