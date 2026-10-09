# Narrating a delegated turn

S3 story 3's design record. It answers two questions the build may not guess at: **what may be said while a
turn is running**, and **what to do when the answer arrives after the moment it was meant for**. The
measurement behind it is in [`usable-window.md`](usable-window.md); this is what that measurement permits.

## What narration may assume

1. **A step is placed only while the model is generating, and the timeline advances with the audio.** An
   append is put into speech the model is *currently* producing, or into nothing at all — so the window is
   the generation, not the delegation, and it does not open because a turn is outstanding. Measured:
   `docs/usable-window.md`, and the confound that produced the first, wrong number is recorded there
   deliberately.
2. **Keeping the microphone streaming is what holds the window open.** With the input stream alive, 3-, 45-
   and 90-second turns all placed (+3004 / +45006 / +90007 ms, 0 errors). With it stopped, the session
   timeline froze and *nothing* placed. That is an audio-route obligation, not a narration one — but
   narration cannot outlive it, so a step is worth speaking only where the turn is already being held open.
3. **A step costs a message, and the seam caps it at 500 tokens.** Steps are milestones, not a transcript:
   the policy speaks at most a few per turn, paced by `milestoneIntervalMs`.
4. **An ack proves injection, not hearing.** `append.acknowledged` is journalled for exactly that reason
   (invariant 6). No part of this feature may claim a step was heard.

## What may be *said*

**A tool's name, and never its arguments.** The phrase comes from `milestonePhrases`, keyed by the `name`
the session reports; a tool the table does not name is spoken as `milestoneFallback`. This is not a
formatting preference: a tool's `arguments` are model-authored text, and the one path this bundle lets
model-authored words take to a user's ear is the answer, which is redacted on the way out. A step therefore
has no route to the redactor, which is correct — because it never carries anything that needs one.

A `tool/call` is **not** a surface event (`SurfaceEventType` is `system/message · user/message ·
assistant/message · tool/result`), so it carries no `surfaceOp`. A step filter copied from `answerText`'s
(`surfaceOp === 'append'`) drops every step — silently, for ever, and the narration simply never happens.
The event type is the whole filter; `stepTool` is a function with a test for that reason.

## Pacing, and whose choice is whose

The emitter decides; this half carries. `RealtimeDelegationProgress` names a `channel`, reusing the seam's
own distinction — `commentary` is spoken, `thinking` is context the model may keep to itself — so "spoken for
milestones, silent for chatter" is a choice about that one field and nothing else.

The responder forms the policy (`MilestonePolicy`) and paces it per turn: the **first** step is never held
back by the interval, because a turn that has said nothing yet has nothing to be paced against; after that,
a step inside `milestoneIntervalMs` is emitted as `thinking`, and one beyond `maxSpokenMilestones` likewise.
A step held back is still *reported*, so a reader can see it happened — that is the difference between
`thinking` and dropping.

## When the answer would land after the window

**It is appended anyway, and the honest expectation is that it may not be heard.** The alternative — holding
it back because the window looks shut — is worse in every case that matters, because the window is the
model's generation and the model resumes generating to speak. Three cases:

- **An answer that arrives while the model is still generating** is placed, which is the normal case for a
  turn the client kept alive.
- **An answer that arrives after the model stopped** is appended and may fall outside the generation. What
  happens then is the provider's to decide; ours is not to pretend otherwise, which is why nothing in the
  journal claims delivery.
- **A turn that times out** (`answerTimeoutMs`) is already declined out loud, and the milestone steps spoken
  during it are the entire update the user got. That is the case narration exists for.

Consequences for the build, stated so they are not rediscovered:

- **Pace against generation, not against the delegation.** A step scheduled off `delegationTimeoutMs` will
  be spoken at a moment the model may not be producing anything.
- **A step for a delegation nobody is waiting on is dropped**, and a step the provider refuses is journalled
  as `progress.dropped` — a dropped step is not a failed turn, and must not be read as one.
- **Spoken progress does not replace the answer.** It is a bridge across the wait; the answer is still the
  only thing that answers.
