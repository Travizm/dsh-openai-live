# Adversarial review — `sprint-plan-voice-presence.md` v1

**Date:** 2026-10-15
**Lens:** Agentic-AI systems architecture — harness seams, capability design, multi-agent messaging hazards (loops, echo, termination), and whether the abstraction is right.
**Reviewer:** Haggai (architecture). No persona knowledge base exists for this lens; every finding is argued from the primary sources read below.

**Confidence: high on F1, F2, F4, F5, F7, F8, F10, F12** (each rests on a file read in full or a verbatim single-line grep against the harness checkout at `~/dev/deepseek-harness`, git `c291e79`). **Medium-high on F3, F6, F9, F11** (rest on the plugin's own in-tree sources plus the plan's own text).

---

## What I read

**IN FULL**
- `docs/sprint-plan-voice-presence.md` (336 lines — the plan under review)
- `docs/session-messaging.md` (286 lines — the spine survey the plan cites)
- `docs/design.md` (118 lines — the 8 invariants)
- `docs/protocol.md` (141 lines — the verified wire vocabulary)
- `packages/llm/llm/src/message.ts` (the `MessageSourceMap` / `ContextForm` definitions)
- `packages/subagent/subagent/src/continuation-messages.ts` (`agent-message`, `subagent-settled`)
- `.agents/notes/implemented/architecture/2026-07-24-separate-context-injection-from-turn-execution.md`
- `packages/realtime-agent/src/bridge.ts` (the plugin's delegation answer path)

**SAMPLED / targeted**
- `packages/core/agent/src/runtime-types.ts` (the `send/followup/steer/inject` doc block, lines 200–330)
- `packages/schedule/schedule/src/{runtime,persistence}.ts` (the "vetted precedent")
- `packages/experimental/agent-team/src/types.ts`, `packages/context/{session-reference,agent-instructions}/src/types.ts`, `packages/webhook/webhook/src/types.ts`, `packages/goal/goal/src/domain.ts`, `packages/skill/*/src/*` (the full producer-kind landscape)
- `docs/architecture.md` (the "model-visible means logged" rule), `research/session-messaging-protocols.md` (PART 7 problem→pattern table), `research/market-voice-features.md` (the role/attribution row)

**Not read:** the four other research docs and the `sprint-plan.md` v2.1 referred to as outstanding; I did not re-derive the harness facts supplied as grounded.

---

## Findings

### F1 — CRITICAL · `form: 'note' | 'say'` is the wrong field: `ContextForm` is a *semantic content-kind* axis that the harness explicitly forbids using for visibility
**Claim attacked:** "`source.kind = 'realtime'` … with `form: 'note' | 'say'` — the discriminator DSH already uses on `agent-message`" (plan, P2 story 1 / Options C).

**Evidence.** `packages/llm/llm/src/message.ts:34-49` — the doc-comment on `ContextForm`, verbatim:

> `MessageSource.kind` answers *who produced this*; `form` answers *what kind of thing it is*, and the two axes are deliberately independent — several producers share one form, and one producer may emit more than one form over a session.
> The vocabulary is SEMANTIC, never visual: a value states that the content is a file's instructions or a catalog of available items, and a consumer decides what that looks like. Colors, icons, ordering, and collapse defaults are the consumer's business and must not enter this union.

The shipped values are `instructions | catalog | snapshot | notice | relay | recall` (`message.ts:50-96`). `ContextFormed` is mixed into `plugin` (`message.ts:104`) and re-declared by the kinds that inject context (`agent-message` → `relay`, `subagent-settled` → `notice`, `agent-instructions` → `instructions`, `session-reference` → `recall`). Every one of those is *injected, non-waking context*. The plan's own definition of the discriminator is a visibility/turn axis — "they share the field set and differ in exactly one property — **whether the message starts a turn**" (plan, Options C) — which the union's contract prohibits ("never visual … collapse defaults are the consumer's business"). Worse, `say` describes the *direct message*, which by the harness's own design is **not** "supplementary context": the 2026-07-24 note ("Decision") says a caller "delivers an identified, frozen `UserMessage` through `inject()` **and** submits the direct message independently with `followup()` or `steer()`". A turn-starting message is a different object class from `ContextForm`-bearing injected context.

Two readings, both wrong: (a) the plan extends the shared `ContextForm` union with producer-exclusive visibility verbs — corrupting a shared semantic vocabulary that "several producers share"; (b) it adds a *same-named* `form` field with a different axis on its own kind — two meanings of `form` in a map with no runtime validation, which is the silent-divergence hazard `MessageSourceMap`'s lack of validation already invites.

**Fix.** Keep producer identity in `source.kind = 'realtime'` and stop there. Express turn-starting where the harness already expresses it — the delivery method (`inject()` vs `followup()`). If a durable renderer hint is genuinely needed, put it on the `realtime` source as a kind-scoped field (e.g. `startsTurn: boolean` / `visibility: 'note' | 'say'`), exactly as the plan's own research proposed (`session-messaging-protocols.md` §9 lists `source.startsTurn` **separately** from `source.form`). Do not add visibility vocabulary to `ContextForm`.

---

### F2 — HIGH · The precedent the plan's central justification rests on is false: `MessageSourceMap` does **not** reserve a `schedule` kind
**Claim attacked:** "Declare the source kind … This is the one thing the spine genuinely lacked (grounded in `session-messaging.md` §3)."
**Evidence.** `docs/session-messaging.md:191` states, "`MessageSourceMap` already reserves `schedule: { kind: 'schedule' } & ContextFormed`." That is not true. A grep for a `schedule` source kind across the harness returns nothing, and the schedule plugin writes as the *generic* plugin kind:

```
packages/schedule/schedule/src/runtime.ts:270-272
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'schedule' },
  })
  this.agent.followup(message)
```

So the "vetted precedent" for a producer writing into a session does **not** declare its own source kind at all. The plan inherits the false claim via its citation of `session-messaging.md` §3.

**Impact.** The plan's *conclusion* (declare `kind: 'realtime'`) still stands — on different, real evidence: `agent-message` + `subagent-settled` (`continuation-messages.ts:40-45`), `webhook`, `team-message`, `goal`, `agent-instructions`, `session-reference`, `skill-catalog`/`skill-invocation` all declare their own kinds. But the plan's stated *route* to that conclusion is a fabricated precedent in a document (the spine survey) that this plan treats as verified grounding. For a plan whose cross-cutting section invokes the "check rather than trust" discipline (QL-06), an unchecked precedent in its own evidence base is a real defect.

**Fix.** Strike the `schedule`-kind sentence from `session-messaging.md` §3 and the P2 story 1 citation. Cite `packages/subagent/subagent/src/continuation-messages.ts:40-45` and `packages/webhook/webhook/src/types.ts:72` as the producer-declared-kind precedent. Keep the design.

---

### F3 — HIGH · The plan misdescribes its own mechanism: the delegation envelope carries **no text**, so there is nothing on it to classify
**Claim attacked:** "They must ride the delegation envelope and be classified client-side" (plan, "The hard constraint").

**Evidence.** `docs/protocol.md:100` trap #3, verbatim: "**A delegation carries no task text** — only `{id, type, target}` and `offset_ms`. Reconstruct intent from the input transcript plus application state." The plan quotes the envelope's shape ("carries no intent or kind — the envelope has exactly one shape") but omits that it also carries no *content*. In the plugin's own code the classify-able material is the app-assembled transcript, not the envelope:

```
packages/realtime-agent/src/bridge.ts:124-129
  const request: DelegationRequest = { id: delegation.id, offsetMs: delegation.offsetMs, transcript, sessionId: session.id }
```

**Impact.** The plan's central sentence points the mechanism at a surface that cannot carry the two verbs. The classification input — and the *content* of the note/say — must be reconstructed from the input transcript (the ASR of the user's speech) plus application state, which is the *least* reliable input available and changes what P1's spike must measure (the transcript shape, not the envelope shape). The plan's P1 partially knows this ("only free text plus a delegation of the existing shape") but never reconciles it with "ride the delegation envelope".

**Fix.** State plainly: the note/say content and the classification input come from the transcript (`AgentTranscriptLine[]`) + application state, per protocol.md trap #3; the delegation is only the *trigger*. Retarget P1 story 1 to measure the transcript surface, and record the correlation between the delegation `offset_ms` and the transcript span it covers (the only causal link available).

---

### F4 — HIGH · `form` — and therefore the trust level — is derived from untrusted model/app text, contradicting the plan's own transport-stamping rule one story later
**Claim attacked:** P2 story 2 ("Attribution is stamped in the transport, never taken from the model … no model-supplied field may name it") vs P1 + P2 story 1 (the note/say verdict is classified from model text).

**Evidence.** The plan makes `form` the discriminator (P2 story 1) and the trust label a function of the form — P3 story 1 ("A note is untrusted"), restated in the research as `trust='untrusted'` for note, `'attributed'` for say (`session-messaging-protocols.md` §9). But the form itself is decided by classifying model-authored prose (P1). The plan even names the consequence without naming it as a contradiction: "if the classification can be wrong, a note becomes a say" (plan, "The hard constraint").

**Impact.** The model can choose its own trust level by phrasing. If an injected or confused voice model emits text classified as `say`, it becomes attributed (visible, trusted-looking) content in the coding session; if it emits text classified as `note`, it becomes hidden context. The plan's stated principle — attribution is transport-stamped, never model-supplied — is honoured for the *actor* but violated for the *form/trust*, which are the security-relevant axes. This is exactly the AutoGen `payload.source` spoofing trap the plan says it avoids, relocated one field over.

**Fix.** Make trust/visibility a deterministic function of the *path taken*, never of model prose: a message delivered through `inject()` is, by construction, non-waking and untrusted; one delivered through `followup()` is, by construction, waking and attributed. The classifier chooses *whether to write and by which path*; the label is derived from the path. This is the research's own rule 6 ("the trust label must be a structural property of the message … not a sentence asking the model to be careful", §5.5).

---

### F5 — HIGH · The `say` channel is a higher-authority injection path than the note, and the plan's trust analysis never covers it
**Claim attacked:** P3 ("The note's trust boundary") and the risk table row "A `note` is obeyed as an instruction, or spoofs the user".

**Evidence.** `packages/core/agent/src/runtime-types.ts:218-222`: `followup()` — "Queue an ordinary follow-up turn and wake the driver. **The item becomes the sole ordinary message of its own turn.**" A `say` is therefore an input the coding session's model *will act on*, with voice provenance. The plugin's `followup`-based precedent does the same (`packages/schedule/schedule/src/runtime.ts:272`). P3's five stories are entirely about the note; the plan's risk table names only the note; research §5.5 rule 1 ("never let an injected note grant capability") applies *more* strongly to a `say`, which starts a turn and so *does* grant execution.

**Impact.** The plan treats a `say` as safe because a human can see it. Visibility to the human does not reduce the authority the receiving model grants it. The note is the *quieter* of the two channels; the say is the one that causes the session to run tools.

**Fix.** Extend P3 to the say: state that a say is a first-class, turn-starting, authority-bearing input; that its only guards are human visibility + provenance; and require the receiving session's injected guidance to treat voice-authored turns as untrusted-but-visible (or gate a say behind an explicit operator confirmation, per OWASP "approval bound to the exact action"). At minimum, add the say to the risk table — today the plan's own risk table claims the note is the risky verb, which is the reverse of the truth for *authority*.

---

### F6 — HIGH · No loop/reply control; `no-echo` is mis-cited and does not cover the real voice↔session loop; the research's loop breakers are dropped **silently**
**Claim attacked:** P2 story 5 ("No echo, as a property of the write path") as the loop answer.

**Evidence.** `research/session-messaging-protocols.md` PART 7 lists three separate loop controls and the plan adopts none of them:

| research pattern (PART 7) | in the plan? |
|---|---|
| numeric cap + semantic/stall cap + **per-sender rate limit + identical-repeat drop** (Claude Code cross-session) | **absent** |
| **Bounded inbox / byte cap with reject-publish (nack)** (§3.4) | **absent** |
| **Depth / turn / cycle limits → explicit cap** (Swarm→SDK `DEFAULT_MAX_TURNS=10`) | **absent** |

The plan's `no-echo` cites AutoGen's transport guard: "If an agent publishes a message type for which it is subscribed it will not receive the message it published. This is to prevent infinite loops" (`_single_threaded_agent_runtime.py`). That guard prevents self-delivery *within one runtime*; the voice is a GPT-Live provider session that is not an agent in the DSH runtime, so the guard does not fire for the loop that actually exists — voice writes a `say` → target session runs a turn → the turn's output returns to the voice as a delegation answer → the voice may `say` again. The plan's "a self-addressed write is refused" (P2 exit criteria) is undefined for a producer that has no DSH session id.

**Impact.** The one loop-class hazard the market solved with *non-semantic* breaks (a rate limit that survives a hostile model) is absent from a plan that already declares the note channel untrusted. The plan's "Deliberately not in this plan" table does **not** list these — it defers the scheduling enum, per-agent voice, floor-lock, WebRTC, the peer mailbox and the wake word — so this is under-specification, not a stated decision.

**Fix.** Either adopt the three breakers (per-sender rate limit, identical-repeat drop within a window, bounded pending-verb inbox with a *signalled* refusal, each with a reason string), citing Claude Code cross-session messaging; or add them to "Deliberately not in this plan" with the argument. Define what `no-echo` guards against now that the producer is not a DSH session.

---

### F7 — HIGH · The harness invariant "model-visible means logged" is never cited, and the plan's marker design risks violating it
**Claim attacked:** P3 story 2 / P4 story 2 (the provenance marker "asserted in the rendered transcript **and** on the model-facing path").

**Evidence.** `docs/architecture.md:121`: "**Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it. This is why a new model-visible input requires a new session event: extend `SessionEventMap` and render from the log." The plan's cross-cutting table lists six of `design.md`'s eight invariants and never mentions this one. Meanwhile the research the plan leans on recommends the opposite mechanism: `session-messaging-protocols.md` §4.4 (the Devin lesson) says "the **persistent** provenance wrapper belongs in the **model-facing build**". A wrapper added at prompt build is, by definition, *not* in the durable message — so a model could see a marker the log cannot reproduce, which is the exact violation the invariant forbids.

**Impact.** The plan requires the marker on both paths but never says the marker must be part of the *logged message content*. If it follows its own research §4.4 and adds the wrapper at prompt build, the invariant breaks and the session log stops explaining the model's inputs.

**Fix.** Require the marker to live in the `user/message` **content** (hence logged), not in the prompt build. Cite `docs/architecture.md:121` and note that a new `source.kind` riding the existing `user/message` event is the sanctioned mechanism — the 2026-07-24 design note explicitly rejected a separate `context/message` event ("`user/message.source` already carries the distinction needed by policy, transcript, and replay consumers").

---

### F8 — HIGH · The note inherits two limitations the plan does not acknowledge: it may miss the request being finalized, and it may be discarded
**Claim attacked:** P2 story 4 ("`note` writes without waking — `agent.inject(sourcedUserMessage)`: `next-step` inbox, no turn"); P2 exit criterion "the note started no turn".

**Evidence.** `packages/core/agent/src/runtime-types.ts:233-241`, verbatim: "Queue model-facing context for the next pre-step without waking the driver. A running driver claims it at the nearest later step boundary; idle drivers leave it pending until follow-up or steering wakes them. **It may miss a request whose pre-step already claimed its batch. Cancellation or disposal may discard pending context.**" And the 2026-07-24 note, "Injection lifecycle": "Idle injection is **not model-visible** until a later pre-step enters it and **may be discarded** by cancellation or disposal, while its durable inbox lifecycle remains recorded."

**Impact.** The plan calls the note "model-facing context" as if delivery were certain. It is not: a note to an idle session is pending indefinitely, and a note during a turn can be dropped. The P2 exit criterion proves only that the note started no turn — it does **not** prove the model saw it. P3 story 4's fail-closed drop covers *validation* failure only, not the inbox-discard path. So a note can be "written" and never reach the model, with no plan-level fact distinguishing "pending", "discarded" and "admitted".

**Fix.** State the note's delivery semantics explicitly (best-effort, nearest-later pre-step, discardable on cancel/dispose, pending-indefinitely when idle). Add an assertion that an *admitted* note appears as a durable `user/message` (the model's inputs are reconstructable), and that a *never-admitted* note is recorded as pending/discarded rather than implied delivered. Decide the idle-session semantic.

---

### F9 — HIGH · P1 omits the reachability probe the spine named as decisive
**Claim attacked:** P1 is described as settling the channel; P2 story 4 assumes `agent.inject()` "is public and documented on the Agent runtime type".

**Evidence.** `docs/session-messaging.md` §5: "whether an out-of-tree plugin composing with the seam can reach `agent.inject()` and `createUserMessage()` from a consumer row, or whether that requires a provider seam the harness owns … **Probe that first; it decides the size of everything after it.**" P1's spike measures the tool channel only (three questions about function declarations). The reachability of `inject()` / `createUserMessage()` / `ctx.sessions.flush()` from a `dsh plugin add`-installed package is not a P1 story, yet all of P2 depends on it. `createUserMessage` is `dsh-llm`'s and `agent.inject` is on the runtime type — both reachable *inside* the tree; the plan treats in-tree reachability as installed reachability.

**Fix.** Add the reachability probe to P1 (it is machine-verifiable and cheap), with the same "record the answer either way" discipline as the tool-channel spike, and gate P2 on it.

---

### F10 — MEDIUM-HIGH · The `say`'s spoken-vs-written nature is unresolved, and P4 story 3 conflates the two
**Claim attacked:** P4 story 3 ("Never log text that was never spoken … a rendered `say` makes the session log a record of text the user never heard"), applied to a `say` that P2 story 3 delivers only as `agent.followup(...)`.

**Evidence.** The plan's finding frames the visible half as "that pair [GPT-Live's `session.commentary.append` (makes the model *say* things aloud)] plus a durable, sourced log entry". P2 story 3 describes only the *write* (`followup` + `flush`) and never the speaking. P4 story 3 treats the same `say` as *spoken* (barge-in truncation, "only what was heard"). `session.commentary.append` is the spoken channel (`docs/protocol.md:32,72`); `followup` writes durable text into the target session. The plan never says a `say` is one, the other, or both.

**Impact.** If a `say` is both spoken (commentary, truncatable on barge-in) and written (followup, full text), the two diverge, and the plan's "log only what was heard" (invariant 6) collides with "the say starts a turn" (the target session's model needs the full, unforged text). A barge-in-truncated spoken version and the written turn text cannot both be the log's record.

**Fix.** Define the say's deliveries explicitly: the target-session write is the sourced log entry (read, not heard); any voice commentary is a separate event with its own bound. Scope invariant 6 ("ack ≠ delivery") to the commentary half; the target-session write is not a delivery-to-ear at all.

---

### F11 — MEDIUM-HIGH · Ordering between a near-simultaneous note and say is unaddressed, though the research names it and the harness's timing makes it real
**Claim attacked:** P2 exit criterion "the session log shows a note and a say" — which checks presence, not order.

**Evidence.** `research/session-messaging-protocols.md` PART 7 "Ordering": "Both verbs are appended to the session log in one order; a 'note and say arrive together' conflict raises rather than silently picking a winner." The harness's own timing makes the conflict ordinary: `inject()` joins "the next pre-step available" while `followup()` opens "its own turn" (`runtime-types.ts:222, 233-241`), so a note emitted just before a say can land inside the say's turn or be deferred to a later step (F8). The plan's P3 story 1 even *creates* the case — the checkpoint "speak a request that makes the voice both note and say" (P2).

**Fix.** Add an ordering story: both verbs carry a monotonic sequence/`ts`; the log's total order is asserted; define the behaviour when a note and a say arrive within one window (and whether the note rides the say's turn or the next step).

---

### F12 — MEDIUM · Actor/origin-session identity is omitted, though the plan's own no-echo and per-sender dedup need it and the harness already models it
**Claim attacked:** P2 story 2 ("the actor id is minted by our bridge") with no story saying where it is carried; P2 story 5 (no-echo) needing to identify the origin.

**Evidence.** The harness already carries sender identity on producer sources: `agent-message` → `senderSessionId` (`continuation-messages.ts:15-21`), `team-message` → `senderId` + `senderName` (`packages/experimental/agent-team/src/types.ts`), `subagent-settled` → `senderSessionId`. The plan's field set is `kind` + `form` only; `session-messaging-protocols.md` §9 lists `source.actor` and `source.originSessionId` as "Should-have" precisely for per-sender dedup and attribution.

**Fix.** Add `actor` / `originSessionId` to the `realtime` source, mirroring the `agent-message` shape, and use it for the no-echo guard and per-sender rate/dedup (F6). Without it, F6's loop controls have no key.

---

## What survives (and is right about something important)

- **Producer identity as a new `source.kind` is the correct single change.** It is the harness's own pattern — every other cross-cutting producer declares its own kind and its own fields (`agent-message`, `subagent-settled`, `webhook`, `team-message`, `goal`, `agent-instructions`, `session-reference`, `skill-catalog`/`skill-invocation`). `docs/session-messaging.md` §5 and the research §8 both land here, correctly. **The plan is right; F1/F2 attack its *form* field and its *citation*, not this conclusion.**
- **The two delivery methods are the right pairing.** `inject()` = non-waking model-facing context (note); `followup()` = the turn's sole ordinary message (say). Verified against `runtime-types.ts:218-241` and the 2026-07-24 design note, which says exactly this split.
- **`followup()` + `ctx.sessions.flush()` + require the acknowledgement is a real, vetted precedent** — the `dsh-schedule` shape (`packages/schedule/schedule/src/persistence.ts:24-26`, `runtime.ts:264-272`). The plan's reliance on it for the *say* is correct (only its `schedule`-kind claim is wrong).
- **Idempotency as transport-minted id with replace-not-append** is correct and matches LangGraph replace-by-id + the Azure idempotent-consumer pattern; producer-minted ids are the right call.
- **Fail-closed (ambiguous → question, never a write) is the right default** and ties correctly to invariant 1.
- **The note's trust treatment is well-grounded and its source list is right:** untrusted channel (Anthropic `tool_result`), no directives on the note channel, capability-as-data, structural marker visible to both model and human (OWASP LLM01 #6; Anthropic). This is the plan's strongest section — provided F4 and F7 are fixed so the trust label is path-derived and the marker is logged.
- **Refusing to depend on `dsh-experimental-agent-team` and deferring the peer mailbox is correct** under DSH's own policy that released products outside the experimental group must not depend on experimental packages.
- **Deferral hygiene** — the "Deliberately not in this plan" table converts omissions into decisions. The defect is that the multi-agent loop controls (F6) are *not* in it.

---

## Unverified

1. **Whether `agent.inject()` / `createUserMessage()` / `ctx.sessions.flush()` are reachable from an out-of-tree, `dsh plugin add`-installed package** (the consumer-row vs provider-seam question). I confirmed they are reachable *inside the harness tree*, and the plugin already imports from `dsh-llm`/`dsh-realtime` (`packages/realtime-agent/src/bridge.ts:1`), but I did not construct an installed-package probe. P1 should settle it (F9).
2. **Whether GPT-Live-1 accepts a function/tool declaration on `session.start` under client delegation.** Not testable without a live key; the plan itself makes this P1's spike.
3. **The exact wire shape and verbatim-preservation of the model's "free text"** on the transcript path (whether a reserved prefix would round-trip untouched through ASR). This decides whether the classification can be a *strict parse* (reliable) or must remain a *classifier* (probabilistic). I could not verify it from the repo; it belongs in P1.
4. **The four research documents other than `session-messaging-protocols.md`** — not read; the market-convergence claim (Zendesk `public:true|false`, Claude Agent SDK `origin` + `shouldQuery:false`) is taken from the plan and research §4/§9 rather than re-fetched.
5. **The installed profile's effective `MessageSourceMap`** — I verified the harness checkout (`c291e79`, 2026-09-10) against the plan's citations; a diverging installed version could differ, though the schedule package is in-tree and versionless here.

---

## Bottom line

The plan's **capability design is sound and its delivery mechanisms are correctly chosen** — a new `source.kind`, `inject()` for the note, `followup()` + `flush` for the say, fail-closed classification, transport-minted ids. What it gets wrong is one layer up: it puts the note/say distinction on `form`, which the harness documents as a *semantic content-kind* axis explicitly closed to visibility ("never visual"), and it grounds that choice in a precedent (`a reserved schedule kind`) that does not exist. Fixing F1 (move visibility to the delivery path / a kind-scoped field) and F4 (make trust path-derived, not prose-derived) removes the two structural defects; F5–F12 close the multi-agent and invariant gaps. The plan is buildable after F1/F2/F4; it should not ship the `form` field as written.
