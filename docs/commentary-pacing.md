# S3 story 2 — what pacing does the append path actually support?

**Date:** 2026-10-09 · **Status:** ⚠️ superseded in part — see the correction below
**Probe:** `spike/commentary-pacing.mjs` · **Evidence:** `spike/evidence/commentary-{pacing,narration,session-scope}.jsonl`

> **Corrected 2026-10-09 by [story 1](usable-window.md).** The headline below — *an append is placed into the
> model's currently generating speech, or it is not placed at all* — is **superseded**. Placement requires the
> session **timeline** to advance, and the timeline advances with the session's audio. Every measurement in
> this document was taken with the probe's input stream **stopped** once the utterance ended, which froze the
> timeline ≈2.7 s after `delegation.created` and deferred everything sent afterwards. With the input stream
> kept alive — what a real client does; the probe's `KEEPALIVE=1` — **25 of 25 appends were placed across
> 24 s while the model generated nothing**, and a 45-second milestone stream placed 24 of 24.
>
> **What survives unchanged:** the scope finding (run 1 vs run 4 — `delegation_id: null` is placed by the same
> mechanism as a per-delegation id, and run 1's silence is explained by the same missing audio, not by scope);
> the 500-token refusal verbatim; the ack's shape, latency and lack of content; `session.close`; and the rule
> that an unacknowledged append must not be reported as sent.
> **What does not:** the pacing conclusion, and the claim that the placement window is the model's
> *generation* — a silent `thinking` append is placed whenever the timeline is running.

S3 story 3 wants narration "spoken for milestones, silent for chatter". That sentence is unfalsifiable
until somebody measures the append path, and the plan says so: *answer before designing*. Four real
sessions later, the answer is not the one the design assumed.

## The result in one line

**An append is placed into the model's currently generating speech, or it is not placed at all.** The
acknowledgement means *placed*, it carries the audio offset it landed at, and it arrives in 600–840 ms.
An append that arrives while the model is not generating is accepted, silently queued, never
acknowledged, and reported — one error per append — as `context_injection_incomplete` when the session
closes.

## What was measured

Four runs, each one session, against `wss://api.openai.com/v1/live/sessions` with `gpt-live-1` and
`delegation: { type: 'client' }`. Every run streamed `spike/fixtures/audio/deleg.pcm` (4.44 s: *"check the
deployment status of the staging environment"*) so a turn existed to place into.

| run | what it did | appends | acked | note |
|---|---|---|---|---|
| 1 | session scope, **no audio streamed** | 10 | **0** | every one incomplete at close — the run that produced the wrong first reading |
| 2 | delegation scope: burst of 5 · 5 spaced 1 s · 5 thinking · while speaking · over-cap | 17 | 5 | the burst, and only the burst |
| 3 | delegation scope, **narration shape**: 12 progress appends at 500 ms, then the result, then thinking | 14 | 4 | the model's turn ended after the fourth |
| 4 | session scope, same phases as run 2 | 17 | 9 | refuted run 1: `delegation_id: null` is placed perfectly well |

### Pacing, from run 4 (the cleanest)

```
burst ×5, sent in the same millisecond   → all five placed, acks 837 ms, injection at 1800–2000 ms
spaced ×4 at 1 s                          → placed, acks 602–721 ms, injection 2000–7000 ms
spaced ×5 at 10.1 s                       → not placed (the model's turn had ended)
thinking ×5 in a burst at 12.6 s          → not placed
commentary while no audio was flowing     → not placed
over the token cap                        → validation refusal, see below
7 un-acked appends                        → exactly 7 `context_injection_incomplete` at close
```

**A burst is fine and 2 Hz is fine.** Five appends in the same millisecond were all placed, acknowledged
in send order, and no rate-limit refusal was seen at either cadence. The loudest thing the probe was
built to look for — a throttle on progress commentary — does not appear to exist.

**The acknowledgement does not name what it acknowledged.** The ack is `session.commentary.appended` with
`start_ms`, `end_ms` and an `event_id`, and no content. Correlation is therefore **by arrival order**,
which the probe records explicitly rather than implying the payload identified anything.

**`start_ms`/`end_ms` is the injection's position in the audio timeline** — the point in the spoken stream
where the content was placed. That is a genuinely useful design fact: it is how a consumer could tell
where narration landed relative to what was said around it.

**The cap is enforced, typed, and says so verbatim.** One append of ~900 tokens:

```json
{"type":"invalid_request_error","code":"invalid_value",
 "message":"Context append text must not exceed 500 tokens.","param":"content"}
```

Note the shape: a *validation* refusal, arriving immediately, unlike the silent non-placement above. Two
different failures that a consumer must not conflate — one means "rewrite it shorter", the other means
"nobody will ever hear this".

**`session.close` works** (it was listed as unexercised in `docs/w1-delegation-envelope.md`) and
`session.closed` carries `reason: "close_requested"` and cumulative `usage: {"seconds": 7}`. The
per-injection incompleteness is reported only at that point — which is why a narration bug of this kind
would be invisible during a session and loud only in its final events.

## How the first reading was wrong, and what refuted it

Run 1 sent its appends with `delegation_id: null` and streamed **no audio**, and every append went
unacknowledged. The obvious reading was *"session-wide commentary is not a thing the server places"* — and
it was wrong. Run 4 sent the identical schedule with `delegation_id: null` and streamed the utterance:
nine of seventeen were placed.

The difference was never scope. It was **whether there was a turn to place into**. Run 1's session had
nothing to respond to, so the model never generated, and every append was dead — which the close-time
errors then said plainly, in a run I had already read as a result about scope.

That is the pitfall this repository keeps relearning: *a negative is only as good as the reach of the
search behind it*, and a variable that moved with the one under test will be read as the cause. Both runs
are kept as evidence for that reason, and the probe now runs the scope under test with the same audio.

## What this means for narration (S3 story 3)

1. **Progress cannot be narrated while the agent works, in the obvious sense.** The plan's shape —
   append milestones during the 45-second wait while the model holds the turn — is precisely the case that
   measured as *never placed*. The placement window is the model's **generation**, not its turn's
   lifetime, and a model waiting for a delegation is not generating.
2. **This makes S3 story 1 the prerequisite rather than the neighbour** — and it is answered, twice: see
   [story 1](usable-window.md). The window is the session **timeline**, and it advances while audio is in
   flight, so a delegated result was placed at +3 s, +45 s and +90 s with the input stream kept alive, and
   never with it stopped. **This document's own conclusion is the artefact:** the probe stopped streaming
   audio, which froze the timeline. The design question the plan was built around is therefore open again in
   the *permissive* direction — progress can be narrated during a long wait, provided the client keeps
   feeding the timeline.
3. **The result append is the thing at risk.** In run 3 the delegation's *result* — the only append that
   must be heard — was sent after the model stopped generating and was never placed. The existing
   responder answers quickly enough to land inside the window today, which is why nobody has seen this;
   the design must decide what happens when it does not, rather than discovering it as silence.
4. **Failures need to be distinguishable at the consumer.** Three outcomes now exist and only two are
   errors: placed (acked, with offsets), refused (typed, immediate, actionable), and *queued into nothing*
   (silent until close). A narration layer that reports all three as "sent" is the `catch {}` mistake in a
   new place.

## Reproduce

```bash
node spike/commentary-pacing.mjs                      # run 2 shape: delegation scope, bursts, cap
MODE=narration node spike/commentary-pacing.mjs       # run 3 shape: narration cadence
SCOPE=session node spike/commentary-pacing.mjs        # run 4 shape: the same, session scope
```

Each writes JSONL to `spike/evidence/` and prints a per-append table with send time, acknowledgement
latency and the refusals verbatim. Cost is one short session per run (`usage.seconds` was 7 in every case).
The key is read from `OPENAI_LIVE_API_KEY` (or `VOICE_TOOLS_OPENAI_KEY` / `OPENAI_API_KEY`) and is never
logged, written or echoed — the evidence files contain events only.
