# Review — `sprint-plan-voice-presence.md` (v1, 2026-10-15)

**Reviewer lens:** Quality engineering & test architecture — falsifiability, test independence,
coverage realism, and whether a gate actually bites.
**Date:** 2026-10-15
**Artifact under review:** `docs/sprint-plan-voice-presence.md` (22 KB, 336 lines)
**Confidence:** high on the codebase facts (every load-bearing claim below was read on disk, not
inferred); medium on the "what should replace it" fixes, where the right answer depends on a live probe
this review cannot run.

## Files read IN FULL

- `docs/sprint-plan-voice-presence.md`
- `docs/design.md` (the 8 invariants), `docs/decisions.md` (ADR-001/003/007/008/009)
- `docs/protocol.md`, `docs/w1-delegation-envelope.md`, `docs/session-messaging.md`
- `packages/realtime-responder/src/turn.ts`, `packages/realtime-responder/src/index.ts`
- `packages/realtime-responder/tests/turn.spec.ts`, `packages/realtime-responder/tests/plugin.spec.ts`
- `packages/realtime-agent/src/index.ts`, `.../src/bridge.ts`, `.../src/transcript.ts`, `.../src/types.ts`
- `packages/realtime-audio-ws/src/bridge.ts`, `.../src/strip.ts`, `.../tests/strip.spec.ts`
- `packages/realtime/src/types.ts`
- `packages/realtime-replay/src/recording.ts`, `.../tests/recording.spec.ts`
- `tests/fault-matrix.spec.ts`
- `vitest.config.ts`, `package.json`, `packages/realtime-responder/package.json`
- `scripts/declared-dependencies.mjs`, `scripts/leak-scan.mjs`, `scripts/built-composition.mjs`,
  `scripts/client-artefact.mjs`
- `.github/workflows/ci.yml`, `.github/workflows/canary.yml`

## Sampled / not read in full

- `research/*.md` (spot-checked the plan's citations only; not re-derived)
- `packages/realtime-openai/src/*`, `packages/realtime/src/journal.ts`, `docs/diagnostics.md`
- harness internals under `~/dev/deepseek-harness` (quoted only via `docs/session-messaging.md`)

---

## Findings

| id | severity | summary |
|---|---|---|
| Q-01 | CRITICAL | P1 retires the wrong unknown. The decisive question — can an out-of-tree plugin reach `agent.inject()` / `agent.followup()` / `createUserMessage()` at all — is named as "decides the size of everything after it" by the plan's own evidence, yet is not one of P1's three spike measurements. |
| Q-02 | CRITICAL | The four classification fixtures are **authored**, not **recorded**. A keyless fixture cannot encode what a model *intends*; the test asserts the classifier agrees with the author's own label, so it passes whatever the classifier does to real delegations. |
| Q-03 | CRITICAL | 100 % per-file coverage is actively misleading here: a classifier that returns `question` for everything is trivially 100 %-coverable and passes every fail-closed test while the feature does nothing. No criterion measures that the verbs ever fire. |
| Q-04 | CRITICAL | P4's "an interrupted `say` logs only what was heard" is unsatisfiable against *this* provider and unobservable from the node side. Mapped to `packages/realtime-agent/tests/truncation.spec.ts`, which cannot see playback and has no provider interruption event to key on. |
| Q-05 | HIGH | P3's headline criterion — "a planted directive inside a note is proven not to execute as an instruction" — is not offline-testable. The receiver is the harness/model, not this repo; only the structural half can be asserted. |
| Q-06 | HIGH | The `say` path (followup → `ctx.sessions.flush()` → "require the acknowledgement") collides with the two existing timeout windows; the plan sets no criterion bounding a `say` inside `delegationTimeoutMs`, and the shipped answer path regresses if it overruns. |
| Q-07 | HIGH | Using a harness package at *runtime* (`createUserMessage` from `dsh-llm`; `resolveAgent` from `dsh-api-session-controller`) trips `pnpm declared-deps` — devDependencies are not in the declared set — and contradicts the responder's stated "no runtime dependency is taken". The plan names no manifest change. |
| Q-08 | HIGH | The traceability table maps two-sided criteria to one file, and one criterion to the wrong package: `marker.spec.ts` (render **and** model path) → client only; `no-echo.spec.ts` in realtime-responder although "the bridge" lives in realtime-agent / realtime-audio-ws; `note-trust.spec.ts` in realtime-responder although the enforcing receiver is the harness. |
| Q-09 | HIGH | P2's headline criterion — "the session log shows a note and a say, both `source.kind: 'realtime'`" — is not machine-checkable offline; `source.kind` is stamped by the harness. As written it can only be met by a live checkpoint, under a bullet that claims machine-verifiability. |
| Q-10 | HIGH | The write-path change rewrites the interfaces both existing suites fake. `plugin.spec.ts`'s `FakeSessionController` and `fault-matrix.spec.ts`'s `FakeController` implement only `prompt`. The plan lists no fixture migration, so the regression suite either rots or fails without a story that owns it. |
| Q-11 | OBSERVATION | P1's "no cell marked ❓" and "the classification contract exists" are self-reported. A doc existing is exactly the state ADR-008 calls "a file nothing reads". No machine check reads either. |
| Q-12 | OBSERVATION | The classification contract hides the asymmetry of its failures and states no acceptable ambiguity rate, so "ambiguous → question" can conceal a total loss of the `say` recall with every test green. |
| Q-13 | OBSERVATION | The cross-cutting invariant-5 claim ("a spike that adds a wire observation must land in the canary's fixture") is imprecise: the canary has no fixture (it keeps a literal event list, per `protocol.md`), the fixture lives in `packages/realtime-openai/tests/fixtures/`, and the canary is neither in `pnpm gate` nor in CI's PR job. |
| Q-14 | OBSERVATION | Sprint sizing: P2 bundles a seam-level source declaration, two writers, no-echo, idempotency and reason-journaling across ≥2 packages — and its true size is unknowable until Q-01 is resolved. |

---

### Q-01 — P1 retires the wrong unknown (CRITICAL)

**Claim in the plan.** "This makes the classification the load-bearing risk of this whole plan, and it is
why **P1 exists and comes first**" (lines 84-87). P1's three spike measurements are all about whether a
function/tool declaration is accepted and whether the model emits a structured intent.

**Evidence.** The plan's own evidence base names a different, prior unknown as decisive —
`docs/session-messaging.md` §5 (lines 269-274):

> "**The honest gap, which the next slice must probe before anything is designed on top of it:** whether
> an out-of-tree plugin composing with the seam can reach `agent.inject()` and `createUserMessage()` from
> a consumer row, or whether that requires a provider seam the harness owns. … **Probe that first; it
> decides the size of everything after it.**"

P2 story 4 then *assumes* that reachability ("`agent.inject(sourcedUserMessage)`: `next-step` inbox, no
turn. The mechanism is public and documented on the Agent runtime type" — line 171). The responder today
does not use it: `packages/realtime-responder/src/index.ts` calls `controller.prompt(...)` (lines 483-488)
with only a **type-only** import of the controller (`import type { SessionController }`, line 40), and its
own comment insists "Type-only, and erased: no runtime dependency is taken, and the harness package
remains the host's" (line 69-70). Nothing in the repo exercises `inject`/`followup`.

**Why it matters.** If reachability fails, P2-P4's design is void, not merely delayed — and P1 would have
certified "gate green" and "no cell marked ❓" over a plan built on an unprobed assumption.

**Fix.** Make reachability a P1 measurement (measurement 0), and make its *negative* outcome a shipped
artefact: if an out-of-tree row cannot reach `inject`/`followup`, record that in `docs/delegation-intent.md`
and re-scope P2 before it is estimated. The spike cannot be keyless (it needs an installed harness), so
its result must land as a **recorded** transcript + fixture, not as a sentence.

---

### Q-02 — The classification fixtures are authored, not recorded (CRITICAL)

**Claim in the plan.** "Fixtures for: an unambiguous note, an unambiguous say, a bare question, and a
delegation that could be either — the last must classify as a question" (lines 141-143); "four fixtures
replay **keylessly**, including the ambiguous one resolving to a question" (line 148).

**Evidence.** ADR-003 (`docs/decisions.md` lines 42-51) defines keyless replay as running "against
**recorded session fixtures**". The recording format is `{t, event}` frames parsed by
`packages/realtime-replay/src/recording.ts` and read from a file
(`packages/realtime-replay/src/recording.ts:70-81`). A delegation, per `docs/protocol.md` line 100 and
`packages/realtime-agent/src/types.ts:23-32`, "carries **no task text** — only `{id, type, target}` and
`offset_ms`". So a recorded delegation frame carries **no words to classify**. The words a classifier
would see exist only inside our own `transcript` reconstruction
(`packages/realtime-agent/src/turn.ts:176-188` builds a prompt from `request.transcript`). A fixture for
classification therefore has to carry a hand-written `transcript`, which no provider ever recorded.

**Why it matters.** The test the plan proposes asserts `classify(fixture) === fixture.expected`, where the
author wrote both the `transcript` and the `expected`. It cannot fail because the classifier is *wrong*
about a real delegation — only because it disagrees with the author's own encoding. It will pass for every
plausible implementation, which is the definition of test theatre. And because ADR-003 forbids the API key
in CI, nothing later regenerates the fixture against the model, so it can never be corrected by reality.

**What a test that can actually fail looks like.**
1. Label independently of the encoder: record the *live* session in which a user said something the model
   chose to delegate, and record the user's intent (note/say/question) as metadata **before** writing the
   classifier, in a file the classifier's author did not author.
2. Keep an **adversarial negatives** set — delegations a naive rule misclassifies (e.g. a question whose
   transcript contains the token the rule keys on), written by someone who has seen the rule.
3. Pre-register an accuracy/ambiguity-rate threshold the corpus must meet and fail the suite below it.
4. Version the corpus and record *provenance* per fixture: which live session (`spike/evidence/*.jsonl`
   already exists, `spike/evidence/`), at which offset, with which utterance — so a reader can re-derive
   the label rather than trust it.

---

### Q-03 — 100 % per-file coverage is actively misleading for a heuristic (CRITICAL)

**Claim in the plan.** "**100% per-file coverage maintained**, both growing" is part of every sprint's
definition of done (lines 278-279).

**Evidence.** `vitest.config.ts:37-43` enforces `perFile: true` on statements/branches/functions/lines,
`include: ['packages/*/src/**/*.ts']`, `exclude: ['packages/*/src/types.ts']`. Every new logic file (a
classifier, a writer) is therefore in scope. But a classifier has two trivial 100 %-coverable
implementations that defeat the whole feature: `() => 'question'` and `() => 'note'`. Either one covers
every line and branch, and — crucially — the **first one passes every fail-closed test in the plan**. The
plan's stated safety property ("an unclassifiable delegation is answered as a question", lines 89-91) is
exactly the behaviour of a classifier that never fires, so the fail-closed tests are green for a feature
that does nothing.

**Why it matters.** Coverage here is not merely uninformative; it reports 100 % on a broken feature, in a
repo whose thesis is "a threshold nobody fails is not a gate".

**Fix.** Add a criterion that coverage cannot satisfy: a **positive-rate floor** over the labelled corpus
("no fewer than N of the corpus's note/say fixtures classify as note/say"), asserted as its own test, and
a **degenerate-classifier guard** (a test that asserts a constant classifier fails the rate check). State
plainly in `docs/delegation-intent.md` that coverage is not the accuracy gate for this module, and that
the corpus is.

---

### Q-04 — "An interrupted `say` logs only what was heard" cannot be tested (CRITICAL)

**Claim in the plan.** P4 story 3 (lines 248-252) and its exit criterion "an interrupted `say` logs only
what was heard" (line 259), mapped to `packages/realtime-agent/tests/truncation.spec.ts` (line 308). The
supporting argument cites "ElevenLabs `agent_response_correction` … LiveKit truncating 'to match the
spoken output' … Pipecat committing only words that actually played" — all **other** vendors.

**Evidence.**
1. This provider emits no interruption event. `tests/fault-matrix.spec.ts:461-472` asserts exactly that
   against the recorded live session: `expect(types.filter(type => /interrupt|speech_started|speech_stopped|response\.cancel/.test(type))).toEqual([])`, and both `docs/protocol.md` (server→client list, lines
   81-87) and `docs/design.md` invariant 2 concur (§"No hand-rolled VAD"). The plan's own evidence base
   says so.
2. Playback happens in the browser. `packages/realtime-audio-ws/src/bridge.ts:78-83` forwards PCM frames
   to the socket; nothing server-side ever learns how many played. The journal is explicitly forbidden
   from claiming it: `tests/fault-matrix.spec.ts:444-452` asserts the record does **not** contain
   `speech.sent` for a case where "no speaker was ever involved" (invariant 6, `docs/design.md` line 74).

**Why it matters.** A node-side spec file in `packages/realtime-agent` has neither a provider signal nor a
playback signal to assert on. As written, the file would have to invent a fact — precisely the class of
lie the fault matrix exists to prevent.

**Fix.** Either (a) drop the criterion, or (b) replace it with the only honest, checkable form: a **new
client→server control frame** that reports played-bytes on barge-in, asserted in a
`packages/realtime-audio-ws/tests/*.spec.ts` that drives the bridge's control channel
(`packages/realtime-audio-ws/src/bridge.ts:115-123` already routes text frames), plus a redaction-sweep
and fault-matrix row for the new event — and map the criterion to that file, in that package, not to
realtime-agent.

---

### Q-05 — "A planted directive does not execute" is not offline-testable (HIGH)

**Claim in the plan.** P3 exit criterion: "a planted directive inside a note is **proven not to execute as
an instruction** (a test that fails if it does)" (lines 219-220), mapped to
`packages/realtime-responder/tests/note-trust.spec.ts` (line 306).

**Evidence.** The directive's execution happens inside the harness's model loop, which is out of tree. The
responder's unit tests run against plain fakes (`packages/realtime-responder/tests/turn.spec.ts:1-11`
imports only from `../src/turn.ts`; `plugin.spec.ts:53-63` mounts a `Context` with a `FakeSessionController`
and the real seam — no model, no agent loop). A test can assert that the responder **put content only** on
the note channel and that `capabilities: { canStartTurn: false }` was set, but not that a model obeyed or
ignored anything.

**Fix.** Split the criterion in two and label each honestly:
- (machine-checked) "a note carries no directive channel: the writer is called with content and no
  instruction-bearing field, and the note's payload carries `canStartTurn: false`."
- (live/checkpoint) "a session given a note whose content contains an imperative does not act on it" —
  owned by the user checkpoint, with the transcript recorded from the run.
The plan's parenthetical "(a test that fails if it does)" is the tell: name the file and the assertion, or
drop the claim.

---

### Q-06 — The `say` confirmation collides with the timeout windows (HIGH)

**Claim in the plan.** "`say` writes and starts a turn — `agent.followup(sourcedUserMessage)`, then
`ctx.sessions.flush()` and **require the acknowledgement** before reporting success" (lines 167-169).

**Evidence.** `packages/realtime-responder/src/index.ts:25-33` states the constraint the plan must respect:

> "A DSH agent turn can run for minutes. The delegation asking for the answer is bounded (the agent's
> `delegationTimeoutMs`), and so is this responder's `answerTimeoutMs`. **The smaller bound decides what is
> heard.**"

`delegationTimeoutMs` defaults to 10 000 ms (`packages/realtime-agent/src/index.ts:152`) and is 180 000 ms
live (`docs/session-messaging.md:43-45`); `answerTimeoutMs` defaults to 45 000 ms
(`packages/realtime-responder/src/index.ts:125`). `answerDelegation` races the responder against
`delegationTimeoutMs` (`packages/realtime-agent/src/bridge.ts:131-137`). A `say` that waits for a flushed
turn's acknowledgement will, for any turn longer than the delegation bound, time out and the voice will
speak `UNANSWERED_NOTICE` (`bridge.ts:11`) — even though the write succeeded.

**Why it matters.** The plan adds a new, longer-latency success path with no criterion bounding it, and the
existing comment already identified this exact hazard as "the follow-up this plugin does not yet do:
acknowledge immediately and speak the result when it lands" (`index.ts:31-33`).

**Fix.** Add a P2 exit criterion that names the intended resolution — either "the `say` returns inside
`delegationTimeoutMs` (measured, asserted against a slow-turn fixture)" or "the `say` acknowledges
immediately and the result is spoken on a later append, with a test that the late append is dropped when
the delegation is gone" (the drop path already exists: `realtime-agent/src/index.ts:536-543`).

---

### Q-07 — A runtime harness import trips the declared-deps gate (HIGH)

**Claim in the plan.** P2 stories 3-4 introduce `agent.followup(...)`, `agent.inject(...)` and
`ctx.sessions.flush()`, and P2 story 2 requires an actor id "minted by our bridge" (lines 165-171).

**Evidence.** `scripts/declared-dependencies.mjs:144-148` builds its `declared` set from
`dependencies`, `optionalDependencies` and `peerDependencies` only — **not** devDependencies — and reads
**shipped `.js`** (`files` = `["lib","src"]`, so `lib/*.js`; line 149-158). In
`packages/realtime-responder/package.json`, `@deepseek-ai/dsh-api-session-controller` is a
**devDependency** (line 58) and `@deepseek-ai/cordis`/`schemastery` are peers. `createUserMessage` lives in
`dsh-llm` (`docs/session-messaging.md:169`, `:272`) and is declared nowhere here. The script's own doc
records a prior `ERR_MODULE_NOT_FOUND` of exactly this shape (lines 4-15). The responder's source also
states the design rule the plan would break: "Type-only, and erased: no runtime dependency is taken"
(`packages/realtime-responder/src/index.ts:69-70`).

**Fix.** Make the dependency change an explicit story with the gate consequence named: add
`@deepseek-ai/dsh-api-session-controller` (and `dsh-llm` if used) to `dependencies` or `peerDependencies`
in the affected manifests, and state in the plan that `pnpm declared-deps` is what forces it. Do not leave
it as an implementation detail — this is the gate that caught the last shipping bug of this class.

---

### Q-08 — The traceability table maps criteria to the wrong files (HIGH)

**Claim in the plan.** "Acceptance criteria resolve to files, so a reviewer can check rather than trust"
(lines 294-309).

**Evidence — the good news first.** The two files the table points at that already exist are correct:
`packages/realtime-responder/tests/turn.spec.ts` exists, and `packages/realtime-audio-ws/tests/strip.spec.ts`
exists, and the plan's line reference `realtime-audio-ws/src/strip.ts:52-62` is exactly `stripMarkup()` (I
read it — the `position:fixed` string is line 55). The proposed *new* filenames match the repo's
`<module>.spec.ts` convention under `packages/*/tests/` (`vitest.config.ts:35`).

**Where it is wrong.**
- **`marker.spec.ts` (P3/P4, line 307)** is mapped to `packages/realtime-audio-ws` but the criterion is
  two-sided — "the marker is in the render **and on the model path**". The render lives in the client half;
  the model path lives in the responder/agent half. One file cannot carry both, and the reviewer will
  believe it does.
- **`no-echo.spec.ts` (P2, line 305)** is mapped to `packages/realtime-responder`, but the plan's own text
  says "**the bridge** refuses to deliver a voice message back into the session that sent it" (line 172).
  There are exactly two bridge modules in this repo — `packages/realtime-agent/src/bridge.ts` (the
  delegation answer path) and `packages/realtime-audio-ws/src/bridge.ts` (the socket) — and neither is in
  `realtime-responder`. Either the write path has a home the plan has not named, or the mapping is wrong.
- **`note-trust.spec.ts` (P3, line 306)** is mapped to `packages/realtime-responder`, but P3 story 3 says
  "**capability is data the receiver enforces**" (lines 207-209). The receiver is the harness; see Q-05.

**Fix.** Re-derive the table *after* the write path's home package is decided (blocked by Q-01), and split
every two-sided criterion into two rows, each naming one file in the package that owns that half. A
traceability table that names the wrong package is worse than none because a reviewer stops checking.

---

### Q-09 — P2's headline criterion is a live claim under a machine-verifiable bullet (HIGH)

**Claim in the plan.** "the session log shows a note and a say, both `source.kind: 'realtime'`, both
distinguishable from a user message … machine-verifiable up to the speaking" (lines 182-186).

**Evidence.** `source.kind` is built by the harness's own `SessionController.prompt()`
(`docs/session-messaging.md:149-161`) and stored in the session log by the harness, not by this repo. No
test in this repo reads a session log; the journal deliberately records sizes and digests, never message
content (`packages/realtime-responder/src/index.ts:191-204`, and `docs/session-messaging.md:63-68` records
the journal "cannot answer 'what was said'"). So the only artefact that could be asserted is the
`UserMessage` object this plugin constructs — which proves *what we passed*, not *what the log shows*.

**Fix.** Rewrite the criterion to something a test can hold: "the writer is called with a message whose
`source.kind === 'realtime'` and whose `form` matches the verb; a recorded session log is committed to
`spike/evidence/` and a test asserts the harness round-tripped those fields" — and move the "the session
log shows it" clause to the user checkpoint explicitly.

---

### Q-10 — The write-path change invalidates both existing fakes, unowned (HIGH)

**Claim in the plan.** P2 changes how the plugin writes, and the definition of done claims `pnpm gate`
green with tests "both growing".

**Evidence.** `packages/realtime-responder/tests/plugin.spec.ts:10-27` fakes `sessionController` with a
single `prompt` method, and asserts on `controller.prompted` / `controller.signals` throughout (lines
156-166, 448-450). `tests/fault-matrix.spec.ts:94-109` fakes the same service with a `prompt` that returns
`{accepted: true}`. If P2 routes writes through `resolveAgent(...).followup/inject`, both fakes are shaped
for a path that no longer exists, and the entire `describe('answering a delegation')` block loses its
subject.

**Fix.** Add a P2 story that owns the fixture migration: "the fakes gain a `resolveAgent` returning an
agent with `followup`/`inject`/`session`, and the existing question-path assertions are re-pointed at it
with no assertion deleted" — and a criterion that the **existing** suite's coverage and kind-signature
assertions (`plugin.spec.ts:332-337` on the exact journal kind sequence) still pass unchanged. That kind
sequence is the strongest regression detector in the repo and the plan should name it as such.

---

### Q-11 — P1's exit criteria are self-reported (OBSERVATION)

"The spike answer is recorded with evidence and **no cell marked ❓**; the classification contract
**exists**" (lines 147-149). Both are properties of prose. ADR-008 (`docs/decisions.md:124-146`) is the
repo's own statement that "a file nothing reads is not a contract". **Fix:** replace with "the recorded
spike fixture contains the observed event, and a `realtime-replay` test asserts it" plus "the contract's
decision procedure is exercised by `delegation-intent.spec.ts`, which is named in the traceability table."

### Q-12 — The contract states no asymmetry or rate (OBSERVATION)

"Fail closed is the design, not a mitigation" (line 89) is right in direction: ambiguous → question →
no write protects the dangerous axis (writing into the session). But the failure modes are asymmetric and
the contract does not say so: `say` → `question` silently degrades to today's behaviour (feature does
nothing), while `question` → `say` writes a durable, sourced message the user never asked for. The plan
asserts fail-closed for the second and provides nothing for the first. **Fix:** state both axes, and set a
pre-registered ambiguity ceiling (Q-02/03).

### Q-13 — The invariant-5 claim is imprecise (OBSERVATION)

"a spike that adds a wire observation must land in the canary's **fixture**" (line 272). `docs/protocol.md`
line 139: "The canary keeps its event list as a literal." The fixture is
`packages/realtime-openai/tests/fixtures/live-session.jsonl` (read by `tests/fault-matrix.spec.ts:91`).
The canary runs on a schedule (`.github/workflows/canary.yml`) and is **not** in `pnpm gate` (package.json
line 70) nor in CI's PR job (`.github/workflows/ci.yml`). **Fix:** name the file and the job.

### Q-14 — Sizing is unknowable while Q-01 stands (OBSERVATION)

The repo's rule is one shippable release per sprint. P2 as written probably touches the responder, the
agent and the seam. Pull the "can we write at all" probe out of P1 into its own story/release so P2 can be
estimated, and so a negative probe cancels a release rather than a sprint.

---

## What survives (the plan is right about these)

1. **The direction of fail-closed.** "An unclassifiable delegation is answered as a question … and **never**
   treated as a write" (lines 89-91) is the correct default and correctly maps invariant 1
   (`docs/design.md:61-62`) onto the new surface. The dangerous axis is the one it protects.
2. **The codebase facts are accurate.** `strip.ts:52-62` is `stripMarkup()` and the `position:fixed` is line
   55 (verified). `protocol.md` does say the endpoint rejects unknown fields, so the spike's measurement 1
   is a real schema probe (line 26). The delegation envelope genuinely carries no kind or intent
   (`packages/realtime-agent/src/types.ts:77-90`; `agent-bridge` request reconstruction in `turn.ts`).
3. **The write primitives are real and correctly named.** `agent.inject` (no waking turn), `followup`/`steer`,
   `ctx.sessions.flush`, and a merge-extensible `MessageSourceMap` are the spine's own, documented on the
   Agent runtime type — `docs/session-messaging.md:165-193` shows the primitives and the `dsh-schedule`
   precedent verbatim. The plan did not invent an API.
4. **The classification risk is genuinely the load-bearing *product* risk.** The reasoning that a model which
   cannot call a tool must have its verbs classified client-side from the envelope is sound.
5. **The idempotency and no-echo stories are right architecture and genuinely testable.** "Exactly-once is
   not a transport property — it is at-least-once delivery plus an idempotent consumer" (lines 175-177) and
   "it must not be a model instruction" (line 174) are both choices that produce *falsifiable* tests in our
   own code, unlike the classification.
6. **Traceability to files is the correct instinct**, and the plan points at two files that exist and uses
   the repo's own test layout. The problem is execution (Q-08), not the idea.
7. **ADR-008 is correctly applied.** Refusing to mint a metadata file (lines 284-287) is consistent with the
   repo's own ADR and is the right call.

---

## Could not verify (and why it matters)

- **Whether an out-of-tree plugin can reach `agent.inject()` / `createUserMessage()`.** The whole of P2-P4
  rests on it (`docs/session-messaging.md` §5). It needs an installed harness; this review cannot run it —
  which is itself the finding (Q-01).
- **Whether `session.start` accepts a function/tool declaration.** P1's spike is defined by not knowing
  this; it needs a live keyed session.
- **The harness's `session/event` and `MessageSourceMap` runtime shapes beyond what
  `docs/session-messaging.md` quotes.** Sampled only via that doc; I did not read the harness checkout.
- **Whether the P4 client half can actually reach the `sidebarRightTabs` service face.** Flagged as an
  unknown in `docs/session-messaging.md:133-139` and as a top risk by the plan itself; not resolvable from
  this repo.

## Confidence

High that Q-01 to Q-10 describe real defects with the cited evidence; the two severities I would most
expect a second reviewer to re-grade are Q-03 (coverage-as-misleading — real, but a re-reader may call it
HIGH rather than CRITICAL) and Q-04 (unsatisfiable-as-specified — CRITICAL if the criterion ships as
written, moot if it is deleted). Medium on every "Fix" that depends on the unrun probe.
