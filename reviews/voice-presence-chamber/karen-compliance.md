# Compliance & audit-trail review — `sprint-plan-voice-presence.md` (v1)

**Date:** 2026-10-15
**Lens:** Compliance, audit-trail integrity, internal-audit discipline. The questions asked of this plan
are: *is the durable record retrospectively trustworthy; is the new capability authorised and
evidenced; what does an auditor need to see to sign off.* Not UX, not architecture aesthetics.
**Reviewer:** Karen — Head of Compliance (adversarial chamber, compliance seat). No persona knowledge
base exists for this seat; every finding below is argued from the artefacts read, all of which are
cited by path and line.
**Artefact under review:** `/Users/asd/dev/dsh-openai-live/docs/sprint-plan-voice-presence.md` (336
lines, v1, 2026-10-15).
**Verdict:** **Not signable as written.** Two findings are blocking. The plan's *engineering* instinct
is sound and much of it survives — but it treats "the record is trustworthy" as an outcome of writing
better tests, when it is an outcome of controlling who may write, preventing the record from containing
fiction, and being able to prove both from an artefact. None of those three is established.

---

## What I read, and how

| Artefact | Coverage |
|---|---|
| `docs/sprint-plan-voice-presence.md` | **IN FULL** (336/336 lines) |
| `research/session-messaging-protocols.md` | **IN FULL** (528 lines) |
| `research/voice-integration-patterns.md` | **IN FULL** (349 lines) |
| `docs/design.md` (8 invariants) | **IN FULL** (118 lines) |
| `docs/decisions.md` (ADR-001..009) | **IN FULL** (180 lines) |
| `docs/session-messaging.md` | **IN FULL** (286 lines) |
| `docs/protocol.md` | sampled — the ❓ convention and every ❓ cell |
| `docs/sprint-plan.md` (v2/v2.1), `docs/releasing.md`, `docs/roadmap.md` | sampled — version/change-control and release discipline |
| `research/market-voice-features.md`, `research/voice-platform-building-blocks.md` | **not read** (cited by the plan; not load-bearing for a compliance finding — see Unverified) |

**Codebase verification (the plan makes checkable claims; I checked them).** All findings that rest on
a codebase or record fact were verified by reading the artefact, not the plan's description of it:

- `packages/api/session-controller/lib/types/commands.js` — the hard-coded provenance defect.
- `packages/realtime-responder/src/index.ts` — how the responder calls it today.
- `packages/llm/llm/src/message.ts`, `packages/llm/llm/src/index.ts` — `MessageSourceMap`, `ContextForm`.
- `packages/llm/...` + `.agents/notes/implemented/architecture/2026-07-24-separate-context-injection-from-turn-execution.md`
  — whether provenance reaches the **model**.
- `packages/schedule/schedule/src/runtime.ts` + `src/persistence.ts` — the `dsh-schedule` precedent.
- `packages/interaction/user-approval/lib/types/types.d.ts`, `packages/interaction/permission-presets/…`
  — the actual approval/permission model.
- `/Users/asd/.dsh/sessions/--Users-asd-dev-deepseek-harness--/session-ee033ab7-…/session.v4.jsonl.zstd`
  — **the live durable session log**, decompressed and inspected by event type and `source` value.
- `vitest.config.ts`, `package.json`, `npm view` — the coverage and gate claims, and the published version.
- `git status` / `git ls-files` — what the plan's evidence base actually is on disk.

**Confidence:** **High** on every finding marked CRITICAL or HIGH — each cites a file, a line, or a
record row I read. **Medium** on two: K-03 (I traced the design note and the projection types but did
not serialise a provider request to confirm the absence of `source` in the wire bytes) and the
harness-version gap noted under Unverified.

---

## Bottom line, in the auditor's own terms

Today, a voice-originated message in the durable record is a `user/message` whose **only** marker of
non-human authorship is a string prefix on an internal correlation id. I read eleven such rows in the
live log:

```
{"kind":"user","rpcId":"realtime-mv2tmh1l-mgnpcg"}    ← and ten siblings, same shape
```

The plan's diagnosis of this is correct and the fix it proposes is the right shape. But the plan then
does four things an auditor cannot accept:

1. It gives a second actor the ability to originate a **turn** in a session and never once discusses
   authorisation, consent, or an off switch — while DSH *has* an approval and permission model, bound to
   exact tool calls and logged as audit events, that this plan does not engage at all (K-01).
2. It makes "the log must not contain text the user never heard" a **story in the last sprint**, tested
   by a helper unit test, with no artefact that compares the log to what was played (K-02).
3. It requires a provenance marker be visible to "both halves" and names no mechanism, so the
   requirement is untestable as written — the mechanism does exist in this codebase's own house
   convention, and the plan should have bound to it (K-03).
4. Every exit criterion it states would pass `pnpm gate` green today even if the capability logged
   fiction, started the wrong kind of turn, or attributed a message to the wrong actor (K-07).

---

## Findings

| id | severity | the claim or omission |
|---|---|---|
| K-01 | **CRITICAL** | A second actor may originate a turn; no consent/approval boundary, no enable event, no off switch, and DSH's permission model is never mentioned |
| K-02 | **CRITICAL** | "Never log text the user never heard" has no evidence criterion that compares the record to the audio, and no gate can fail on it |
| K-03 | **HIGH** | The model-facing provenance marker's mechanism is unspecified; the "both halves" requirement is therefore not testable, and the plan does not use the mechanism this repo already uses |
| K-04 | **HIGH** | The symmetric fiction risks the plan misses: a note logged as if it were a turn; a note logged then silently discarded; the plugin's own directives logged as a user turn |
| K-05 | **HIGH** | The provenance design rests on a false premise about `MessageSourceMap`; and `form: 'note'\|'say'` both overloads a semantic union and duplicates a fact the log already records |
| K-06 | **HIGH** | Change control: a third irreversible act with no gate, no version policy, no rollback, no kill switch; ADR-007's own framing silently extended |
| K-07 | **HIGH** | No exit criterion is gate-detectable — the plan's provenance claims all pass the gate regardless of whether they are true |
| K-08 | **HIGH** | The plan's evidence base is not under version control; its own traceability claim is uncheckable from the repository |
| K-09 | **HIGH** | No migration story: the record already holds voice rows logged as `kind:'user'`, and the fix leaves two markers for one fact |
| K-10 | **OBSERVATION** | `design.md`'s status table is stale, so the invariants the plan cites as constraints have no determinable test status |
| K-11 | **OBSERVATION** | P1's deliverable is a judgement, not a machine-checkable predicate; "machine-verifiable end to end" over-claims and the judgement has no named author |
| K-12 | **OBSERVATION** | P1's exit criterion "no cell marked ❓" is undecidable against `protocol.md`'s four pre-existing ❓ cells |

---

### K-01 — CRITICAL — the approval story is absent, and it is absent from a harness that has one

**Claim/omission.** P2 story 3 makes the `say` verb call `agent.followup(sourcedUserMessage)` — a
message that **starts a turn**. The plan contains no discussion of authorisation, consent, approval,
enablement, or disablement. I grepped the plan: `permission` appears zero times, `approval` appears
once (a risk-table phrase, line 318), `consent` zero, `rollback` zero. This is not an oversight of
wording; it is an omission of a control.

**Evidence.**
- `SessionController.prompt()` performs **no authorisation at all**. Its validation is content
  non-emptiness, client timezone, provider route, and image modality
  (`packages/api/session-controller/lib/types/commands.js`). Writing a turn into a session is authorised
  *by composition* — holding the service — and by nothing else.
- DSH **does** have an approval model, and it is deliberately bound to the exact action. From
  `packages/interaction/user-approval/lib/types/types.d.ts`: `approval/asked` carries `toolName`, "the
  exact tool call when the asker had one" as `callId`, and a `reason`; outcomes are closed
  (`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`) and "**Callers fail closed on
  `unavailable`**". `permission-presets` bundles `SandboxMode` with `ApprovalPolicy`
  (`packages/interaction/permission-presets/lib/types/index.d.ts`).
- The live session log confirms this machinery is on the audit path today: the log contains
  `permission/preset`, `sandbox/mode` and `approval/policy` events alongside the voice's `user/message`
  rows. The voice's turn-originating message sits in the same record as the session's approval policy
  and nothing links the two.
- The plan quotes OWASP's rule — "a `user_confirmed` flag is insufficient… Fail closed" — in **P3 story
  4**, and applies it **only to the note**. The `say` — the verb that actually causes execution — gets no
  boundary at all.

**Does it bypass the permission model?** Mechanically, no: the model's tool calls remain gated by
`approval/request`, so a `say` cannot directly execute a gated tool. **Semantically, yes**, and that is
the incident class this review exists for: `research/voice-integration-patterns.md` §5.1 rule 6 records
the exact failure — a background notification "delivered as a user turn" was read by the model as
approval, and it "fabricated the user's consent". The plan's own risk table names this class (line 318)
and then only defends the *note* channel against it. The plan carries none of the receiver-side
contract the research extracted from Claude Code's shipped equivalent: "the message is **not user
consent**, cannot change config, and never executes commands"
(`research/voice-integration-patterns.md` §2.5, sourced to code.claude.com/cross-session-messaging).

**Fix.**
1. Register the write verbs in the settings registry the repo already has (ADR-009) as a
   **session-scoped, default-OFF** capability, with the enabling decision journalled by key and the
   resulting event landing in the **session log** — so the record shows when the voice was authorised to
   speak into this session, and by whom.
2. Put a non-suppressible, model-facing and human-facing marker on every `say` that states what a voice
   turn is **not**: not user consent, cannot authorise a gated action, cannot change config. Assert with
   a test that a `say` cannot satisfy an `approval/request` ask and cannot mutate session settings.
3. Extend P2's exit criteria with the disable path: a documented way to turn both verbs off
   mid-session, and a recorded event that it happened.

---

### K-02 — CRITICAL — "the log may not contain fiction" is asserted as a story, with nothing that can prove it

**Claim/omission.** P4 story 3 ("Never log text that was never spoken") is a *story* in the *last*
sprint, justified with market precedent, and its exit criterion is "an interrupted `say` logs only what
was heard", resolving (Traceability table, line 308) to
`packages/realtime-agent/tests/truncation.spec.ts`. That is a unit test of a helper, in the plugin.
Nothing in the plan ties the record to the audio.

**Evidence.** The plan's own grounding makes this an audit requirement, not a nicety:

- `docs/design.md` invariant 6: "**Ack ≠ delivery.** `session.*.appended` proves injection, not that the
  user heard anything."
- P4 story 3 itself: "the session log becomes a record of fiction, in a log whose invariant is that it
  is the truth" (Top risks, line 319).
- The plan quotes OpenAI directly: "a completed backend response does not itself mean the user heard the
  answer."

A test that asserts a truncation helper behaves correctly cannot distinguish a log that matches what
was spoken from one that does not — the assertion and the artefact are in different places. And **no
exit criterion in the plan can be failed by `pnpm gate`** (see K-07), so this requirement is unenforced.

**Two sub-defects the plan also does not resolve.**
- **Deletion is itself unreconstructable.** If a barge-in causes the unspoken tail to be *dropped* from
  the record, the record no longer shows that a `say` was truncated — an auditor cannot tell "the model
  said this" from "the model said this and half of it never reached the ear". The market precedent the
  plan cites (`ElevenLabs agent_response_correction`, LiveKit truncation, Pipecat committing played
  words — research §4.1) all keep **both** the original and the truncated form.
- **The plan never defines the comparison unit.** "What was heard" is audio; the log holds text. Nothing
  says who owns the mapping (TTS alignment? the committed-words set?) or how it is durable.

**Fix.** Replace the story with an evidence criterion: (a) the bridge records **both** the wire text and
the **committed (played)** text as distinct fields on the same durable row, with the barge-in that
caused the difference and the reason; (b) an artefact asserts the logged "spoken" text is exactly the
committed set for a recorded barge-in case, replayable keylessly; (c) a gate step — the check must be
able to fail the build, or it is a story in the same sense the plan already admits is unsatisfying.

---

### K-03 — HIGH — the model-facing provenance marker is required and its mechanism is left implicit

**Claim/omission.** P3 story 2 requires "the provenance marker is visible to both halves" and its exit
criterion is "the marker is asserted in the rendered transcript **and** on the model-facing path". The
plan names no mechanism for the second half, and the traceability table sends both halves to a single
test file in one package (`packages/realtime-audio-ws/tests/marker.spec.ts`).

**Evidence — and the good news.** `source` is a **policy / transcript / replay** distinction, not a
model-facing one. The harness's own decision note
(`.agents/notes/implemented/architecture/2026-07-24-separate-context-injection-from-turn-execution.md`)
says so explicitly:

> line 25: "…admission later records the same value as `user/message`… **Transcript and UI consumers
> distinguish direct user messages from injected context by `source`.**"
> line 51: "`user/message.source` already carries the distinction needed by **policy, transcript, and
> replay** consumers." *(the model is not in this list)*
> line 55: "**Producers that require textual framing may include it in their own context content.**"

**The mechanism therefore exists and this repo already uses it** — I read it in the live session log.
Every non-user producer writes a human-and-model-readable framing line into the message *content* and
puts structured provenance in `source`:

| live log row | `source` | content header |
|---|---|---|
| `agent-instructions` | `{kind:'agent-instructions', form:'instructions'}` | `<system-reminder>…` |
| `runtime-context` | `{kind:'runtime-context', form:'snapshot'}` | `Current runtime context. This snapshot supersedes earlier ru…` |
| `skill-catalog` | `{kind:'skill-catalog', form:'catalog'}` | `<system-reminder>…` |
| **the voice today** | `{kind:'user', rpcId:'realtime-…'}` | `Relayed from the voice conversation: the lines below are a s…` |

So the model **already** sees a voice-provenance framing line — written by the plugin, into content,
because `source` does not reach the model. The plan does not acknowledge this, does not bind to the
convention, does not say what the `note` framing line should be (it must differ from the `say`'s — the
research is emphatic that silent context must be "structurally distinguishable from both user text and
model text", §5.4–5.5), and does not test the framing against the request bytes.

**Fix.** State the mechanism as a contract: "`source` is the durable structural provenance;
model-facing provenance is a producer-authored framing line in `content`, as
`agent-instructions`/`runtime-context`/`skill-catalog` do." Give the note and the say distinct framing
templates. Assert, on a **recorded request fixture**, that the framing line is present in the bytes sent
to the provider for each verb — not merely that a helper returns a string. State explicitly that the
framing line is not an authentication mechanism (the research's Claude Code `<system-reminder>`
collision is the reason) and record that limitation rather than implying the marker is trusted.

---

### K-04 — HIGH — the symmetric fiction risks: a note logged as a turn, a note silently discarded, directives logged as a user turn

**Claim/omission.** P2's exit criteria and P4 story 3 between them protect the `say` from becoming a
lie. The plan applies the same discipline to the `note` in only one direction — "the note started no
turn" — and misses three related ways the record becomes untrue.

**Evidence.**
1. **Discard without a durable reason.** `agent.inject()` is explicitly not a guarantee of delivery.
   The design note, line 64: "Idle `inject()` immediately appends one durable inbox insertion but **no
   model-visible `user/message`**; a later waking delivery may start pre-step processing." Line 71: "Idle
   injection is not model-visible until a later pre-step enters it and **may be discarded by cancellation
   or disposal**". So a note can be logged and never seen by anyone. P2 story 7 records a suppression
   reason **in the journal** — the plugin's own record — while the invariant the plan invokes lives in
   the **session log**. An auditor reading the session record sees context that entered the model's
   context when it did not.
2. **A note admitted into a turn is structurally a user message.** Because admission "records the same
   value as `user/message`" with `role: 'user'`, a consumed note and a voice `say` are the same event
   type with the same role. The only discriminator is the field the plan intends to add — so if the
   `form` field is wrong, absent, or dropped by a future consumer, a note is indistinguishable from a
   turn-starting say in the record. That is precisely the failure the plan set out to fix, moved one
   level up.
3. **Plugin directives logged as a user turn.** P3 story 1: "content on the note channel; **any
   instruction from us travels as its own user turn**." That puts the plugin's own instructions onto the
   highest-authority model channel, in a form indistinguishable from the human — the exact defect the
   plan exists to eliminate, applied to the plugin's text instead of the voice's. The research (Anthropic,
   quoted in the plan at P3 story 1) does say to send instructions in a user turn *following* untrusted
   content; it does not license sending them **as** an unattributed user turn. No source kind, no
   framing line, no owner is specified for this write.

**Fix.** (a) Record the note's discard/drop on the **session log** with its reason — not only in the
journal; (b) assert in a test that a discarded note is reconstructable as a note that was never applied,
i.e. it can never be read as a turn; (c) give the plugin's own instruction writes their own provenance
source and framing line, and assert they are never logged as an unattributed `kind:'user'` turn.

---

### K-05 — HIGH — the provenance design rests on a false premise, and overloads a shared vocabulary

**Claim/omission 1 (checkable and false).** The plan, line 113: "DSH's `source` map already carries the
analogous `form` discriminator on `agent-message` (`form: 'relay'`)"; and line 162, citing
`session-messaging.md` §3: "`MessageSourceMap` already reserves `schedule: { kind: 'schedule' }`".

**Evidence.** In the checkout the plan's own spine survey was written against
(`~/dev/deepseek-harness`, `@deepseek-ai/dsh-root` **0.1.5-rc.2**), `MessageSourceMap` is exactly:

```ts
export interface MessageSourceMap {          // packages/llm/llm/src/message.ts:102-107
  user:  { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: ModelMessageSource
  tool:  ToolMessageSource
}
```

There is **no `schedule` kind and no `agent-message` kind reserved**. The real `dsh-schedule` write is
`source: { kind: 'plugin', plugin: 'schedule' }` (`packages/schedule/schedule/src/runtime.ts:271`), and
its own suite asserts that literal (`packages/schedule/schedule/tests/runtime.spec.ts:259`).
`agent-message` is a *merge-added* kind introduced by the subagent package, not a reserved one
(`packages/subagent/subagent/lib/types/continuation-messages.d.ts:13-15`). The plan's stated precedent
for "the voice declares its own source kind" is therefore the **opposite** of the shipped convention: the
sanctioned pattern today is `{ kind: 'plugin', plugin: '<name>' }`.

**Claim/omission 2.** `form: 'note' | 'say'` (P2 story 1). Two problems:

- `form` is a **closed, semantic** vocabulary. `ContextForm` (`message.ts`) is
  `instructions | catalog | snapshot | notice | relay | recall`, consumed by at least three client
  projections (`KnownContextForm` in `packages/client/ui-conversation/src/client/contract/context-provenance.ts:28`,
  and the projections in `ui-chat` and `ui-trajectory`). Its own doc: "The vocabulary is SEMANTIC, never
  visual … Colors, icons, ordering, and collapse defaults are the consumer's business and **must not
  enter this union**." A live example of correct use is `runtime-context` choosing the shared
  `form: 'snapshot'`. Whether a message *starts a turn* is a delivery property, not a content kind — and
  the research agrees: "**Turn-starting is a property of the state machine, not of message authorship**"
  (`voice-integration-patterns.md` §5.1 rule 3, citing Cline's separate `TurnState`; Zendesk implements
  it as `public: bool`; Claude as `shouldQuery`). The voice's own `kind: 'realtime'` is legitimate
  (merge-extensible); minting new **shared** `form` values is a vocabulary decision that touches harness
  packages outside this repo, and the plan's traceability table names only files inside this repo.
- **It duplicates a fact the record already holds.** The live log distinguishes the two verbs by event
  type and turn boundary, not by a field: `agent/inbox/spliced` (18 rows, the non-waking path) versus
  `user/message` (12) plus `turn/start` (9) / `turn/end` (9). Recording "did this start a turn" twice —
  once structurally, once in `form` — creates two sources of truth for one fact, and two sources will
  eventually disagree. An auditor reading a row that says `form:'say'` inside an inbox-splice event has
  no basis to prefer either.

**Fix.** Correct the `schedule` precedent in the plan and in `session-messaging.md` §3 before P2 designs
on it. Decide the shape deliberately — most likely `{ kind: 'realtime' | plugin-scoped, … }` plus a
dedicated delivery field (`startsTurn` / a `shouldQuery`-style boolean, per the research's own field set)
rather than a new shared `form` value. If the `form` axis is kept, state which client projections must
learn the new value and record the vocabulary change as its own decision. State which field wins if
`form` and the event type disagree — and assert it.

---

### K-06 — HIGH — change control: a third irreversible act with no gate, no version policy, no rollback, and a kill switch that does not exist

**Claim/omission.** `docs/design.md` defines the project's irreversible acts as exactly two:
"Publication is gated on the leak scan for the first push and a tarball inspection before publish — **the
two irreversible acts**." ADR-007 repeats it. The plan invokes ADR-007 twice for its gates (lines 16-18,
32) and repeats "CHANGELOG and version bumped in dependency order" (line 281). It proposes a **third**
irreversible act and gives it no control.

**Evidence.**
1. **A write into an append-only durable log cannot be un-written.** The plan's own record of the harm
   class says the session log "becomes a record of fiction" (line 319). That is an irreversible act by
   the project's own definition, and it has no gate — not in the plan, not in `releasing.md`, not in the
   "Definition of done, every sprint".
2. **No version policy.** `docs/releasing.md` §2 is emphatic that a 0.x caret minor-locks and that the
   range check must be against the registry, not the tree. The plan's "version bumped in dependency
   order" carries the *ordering* discipline but states no **policy**: which packages bump, at what
   level, and whether adding a source kind and a message-role behaviour to a published plugin is a minor
   release. Nor does it state whether existing consumers reading `source` kinds will see the new one.
3. **No rollback story.** The plan never states what a user does if the verbs misbehave in the field —
   which is the operative question for a capability that can write into a record. The pattern in this
   repo is explicit ("verify by installing — the success message is not evidence",
   `docs/releasing.md` §5), and the plan adopts it for verification but not for reversal. The natural
   mechanism already exists: ADR-009's settings registry declares a field's class, its scope and its
   setter, and refuses a change it cannot honour. A voice write capability is exactly the kind of field
   that registry was built for. Nothing in the plan registers it.
4. **Non-governed is doing load-bearing work it was not written for.** ADR-007's justification is about
   *scope* and *machinery*, and it is explicit that "This is not a claim that governance is optional"
   and "Only the *machinery* is dropped". The plan cites it to establish that this repo's own gates
   suffice. Its own gates are: `leakscan → build → declared-deps → typecheck → test:coverage →
   test:built`. None of these can detect any of the risks this plan is about (K-07). So the ADR is being
   asked to certify a control set that does not cover the new risk. That is the ADR's own stated failure
   mode — "the appearance of rigour standing in for it" (ADR-008's phrasing, same repository).

**Fix.** (a) Add the third irreversible act to the framing and gate it: no `say` verb ships unless the
log-to-audio evidence exists and the disable path is tested. (b) Write the version policy down
(packages, levels, the registry range check per `releasing.md` §2) as a plan section, not as a phrase.
(c) Specify the rollback: the settings-registry switch, its default, its journal entry, and the
documented previous-version pin. (d) Hash-pin this plan text and the CEO's Option C ruling, as
`sprint-plan.md` v2 does for its reviewed predecessor (`sha256[:16]=51f9152e7c089941`), so the review
that gates the plan is bound to the text it reviewed.

---

### K-07 — HIGH — no exit criterion in the plan can be failed by the gate

**Claim/omission.** Every sprint ends "gate green", and the plan treats that as evidence. The plan's
substantive claims are all *prose* criteria: "the session log shows a note and a say"; "the note started
no turn while the say did"; "a replayed retry writes exactly once"; "a planted directive in a note does
not execute". The traceability table maps each to a spec file — good practice — but none of those specs
can detect the failure the criterion names.

**Evidence.** The gate is declared in `package.json`:
`pnpm leakscan && pnpm build && pnpm declared-deps && pnpm typecheck && pnpm test:coverage && pnpm test:built`.
- `test:coverage` is real and enforced: `vitest.config.ts` sets
  `thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 }` over
  `packages/*/src/**/*.ts`. **This claim survives** (see below) and is the plan's strongest evidential
  asset.
- But coverage measures which lines ran, not whether the record is true. A build in which every provenance
  test passes and every `say` logs text the user never heard is **100% covered and green**. So is a build
  in which a note is logged as a turn, or a voice message is attributed to `kind: 'user'` because the new
  field was left unset. The leak scan is a credential control; the tarball smoke checks composition.
  None of the six steps reads a session log and asserts a provenance property.
- The only criterion that touches the real artefact is a **manual user checkpoint** — P2: "speak a request
  that makes the voice both note and say, then **read the session log and see both** — machine-verifiable
  up to the speaking." That is a self-reported observation by the person who wrote the feature, on a
  record whose correctness is the entire subject of the review. It is not an artefact an auditor can
  re-perform.

**Fix.** For each provenance claim, name the artefact and make the gate read it: a **replayed session
log** (the repo already has a keyless replay backend and recorded fixtures — ADR-003) from which the
check asserts `source.kind`, the `form`/delivery field, the absence of a turn for a note, the presence
of one for a say, and the committed-vs-wire text split. Add that as a gate step, so a regression fails
the build rather than a story. Keep the human checkpoint as a supplement, not as the evidence.

---

### K-08 — HIGH — the plan and its evidence base are not under version control

**Claim/omission.** The Traceability section states: "Acceptance criteria resolve to files, **so a
reviewer can check rather than trust**." The reference section cites the four research documents by
relative path (`../research/…`) and `session-messaging.md` as the grounding for the plan.

**Evidence.** `git status` in `/Users/asd/dev/dsh-openai-live`:

```
?? docs/session-messaging.md
?? docs/sprint-plan-voice-presence.md
?? research/
```

None of the three is in `.gitignore` (`git check-ignore` returns nothing for them, exit 1), and
`git ls-files research/` returns nothing. So the plan, its four commissioned research documents, its
`research/raw/` track artefacts, and the spine survey the plan rests on are **uncommitted working-tree
files at HEAD `bd2575d`**. A reviewer, a CI job, or a later auditor working from the repository cannot
open the plan or a single source it cites. In a repository whose stated thesis is "a check has to bite"
(ADR-008), the documents that carry the argument are outside the check.

**Fix.** Commit the plan, `session-messaging.md`, and `research/` (with `research/raw/` sanitised and
brought inside the leak scan's tracked set, since `pnpm leakscan` covers "tracked files only") **before
P1 is dispatched**. If any of it is deliberately excluded, state why in the plan and say where an auditor
is expected to find it.

---

### K-09 — HIGH — no migration story, and now two markers for one fact

**Claim/omission.** P2 story 1 introduces `source.kind = 'realtime'`. P2's exit criteria require the
session log to show both verbs "distinguishable from a user message". The plan never addresses the rows
that already exist, or the marker that already exists.

**Evidence.** I decompressed the live session log
(`~/.dsh/sessions/--Users-asd-dev-deepseek-harness--/session-ee033ab7-…/session.v4.jsonl.zstd`) and
counted `user/message` by `source`:

- **11 of 12** carry `{"kind":"user","rpcId":"realtime-…"}` — i.e. voice-originated turns, logged with
  `kind: 'user'`.
- The twelfth is the human's. Structurally, `kind` is identical; the only discriminator is an `rpcId`
  **string prefix**.

Consequences the plan does not resolve:
1. **Retroactive ambiguity is permanent.** Every message the voice has already relayed is in the durable
   record as a human turn. After the fix, no consumer can tell those from genuine user messages, and the
   record cannot be repaired. An auditor assessing "was this session's transcript authored by the human"
   for any period before this change has no answer, and the plan does not say so.
2. **The prefix is exactly the field-vs-name trap the research warns about.** Relying on a prefix of an
   internal correlation id is the same failure mode as GitHub's `dependabot[bot]` filter that "silently
   matched nothing against GraphQL's bare `dependabot` + `__typename: Bot`" — the research's own remedy
   is "**normalise provenance at one choke point**" (`voice-integration-patterns.md` §4.2). The plan adds
   the proper field and says nothing about retiring or tolerating the informal one, so after P2 there are
   two markers and no rule for which is authoritative.
3. **`rpcId` is an internal correlation id, not an authorship declaration.** Nothing in the plan states
   that a voice write must never populate it in a way that a reader could confuse with a user RPC.

**Fix.** Add a migration statement: what the new field means for pre-existing rows (unrecoverable —
state it plainly in `docs/session-messaging.md`, which already documents the log's limits); whether
`rpcId` retains its `realtime-` prefix, is retired, or is documented as advisory; and a single
choke-point rule for reading provenance so no consumer re-derives it from a string.

---

### K-10 — OBSERVATION — `design.md`'s status table is stale, so the cited invariants have no determinable test status

**Evidence.** `docs/design.md` (dated 2026-10-07) states: "Each of these has a **test** attached; an
invariant without a test is an intention. (**Test coverage arrives in W3 — until then these are
asserted, and marked as such.**)" Its status table reads "W2 Plugin skeleton — **in progress**", "W3 —
not started", "W4 — not started", "W5 — not started". The repository is at **0.6.11**, published on npm
(`npm view dsh-openai-live version` → `0.6.11`), with 100% per-file coverage enforced by
`vitest.config.ts`.

The plan cites `design.md`'s 8 invariants as its binding constraint set (cross-cutting table, lines
266-275). An auditor inheriting that table cannot tell which invariants are test-backed **today**, so
the plan's "invariant 1 / 5 / 6 / 7 / 8, where each bites" table asserts a constraint status that the
source document still describes as unverified.

**Fix.** Refresh `design.md`'s status table, or state in the plan which invariants are test-backed
today and name the test for each. An invariant cited as a constraint with no visible test is the
"intention" `design.md` itself warns against.

---

### K-11 — OBSERVATION — P1's deliverable is a judgement, and "machine-verifiable" over-claims

**Evidence.** P1's exit criteria: "the spike answer is recorded with evidence…; the classification
contract exists; four fixtures replay **keylessly**…; **No user checkpoint — P1 is machine-verifiable end
to end**."

Two problems. (a) The deliverable is a *decision procedure*: "The contract names what makes a match
unambiguous, and what makes it ambiguous" (P1 story 2). Whether that contract is *right* is a judgement
the four fixtures cannot establish — the fixtures test the contract's implementation, not its adequacy.
The plan's own framing agrees that this is the load-bearing risk ("That makes the classification the
load-bearing risk of this whole plan"). A judgement that gates four sprints should carry an author and a
disposition, the way `docs/plan-review-adjudication.md` gives every review finding a named disposition.
(b) "Machine-verifiable end to end" is not true of P1's *measurement* step: the spike requires a live
`gpt-live-1` session with a key (`docs/design.md`: usage "is billed in audio-seconds"), so P1 cannot run
in CI without a secret — only the *replay* is keyless. The plan elsewhere is careful about exactly this
distinction (ADR-003), so the phrase over-claims by a step.

**Fix.** Name the disposition owner for the classification contract, as the adjudication table does for
its findings; and reword to "the spike is measured live and recorded; the four fixtures replay keylessly"
so an auditor knows which half is CI-reproducible.

---

### K-12 — OBSERVATION — "no cell marked ❓" is undecidable as written

**Evidence.** `docs/protocol.md:5`: "Anything unverified is marked ❓ and must not be relied on."
`protocol.md` currently carries **four** ❓ cells: the `responses` route (line 33), `session.update`
(line 73), `session.input_audio.mute` / `.unmute` (line 74), and `session.close` (line 75). P1's exit
criterion reads "the spike answer is recorded with evidence and **no cell marked ❓**". P1's spike tests
three things (function/tool declaration acceptance; whether a declaration changes any observed event;
whether structured intent exists inside client delegation) — none of which bears on those four cells.

So the criterion is either unachievable by the stated spike or silently means "no ❓ in the new
delegation-intent table". An exit criterion an auditor cannot adjudicate is not a criterion.

**Fix.** Scope it: "every cell in the new `docs/delegation-intent.md` table carries an observation or is
struck", and separately list the four pre-existing `protocol.md` ❓ cells with an owner — resolved in
P1, or explicitly out of scope with a sprint that owns them.

---

## What survives — controls this plan gets materially right

Stated plainly, because an auditor who only lists failures is not doing the job.

1. **The 100% per-file coverage claim is real and enforceable.** `vitest.config.ts` sets
   `thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 }` with an
   explicit rationale ("a threshold nobody fails is not a gate") over `packages/*/src/**/*.ts`. This is
   an artefact an auditor can inspect and a regression can break. **Verified, not asserted.**
2. **The durability-acknowledgement claim is real, not invented.** `ctx.sessions.flush(session):
   Promise<boolean>` exists (`packages/core/session/lib/types/index.d.ts:417`, documented as "THE flush
   entry point") and `dsh-schedule` genuinely uses it — `flushSchedulePersistence` throws when it returns
   false (`packages/schedule/schedule/src/persistence.ts:24-26`). P2 story 3's "require the
   acknowledgement before reporting success" is the correct pattern on a real primitive.
3. **The two verbs map onto two genuinely distinct, documented primitives.** `agent.inject(message)` is
   public and documented as non-waking ("Queue model-facing context for the next pre-step **without
   waking the driver**", `packages/core/agent/lib/types/runtime-types.d.ts:203-209`), and
   `followup`/`steer` are the waking paths. The note/say split is not a metaphor imposed on the seam.
4. **The defect statement is accurate.** `SessionController.prompt()` hard-codes
   `source: { kind: 'user', rpcId: request.requestId, … }`
   (`packages/api/session-controller/lib/types/commands.js`, ~line 297-301) with no producer field, and
   `realtime-responder` calls it with `mode: 'queue'`
   (`packages/realtime-responder/src/index.ts:483-486`). I confirmed this in the live log as well.
5. **Transport-stamped attribution, never model-supplied** (P2 story 2) is the correct control and
   matches the strongest precedent the research found (AutoGen's runtime-stamped `ctx.sender` versus its
   spoofable payload `source`). This is the single most important provenance control in the plan and it
   is right.
6. **Idempotency by producer-minted id, with replace-not-append** (P2 story 6) is the documented correct
   pattern, and the plan correctly refuses model-chosen ids (LangGraph's same-id silent overwrite).
7. **Fail-closed classification** (P1; unambiguous → write, ambiguous → question) is the right default
   and is stated as the design rather than as a mitigation. It maps cleanly onto `design.md` invariant 1.
8. **ADR-008's discipline is the right instinct for provenance fields.** "A file nothing reads is not a
   contract… the fields ride the event wire the replay backend already parses, and the keyless-replay
   gate asserts them, or they do not ship." That is exactly what an auditor wants applied to a field set
   — it is a pity K-05 shows the field set it protects rests on a false premise, and K-07 shows the
   gate it invokes cannot check it.
9. **The non-suppressible disclosure marker** (P4 story 2), justified against Teams' non-customisable
   "AI generated" label, is the right control for the human half, and the live `ContextProvenanceView`
   contract in the harness already renders an unknown source kind as "the bare source kind for a producer
   this UI version does not know" — so a foreign kind remains visible rather than disappearing.
10. **The release discipline itself is sound.** `docs/releasing.md` encodes the two irreversible acts,
    the `workspace:^` publish trap, the dependency ordering, and "the success message is not evidence".
    The plan inherits a good control set; its gap is that it does not extend it to the new capability
    (K-06).

---

## What would have to be true for an auditor to sign off

1. The voice's authority to write into a session is an explicit, registered, default-off capability whose
   enabling decision is in the session log, and whose disabling is tested.
2. A voice turn is structurally incapable of satisfying an approval ask, and the record says so.
3. For every row the log calls spoken, the log holds the committed text, and an artefact proves the two
   agree for a barge-in case — replayable keylessly and fail-able by the gate.
4. A note is reconstructable from the record as a note that may never have been applied, and a discarded
   note records its reason in the session log, not only in the plugin's journal.
5. The provenance field set is the one the gate reads, on a recorded/replayed session log, with the
   legacy-ambiguity and dual-marker questions answered in writing.
6. The plan text and the ruling that authorised it are committed and pinned, and the invariants it cites
   carry a determinable test status.

---

## Unverified

Items I could not confirm from an artefact I read. None is load-bearing for a CRITICAL/HIGH finding
except where noted.

1. **Whether `source` is absent from the provider request bytes.** I established from the harness's own
   decision note (lines 25, 51, 55) and the `ContextProvenanceView`/`ContextRole` projection types that
   `source` is a policy/transcript/replay distinction and that framing is the producer's job on the
   content — and I confirmed the convention in a live log. I did **not** serialise a provider request to
   prove `source` never reaches the wire. K-03's *fix* does not depend on this; its *framing* does.
2. **Harness version alignment.** The plan's spine survey and my `MessageSourceMap` finding are against
   the local checkout `0.1.5-rc.2`, while `docs/session-messaging.md` records the installed app as
   `0.2.0-rc.2`. The published `0.6.11` may target a different harness revision. If `MessageSourceMap`
   reserves `schedule` on a newer revision, K-05's premise finding weakens to a documentation defect —
   but the `form`-axis and duplicated-turn-truth arguments stand either way. **Worth re-checking against
   the harness version the plan actually targets; the plan never states it.**
3. **Whether the published `0.6.11` tarball matches the working tree.** I confirmed the version via
   `npm view` only, and `docs/releasing.md` §4 warns that `npm view` answers from a local cache and "is
   indistinguishable from a publish that did not land". I did not poll the registry or install.
4. **Whether `pnpm gate` currently passes.** Not run (it requires a build). K-07 argues from the gate's
   declared steps in `package.json`, which I read, not from a run.
5. **The plugin's own journal retention/export.** `~/.dsh/realtime-journal.jsonl` exists (1.04 MB, last
   written 2026-10-14). I did not establish whether it is retained, rotated, or ever handed to anyone —
   which bears on K-04's journal-versus-session-log argument, though not on its conclusion.
6. **Whether the CEO's Option C ruling exists as a durable artefact.** The plan asserts it
   ("the CEO ruled **Option C** on 2026-10-14", line 7) and no ADR, note, or review file in this
   repository records it. For an authorisation question, the authorisation should be citable. I could
   not find one.
7. **`research/market-voice-features.md` and `research/voice-platform-building-blocks.md`** — not read by
   me. The plan's market claims (P4's "no product mounts voice as a `position:fixed` overlay"; the "table
   stake" argument) rest on these two documents. A compliance verdict does not turn on them, but a
   reviewer signing off on P4 does.

---

*Reviewer: Karen · compliance seat · adversarial chamber, `voice-presence-chamber`. Findings are
argued from artefacts; where an artefact does not settle a question, it is listed under Unverified
rather than asserted.*
