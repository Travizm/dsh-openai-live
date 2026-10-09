# S3 story 1 — the usable window, measured

**Date:** 2026-10-09 · **Status:** ✅ answered — it is a number, and it is not ours
**Probe:** `spike/usable-window.mjs` · **Evidence:** `spike/evidence/usable-window-*.jsonl` (9 tracked runs)

Story 2 established *where* an append lands — into the model's currently generating speech, or nowhere at
all — and promoted this story from neighbour to prerequisite by making the window itself the question. The
plan states the experiment: controlled **3-, 45- and 90-second** agent turns with `delegationTimeoutMs` set
below and above completion, a final answer against milestone commentary, interruption and late-result
cases, under the 500-token append cap. Nine real sessions later it is a number, and the number is smaller
than the plan's smallest turn.

## The result in one line

**The usable window is the model's own turn, and it closes ≈2.7 s after `session.delegation.created`.**
Placement stops when the turn's output timeline ends, which is 2.39–2.99 s past the delegation in eight
independent runs. An append must be **sent within ≈2 s** of the delegation, because injection itself takes
~0.7 s. Every controlled turn in the plan — 3 s, 45 s, 90 s — missed it. Nothing the plugin owns can
widen it.

## What was measured

One session per run, `wss://api.openai.com/v1/live/sessions`, `gpt-live-1`, `delegation: { type: 'client' }`,
each streaming `spike/fixtures/audio/deleg.pcm` (4.44 s: *"check the deployment status of the staging
environment"*) so a turn existed to place into. One variable moves per run.

| run | shape | appends | placed | turn end, past `delegation.created` | output transcript |
|---|---|---|---|---|---|
| `frontier` | silent probe every 400 ms | 30 | **5** | **+2637 ms** | "Okay, checking now." |
| `final` @3 s | the plan's shortest turn | 1 | **0** | +2693 ms | "Okay, checking that deployment status now." |
| `final` @45 s | the plan's mid turn | 1 | **0** | +2568 ms | "Okay, checking that." |
| `final` @90 s | the plan's long turn | 1 | **0** | +2994 ms | "Sure, checking the staging deployment now." |
| `milestone` @45 s | spoken milestones every 2 s | 24 | **2** | +2899 ms | "Okay, I'll check on that. Progress one:" |
| `stall` @45 s | milestones + "keep talking while you wait" | 24 | **1** | +2644 ms | "Sure, I'll check that. Checking in now," |
| `early` @3 s | instructions to delegate *before* speaking | 1 | **0** | +2776 ms | "One moment." |
| `timeout` @45 s | client gives up at 10 s, sends nothing | 0 | — | +2390 ms | "Checking that now." |
| `interrupt` | barge in at +3 s, result at +8 s | 1 | **1** | +12517 ms *(two turns)* | "Sure, checking that now. **Done: 3 of 3 replicas healthy, no failed**" |

Cost: nine sessions, 6.9 session-minutes in total, ≈US$0.35 at the published $0.05 per voice-session
minute (billed per second, no rounding). Every append was ≤61 bytes, far under the 500-token cap; the cap
itself was measured in story 2 and is not re-measured here.

## The number

**The window, as a deadline to send an append:**

```
delegation.created                        t = 0
turn's output timeline ends                +2390 … +2994 ms   (median +2668, n = 8)
injection latency (ack − send)             +642 … +924 ms     (median ≈ +740)
──────────────────────────────────────────────────────────────
an append must be SENT by                 +1650 … +2255 ms   (median ≈ +1930)
latest send that was placed, observed     +2003 ms            (milestone-2)
earliest send that was NOT placed         +2005 ms            (frontier probe-6)
```

The frontier run locates the edge from both sides: probe-5 (sent +1604 ms) was placed; probe-6 (sent
+2005 ms) was not. The milestone run placed an append sent at +2003 ms and refused the next at +4005 ms.
Both agree with `turn end − injection latency`, so the rule is **injection must land before the turn's
timeline runs out**, not "the send must be early" in itself.

**Why it is that short:** `session.delegation.created` does not arrive at the start of the turn. It arrives
≈4.4–4.9 s into it, every time, in all nine runs. The turn's timeline is ≈7.1–7.5 s long (7.11, 7.20, 7.20,
7.22, 7.23, 7.27, 7.30, 7.45, 7.45 s). The window is the remainder.

**The first reading here was wrong, and this is what refuted it.** I read the `output_audio.delta` stream as
the model speaking, so a 7.2 s turn looked like 7.2 s of speech and the pattern looked like a speech-length
cap. It is not: decoding the **full payloads** in W1's evidence (`spike/evidence/w1-m4-events.jsonl`, which
records audio bytes, unlike these runs) gives an RMS envelope in which **49 of 74 deltas are digital silence
(RMS 0)**. The model's audible speech — "Okay, checking now." — begins at the 50th delta, ~300 ms *after*
the delegation. So the turn's timeline is mostly silence, the model says very little, and the emitted
audio length is not the model's utterance length. (These runs record audio as a byte count rather than as
bytes — deliberate: the PCM is reproducible from the tracked fixture and the measurement here is timing.
The envelope therefore comes from W1's run, which used the same session shape and the same utterance.)

## The three hypotheses

| # | hypothesis | verdict | the observation that decided it |
|---|---|---|---|
| 1 | completion tracks the local setting → ownership of the timeout is real | **confirmed as ownership, refuted as leverage** | The `timeout` run sent nothing and the session sat silent for 45 s: the client's own 10 s bound, and only it, decided that nothing was ever delivered. So the timeout is ours. But setting it above the turn (`final` @45 s, @90 s) delivered nothing either, so owning it buys **no** window. |
| 2 | provider expiry is independent of it → we do not own the whole window | **not supported — no expiry observed** | Two sessions were held open with an unanswered delegation for 45 s and 90 s. Nothing expired, nothing complained: no error, no event, no turn, only `session.usage.updated` every ~15 s until `session.closed`. The only thing that ever stopped a placement was the turn ending. |
| 3 | the window is the model's *generation* and it closes first | **confirmed** | Placement stops exactly where the turn's output timeline stops, in eight runs, from both sides of the edge. And the positive control: the `interrupt` run placed a result **+8010 ms** after the delegation — far outside any 2.7 s window — because a barge-in had started a *new* turn, and the model spoke it aloud ("Done: 3 of 3 replicas healthy, no failed"). The window is not the delegation's; it is whatever turn is generating. |

**What would falsify hypothesis 3** — the observation to go and get if it is ever doubted: a single append
placed while no turn's timeline was running, i.e. an acknowledgement for a send made ≳3 s after the last
`output_audio.delta` of the current turn with no new turn in between. Four runs waited 12–45 s for that and
saw none.

**Hypothesis 2's falsifier** is the mirror image: an append silently dropped, or a typed refusal, at a
*time* horizon that does not move with the turn — or any event naming an expired delegation. None appeared
within 90 s.

**Two hypotheses about the window's *elasticity* were also tested, and both failed:**

- **Milestones do not buy time.** 24 spoken milestones at 2 s cadence: two placed, then the turn ended and
  the remaining 22 were dead. The transcript shows the model being **cut mid-clause while reading the
  injected milestone** — "Okay, I'll check on that. Progress one:" — which is a truncation, not the end of
  a sentence the model chose to finish.
- **Instructions do not move it.** The `stall` instructions asked the model to keep talking until the
  result arrived; the turn ended at +2644 ms like every other, cut mid-clause at "Checking in now,". And
  the `early` run asked it to delegate *before saying anything*: it complied — its entire utterance is
  "One moment." — and `delegation.created` still arrived ≈4.5 s into the turn. The delegation lands where
  it lands.

## The interruption and late-result cases (invariant 7)

Invariant 7 says interruption is not cancellation, and the plan asks for the late-result case explicitly.
Both halves are now measured:

- **A late result with no new turn is lost silently.** `final` @45 s and @90 s: one `context_injection_incomplete`
  at close, one per append, nothing heard.
- **A late result with a new turn is placed and spoken.** The `interrupt` run barged in at +3 s, and
  delivered the first delegation's result at +8010 ms. It was acknowledged in 924 ms, the model spoke it
  verbatim, and the session closed with **zero** `context_injection_incomplete`. A barge-in did not cancel
  the delegation, and it re-opened the window.

That is the design's opening: narration cannot extend one turn, but a *new turn* is a fresh window, and the
provider gives you one for free every time the user speaks — or when anything else makes the model generate.

## What this means for narration (the design fill-in)

1. **Narration has about two seconds, not two minutes.** From `delegation.created`, an append must be sent
   within ≈1.9 s (measured 1.65–2.26 s) to be injected before the turn's timeline ends. A responder that
   answers quickly still makes it; a responder that thinks for three seconds does not.
2. **The plan's "speak the milestones during the 45-second wait" is not merely unpaced — it is out of the
   window by a factor of ~20.** Story 2's reading stands and is now quantified.
3. **The plugin cannot widen the window.** `delegationTimeoutMs` is genuinely ours (hypothesis 1) and
   genuinely useless for this: it governs when *our* client stops waiting, and the provider does not care —
   it will hold an unanswered delegation open for at least 90 s and say nothing. **Do not raise
   `delegationTimeoutMs` expecting to be heard longer** (story 4's decision, now evidence-backed).
4. **What the responder must do when its answer would land after the window.** Three outcomes already
   exist at the consumer (story 2): placed, refused, and *queued into nothing*. The third is the one a slow
   answer hits, and — this is the part the protocol does not help with — it is **silent until the session
   closes**. So the responder must infer it locally: an append that is not acknowledged within the observed
   injection latency (642–924 ms) should be treated as **not heard**, not as sent. Its options are then (a)
   hold the result and deliver it on the next generation — measured to work, and the only route that needs
   nothing from the user — or (b) surface it in text. It cannot wait for the provider to tell it.
5. **Do not equate "the turn is over" with "the model stopped talking".** The turn's timeline is mostly
   silence; a consumer reasoning about audibility from the transcript will misjudge the window.
6. **What to measure next if the window is to be exploited.** The window's length is `turn length −
   delegation offset`, and both are the provider's. This probe could not move either. So the only lever the
   plugin has is *when the responder answers*, and the only path it owns for a late answer is the next
   turn. Story 3 should be designed against that, not against the 45-second wait it was imagined around.

## Open question, recorded rather than guessed

**What sets the turn's length (~7.2 s) and why the delegation lands ≈4.5 s in.** Ten measurements agree
closely, and two instructions aimed at widening the window changed nothing, which is consistent with a
provider-side turn budget. It is *not* established: the model may simply be declining to talk, and this
probe cannot separate a cap from a choice, because every generation it elicited stopped at the same point.
What would settle it: one turn that generates materially longer **without** a new user turn — e.g. a much
longer input utterance, or a longer spoken response the model is willing to give. That is a protocol
question, not a narration one, and the window measurement here does not depend on the answer: whichever it
is, ~2.7 s is what the current session shape offers.

## Corrections to earlier docs, from this evidence

- **`session.usage.updated` arrives every ~15 s, not "roughly once a minute."** Measured intervals: 15.10,
  14.95, 15.05, 14.95, 14.96 s in the 90-second run. The earlier figure was inferred from a 23-second
  session in which only one update fitted. `docs/protocol.md` and `docs/w1-delegation-envelope.md` are
  corrected.
- **`session.closed`'s `usage` is not cumulative.** Every update *and* the final payload carried
  `{"seconds": 7}` — identical values, 15 s in and at close — in all seven single-turn runs, and `13` in
  the two-turn run. A 90-second session closed at `7`. It is not a session-duration meter, and a consumer
  that presents it as "total session usage" is misreporting. What it does count is not separated here.

## Reproduce

```bash
# one run per shape; SHAPE selects the experiment and EVIDENCE names the tracked file
SHAPE=frontier  EVIDENCE=spike/evidence/usable-window-frontier.jsonl      node spike/usable-window.mjs
SHAPE=final   TURN_MS=3000   EVIDENCE=spike/evidence/usable-window-final-3000.jsonl    node spike/usable-window.mjs
SHAPE=final   TURN_MS=45000  EVIDENCE=spike/evidence/usable-window-final-45000.jsonl   node spike/usable-window.mjs
SHAPE=final   TURN_MS=90000  EVIDENCE=spike/evidence/usable-window-final-90000.jsonl   node spike/usable-window.mjs
SHAPE=milestone TURN_MS=45000 MILESTONE_MS=2000 EVIDENCE=…/usable-window-milestone-45000.jsonl node spike/usable-window.mjs
SHAPE=stall     TURN_MS=45000 MILESTONE_MS=2000 EVIDENCE=…/usable-window-stall-45000.jsonl     node spike/usable-window.mjs
SHAPE=interrupt BARGE_IN_MS=3000 LATE_MS=5000   EVIDENCE=…/usable-window-interrupt.jsonl       node spike/usable-window.mjs
SHAPE=final     TURN_MS=45000 CLIENT_TIMEOUT_MS=10000 EVIDENCE=…/usable-window-timeout-10000.jsonl node spike/usable-window.mjs
SHAPE=early     TURN_MS=3000    EVIDENCE=…/usable-window-early-3000.jsonl                     node spike/usable-window.mjs
```

Each run writes JSONL to `spike/evidence/` and prints a per-append table with send times, acknowledgement
latencies, injection offsets and any refusal verbatim, plus a `--- usable window ---` block naming the
frontier. The key is read from `OPENAI_LIVE_API_KEY` (or `VOICE_TOOLS_OPENAI_KEY` / `OPENAI_API_KEY`) and is
never logged, written or echoed; the evidence files contain events only — audio payloads are reduced to
their byte length, since the PCM is reproducible from the tracked fixture.
