# Review — `sprint-plan-voice-presence.md`

**Date:** 2026-10-15
**Lens:** Senior systems engineering / implementation feasibility. Is this buildable as specified, is it sized honestly, and where does it under-estimate the work?
**Reviewer role:** adversarial. The question asked of me is *can this be built*, not *is this a good idea*.

## What I read

**IN FULL**
- `docs/sprint-plan-voice-presence.md` (336 lines, all of it)
- `packages/realtime-audio-ws/src/client/index.ts` (873 lines) and `src/strip.ts` (98 lines)
- `packages/realtime-responder/src/index.ts` (531 lines)
- `packages/realtime-audio-ws/package.json`, root `package.json`, `tsconfig.client.json`, `vitest.config.ts`
- `scripts/client-bundle.mjs`, `scripts/client-artefact.mjs`
- Harness: `dsh-llm/lib/types/message.d.ts` (full), `dsh-agent/lib/types/runtime-types.d.ts:150-330`, `dsh-agent/lib/types/types.d.ts:25-30`, `dsh-agent/lib/types/index.d.ts:150-345`, `dsh-session/lib/types/index.d.ts:400-420`
- `dsh-client-ui-sidebar-right/lib/client.js:3320-3760`, `dsh-client-modules/lib/index.js:60-70` + `client.js:340-360`

**SAMPLED**
- `dsh-schedule/lib/index.js` (targeted: 680-700, 790-975 — the followup/flush path)
- `packages/realtime-responder/src/types.ts`, `tests/turn.spec.ts`, `realtime-agent/src/tools.ts` (heads)
- Harness package inventory under `~/.dsh/profiles/node_modules/@deepseek-ai/`

**Could not read**
- `@deepseek-ai/dsh-client-ui-slots` — declared as a type-only import by `ui-sidebar-right` but **not installed** in the profile. My claim about slot bodies being React components is therefore inferred from the call sites and the shipped bundles, not from the slots package's own `.d.ts`. Flagged under *unverified*.

## Verdict

**Buildable, with changes — but not at the sizes stated.** The substance is sound and both mechanisms it borrows are real. Three things are wrong in a way that stops the build: P2's idempotency has no mechanism to stand on, the `note`'s durability is misstated in a direction that contradicts P2's own exit criterion, and the plan's `form` field collides with a vocabulary the harness already owns on that exact field name. One thing is scoped to the wrong hazard: P4's risk is not reachability, which is near-certain, but the **build face**, which is the largest single item in the plan and is not counted. P2 and P4 are each two sprints.

**Confidence:** high on everything read from source; medium on the slot-body component contract (see above).

---

## Findings

| id | severity | finding | est. |
|---|---|---|---|
| F1 | **CRITICAL** | P2's exactly-once story rests on a message id the producer is not allowed to mint | 6-10h |
| F2 | **CRITICAL** | `inject()` does not deliver or durably keep a note — P2/P3 exit criteria assert a fact the primitive does not guarantee | 4-8h |
| F3 | **CRITICAL** | `source.form = 'note' \| 'say'` collides with the harness's existing `ContextForm` vocabulary on the same field name, and the plan's cited precedent is a misread | 2-4h |
| F4 | **HIGH** | P4's risk is scoped to unreachability, which is not the hazard; the real cost is a **new client build face** (JSX + React + module-table requires + inject declarations) | 20-32h |
| F5 | **HIGH** | P4 is **not** independent of P2 — 3 of its 4 stories presuppose `say`; its truncation test is filed in the wrong package | 0h (re-plan) |
| F6 | **HIGH** | The `followup`+`flush` mechanism is right in shape but names neither the sessionId→Agent hop, nor what the ack means, nor the agent-busy path | 4-6h |
| F7 | **HIGH** | If `flush` fails mid-write the plan cannot say whether the retry duplicates or loses — because the durable dispatch record it needs is missing | 4-6h |
| F8 | **HIGH** | Ordering between a note, a say and an in-flight delegation answer is unspecified, and the harness guarantees less than the plan assumes | 4-8h |
| F9 | **HIGH** | P1 promises "no user checkpoint" while its first story is a live provider session | 0-2h |
| F10 | OBSERVATION | P2 (7 stories) and P4 (4 stories) are each two sprints under the repo's own one-release-per-session rule | — |
| F11 | OBSERVATION | The plan cites the two *wrappers* (`followup`/`inject`) where `send(message, target, wakeup)` is the primitive that makes both verbs one call site | 1-2h |
| F12 | OBSERVATION | `dsh-experimental-agent-team` is not present in the installed profile, though a deferral row asserts it "exists in-tree" | — |
| F13 | OBSERVATION | Deleting the overlay leaves a dead client seam behind that the 100% per-file gate still has to cover | 2-4h |

---

### F1 — CRITICAL — idempotency has no mechanism to stand on

**The claim.** P2 story 6: *"The producer mints the message id; a repeat with the same id replaces rather than appends. Exactly-once is not a transport property — it is at-least-once delivery plus an idempotent consumer."* Exit criterion: *"a replayed retry writes exactly once."*

**The evidence.** `packages/…` no — the harness: `dsh-llm/lib/types/message.d.ts:180-183` declares

```ts
export declare function createUserMessage<T extends NewUserMessage>(input: T & {
    readonly id?: never
    readonly role?: never
}): T & Pick<UserMessage, 'id' | 'role'>
```

`id?: never`. `NewUserMessage = Omit<UserMessage, 'id' | 'role'>` (line 155); `createMessage` is the same (line 172-174). `Message.id` is *"Stable identity preserved across every representation boundary"* (line 121) — **minted by the harness, never supplied by a producer**. So "the producer mints the message id" is not expressible. There is no supported way for the responder to stamp its own id on a `UserMessage`.

**What the vetted precedent actually does.** `dsh-schedule` does not use a message id either. Its spine is a durable dispatch record written *after* the followup and *before* the flush (`dsh-schedule/lib/index.js:934-950`):

```js
this.agent.followup(message);                     // 934
…
this.agent.session.append("schedule/change", {    // 940
  version: 1, operation: "dispatch", id: decision.record.id
});
```

and then `flushSchedulePersistence` (line 965). The retry-safety comes from a **durable event in the session log naming the dispatch**, which the next fold can read — not from a message identity. The plan cites schedule as its model and then adopts a mechanism schedule does not use and the type system forbids.

**Fix.** Two levels, both real API:
1. Carry the producer id in `source`, not `Message.id` — merge-extend `MessageSourceMap` with `realtime: { kind: 'realtime', requestId: string, form: … }` and dedupe on `requestId`.
2. Write a durable `realtime/change { operation: 'note'|'say', requestId }` session event **inside the same task as the followup, before the flush** — exactly schedule's ordering. Support in-memory replacement with the inbox primitive that exists for it: `splice(target, start, deleteCount, inserted)` and `append`/`prepend` on the `Inbox` (`dsh-agent/lib/types/runtime-types.d.ts:53-81`), keyed on the same `requestId`.
**Estimate 6-10h**, plus test fixtures.

---

### F2 — CRITICAL — the note is neither delivered nor durable on the path the plan chose

**The claim.** P2 story 4: *"`note` writes without waking — `agent.inject(sourcedUserMessage)`: `next-step` inbox, no turn."* Exit criterion: *"the session log shows a note … the note started no turn."* P3 story 4 adds *"a note that fails validation is dropped with a journal reason, never partially applied."*

**The evidence.** `runtime-types.d.ts:201-209`:

> *"Queue model-facing context for the next pre-step without waking the driver. A running driver claims it at the nearest later step boundary; **idle drivers leave it pending until follow-up or steering wakes them. It may miss a request whose pre-step already claimed its batch. Cancellation or disposal may discard pending context.**"*

Three consequences the plan does not carry:
- A note written into an **idle** session does not reach the model at all until something else wakes the driver. "Silent context" is not "context".
- A note can be **missed** by a pre-step that already claimed its batch — so it can be silently deferred by an arbitrary amount.
- A note can be **discarded** by cancellation or disposal. There is no return value to check: `inject(message: UserMessage): void` (line 209).

Therefore the two exit criteria above are not guaranteed by the write. P2's "the session log shows a note" may be false for a legitimate, non-buggy reason; P3's "dropped with a reason" has no hook to observe the drop.

**Fix.** Bind the note's lifecycle in the plan, explicitly, one of two ways: (a) make the note a *waking* write — `send(message, 'next-step', true)` — and say so, accepting that a note then opens a turn boundary it does not fill; or (b) keep it silent and move the assertions onto the events that actually describe the lifecycle: `agent/inbox/inserted`, `agent/inbox/claimed`, `agent/inbox/discarded` (`runtime-types.d.ts:258-287`). Those three are the audit surface for a note, and the plan names none of them. Note also that `InboxWireState` is *"reconstructed from durable splices"* (`dsh-agent/lib/types/types.d.ts:26-37`) — which is where P3's dropped-with-a-reason should be read from.
**Estimate 4-8h** (design + fixtures + the reason channel).

---

### F3 — CRITICAL — `form` is already owned on this type, and the cited precedent is a misread

**The claim.** P2 story 1: *"`source.kind = 'realtime'` on the seam's message-source surface, with `form: 'note' | 'say'` — the discriminator DSH already uses on `agent-message` (`form: 'relay'`)."* Option C restates it: *"DSH's `source` map already carries the analogous `form` discriminator on `agent-message` (`form: 'relay'`)."*

**The evidence.** `message.d.ts:42-89`. `ContextForm` is *"The kind of information in producer-supplied context"* — *"`MessageSource.kind` answers who produced this; `form` answers what kind of thing it is"* — and its vocabulary is `instructions | catalog | snapshot | notice | relay | recall`. It also constrains content: `form: 'notice'` **requires** `summary`; `form: 'snapshot'` requires `sections`. And `MessageSourceMap['plugin']` is the only variant carrying `& ContextFormed` (line 98-101).

Two problems:
- **`'relay'` does not mean what the plan says it means.** It is documented as *"A message another agent addressed to this one"* (line 51-52) — a relay from a peer agent, not a voice `say`. Citing it as precedent for `form: 'say'` is a misread of the line, and it is the plan's *only* justification for the field name.
- **Reusing `form` with a second vocabulary on the same type family is a footgun.** The new kind is merge-extensible (`MessageSourceMap` is *"Merge-extensible sum type — plugins add their own kinds"*, line 92), so `kind: 'realtime'` + `form: 'say'` type-checks. But now two `source.form` values with unrelated meanings and unrelated required fields coexist; `'notice'` and `'note'` differ by one character; and any consumer that switches on `source.form` without first narrowing `kind` is silently wrong.

**Fix.** Put the new axis in a name the harness has not spent — `source.realtime.verb: 'note' | 'say'`, or `mode`, or `intent` — so the two vocabularies never share a switch. If the plan wants to be seen to reuse a precedent, the honest precedent is the *two-axis split itself* (attribution independent of role), which `ContextForm`'s own docstring states at lines 26-33. Do not borrow the word.
**Estimate 2-4h** now, plus churn for every downstream switch if it ships as written.

---

### F4 — HIGH — P4's risk is scoped to the wrong hazard; the real cost is the build face

**The claim.** Risk table: *"The client face cannot reach the slot/service face → P4 → The panel stays an overlay and comment 1 stands."* P4 story 1: *"Register a `sidebarRightTabs` type at `priority: 'extension'` and delete `stripMarkup()`'s fixed positioning."*

**Reachability: the plan over-states it.** Services are *provided by name* on the client context and reached as properties of the plugin's own `ctx`: `dsh-client-ui-sidebar-right/lib/client.js:3667-3668` does `ctx.reflect.provide("sidebarRightTabs", tabs)` and `ctx.reflect.provide("sidebarRight", controller)`; the client `inject` array is **service names** — `["slots","layout","locale","resources"]` (client.js:3648-3653). Our plugin's client module already receives `ctx` in `apply(ctx)` (`client/index.ts:837`) and already uses it (`ctx.effect(...)`, line 872). The "no imports" rule at `client/index.ts:8-10` and `95-104` constrains *module resolution*, not *service access*. Registering a tab needs no import at all. Reachability is near-certain; the plan's stated blocker is not the blocker.

**What the plan under-states — four items, none budgeted:**
1. **A tab body is a React component.** Call sites: `ctx.slots.register(config, GuideBody)` (client.js:3749-3758), `cb.register({…}, RightbarRoot)` (3705-3712), `(…, ExpandButton)` (3740-3744). And the shipped bundles are React — `grep` of `ui-sidebar-right/lib/client.js` returns `jsx` ×101, `jsxs` ×10, `createElement` ×3. Our client face renders **HTML strings** (`renderStrip`, `client/index.ts:608-628`) into `innerHTML`, and `tsconfig.client.json` sets `lib:["es2024"]`, `types:[]`, no `jsx`, no DOM lib — deliberately, with the reason written down: *"`standard-browser-types` would have bought accurate types for six objects at the cost of a whole second build face; this is the cheaper trade"* (`client/index.ts:12-15`). P4 spends exactly the trade this package declined.
2. **Two inject declarations are required, in two different vocabularies.** `dsh.client.inject` in `package.json` is **package names** (`ui-sidebar-right`: `["@deepseek-ai/dsh-api-session-controller","…dsh-client-resources","…dsh-client-ui-conversation","…dsh-client-ui-layout","…dsh-client-ui-session"]`); the client module's `inject` is **service names**. Validated at `dsh-client-modules/lib/index.js:63-68` (`platform` must be a string; `inject`/`external` optional string arrays). Ours declares `{"platform":"web"}` and `inject = []` (`client/index.ts:33`).
3. **The runtime require must resolve or the table throws.** `require("…")` that is "not a platform seed word, not a materialized module, and no registered package factory" is a hard error: *"client-modules: require(…) missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)"* (`dsh-client-modules/lib/client.js:345`). So the React runtime the component needs has to be *reachable through the module table*, which is a new dependency decision, not a code change.
4. **The artefact guard is compatible but the bundler is not a JSX pipeline.** `scripts/client-artefact.mjs` bans ESM and requires `__ModuleLoader__.load({id, factory})` — it tolerates `require`. But `scripts/client-bundle.mjs` wraps whatever `tsc -p tsconfig.client.json` emits, and that tsconfig has no `jsx`. Adding JSX/React to a `types: []`, non-DOM, non-JSX program is the item.

**The first thing that will break:** the **client build**, before anything renders — `tsc -p tsconfig.client.json` has no `jsx` option and `types: []`, so the first `.tsx` (or the first React-typed file) fails to compile, and then `client-bundle.mjs` fails or emits a bundle whose `require` misses the module table. Not the tab registration, and certainly not reachability.

**Fix.** Split P4 story 1 into an explicit *client build-face* story with its own estimate and its own exit criterion ("the client artefact still registers a factory, still passes the artefact guard, and now also compiles JSX against a module-table-reachable React runtime"), and count it. Decide *before* writing code whether the panel becomes a React component in the slot system or keeps rendering strings through a slot that accepts a string; those are different work.
**Estimate 20-32h** for the build face + inject declarations + a compliant body + a second artefact-guard case + 100% per-file coverage on the new modules. This is the largest un-costed item in the plan.

---

### F5 — HIGH — P4 is not independent of P2, and its truncation test is filed in the wrong package

**The claim.** P4: *"This is comment 1, and it is independent of P1–P3."* Traceability: *"an interrupted say logs only what was heard → P4 → `packages/realtime-agent/tests/truncation.spec.ts`."*

**The evidence.** Three of P4's four stories presuppose the `say` verb existing: story 2 (*"a voice-authored message renders as itself"* — there is nothing to render otherwise), story 3 (*"an interrupted `say` logs only what was heard"*), story 4 (*"a `say` that voices a file path … must not silently corrupt it"*). Only story 1 is genuinely independent. The plan's own exit criterion for P4 — *"a `say` is visible and attributed"* — requires P2's write path.

On the test path: `packages/realtime-agent/src/tools.ts` opens with `defineTool(...)` from `@deepseek-ai/dsh-tools` and defines `VoiceToolDeps` — it is the **model-facing tool set**, not the speech path. Voice/audio truncation on barge-in belongs with the plugin that owns the delegation and the turn (the responder) or the one that owns the audio route. Also, the marker assertion is cross-cutting and lands in `realtime-audio-ws/tests/marker.spec.ts` while its model-facing half lives in the responder — one assertion, two packages, one file.

**Fix.** Split P4 into **P4a — the surface** (truly independent; the panel, no fixed positioning) and **P4b — say fidelity** (after P2: truncation, verbatim identifiers, per-group attribution). Move the truncation test to the package that owns the speech path, and either split the marker assertion or state that it is deliberately one cross-package test with a named owner.
**Re-plan only.**

---

### F6 — HIGH — the write mechanism is the right shape but misses three load-bearing details

**The claim.** P2 story 3: *"`say` writes and starts a turn — `agent.followup(sourcedUserMessage)`, then `ctx.sessions.flush()` and require the acknowledgement before reporting success. The exact shape `dsh-schedule` uses, and the reason it is the vetted precedent."*

**This is materially right, and I want to say so before qualifying it.** `dsh-schedule/lib/index.js:934` does `this.agent.followup(message)`; `:692-694` does `if (!await ctx.sessions.flush(session)) throw …`; `dsh-session/lib/types/index.d.ts:417` declares `flush(session: Session): Promise<boolean>`. Requiring the ack is the correct shape.

**Three things the plan omits, all of which it will have to solve:**
1. **The sessionId→Agent hop is never named.** The responder holds a `sessionId: string` and injects `['sessionController','realtime']` (`responder/src/index.ts:104, 306`). `agent.followup` needs an **`Agent`**. The hop exists and is one call — `ctx.agents.get(id)` where *"the shared agent/session id"* is the session id (`dsh-agent/lib/types/index.d.ts:338-341`) — but `agents` is not in the responder's `inject`, and `get` returns `Agent | undefined`, so the plan owes a not-mounted path.
2. **The ack is a durability checkpoint, not a delivery ack.** `flush` *"Dispatch[es] the awaited `session/flush` durability checkpoint for `session`"* and resolves *"After at least one listener explicitly acknowledges completed durability work"* (`dsh-session/lib/types/index.d.ts:405-417`). It says nothing about whether the followup was accepted, or whether a turn opened. "Require the acknowledgement before reporting success" implies the stronger meaning. `followup` itself returns `void` (`runtime-types.d.ts:192`) — the only failure signal is a synchronous throw.
3. **The agent-busy path is missing.** `runMaintenance` *"@throws synchronously when turn-driving or another maintenance task already owns the agent"* (`runtime-types.d.ts:171`), and schedule handles exactly that by catching `_busy` and calling `this.waitForIdle()` (`dsh-schedule/lib/index.js:959-963`). Writing while a delegation answer is in flight is the *normal* case, not the edge case.

**Fix.** Name `ctx.agents.get(sessionId)` (and inject `agents`, or `ctx.get('agents')` as the responder already does for the session store at line 368); restate the ack as *durability of the log*, not delivery of the turn; and specify the busy path.
**Estimate 4-6h** beyond what the plan budgets.

---

### F7 — HIGH — flush-failure is a lost-or-duplicate question the plan does not settle

**The claim.** P2 story 6 and its exit criterion: *"a replayed retry writes exactly once."*

**The evidence.** The shipped ordering is: `followup` → durable `session.append("schedule/change", {operation:"dispatch", id})` → `flush` (`dsh-schedule/lib/index.js:934`, `:940-950`, `:965`). The durable record sits *between* the write and the barrier, and that is what makes a retry safe. Failure semantics in that precedent are also explicit and asymmetric: a throw from `followup` is *"framing or followup failed"* → warn, `return false` (no retry, nothing written, line 936); a throw from the dispatch append sets `this.faulted = true`, clears the timer (lines 952-955).

Mapped onto the plan's design:
- `followup` throws → nothing written. Safe to retry. **The plan does not say a throw is the signal.**
- `followup` ok, `flush` false → the item is already in the in-memory inbox and may already have opened a turn. A retry by request-id (F1's fix), which is the plan's stated mechanism, **cannot work**, because the id cannot exist. So the retry writes a **second turn**: a duplicate `say` in the user's session.

**Fix.** Same as F1: the durable `realtime/change` record written between the write and the flush, read by the retry. State the two failure arms separately in the plan (throw = nothing written; barrier-false = written but not durable, must not be re-issued blindly).
**Estimate 4-6h** (overlaps F1's work; counted separately because the *failure semantics* need their own tests).

---

### F8 — HIGH — no ordering specification, and the harness guarantees less than the plan assumes

**The claim.** Silent on ordering. P2's exit criterion asserts both a note and a say land, distinguishable, with the note starting no turn.

**The evidence.**
- `followup(message)`: *"Queue an ordinary follow-up turn and wake the driver. **The item becomes the sole ordinary message of its own turn.**"* (`runtime-types.d.ts:187-192`) — two writes are two turns, not one turn with two messages. The plan does not say so.
- `inject(message)`: targets `next-step`; the miss/discard caveats quoted in F2 apply.
- `InboxTarget = 'next-turn' | 'next-step'` (`dsh-agent/lib/types/types.d.ts:25`) — the two verbs land in **two different inboxes**, whose relative claim order is not specified by the harness.
- The responder's answer latch is keyed to the turn *its own admission* started — `turn.spec.ts`: *"The runner answers only the turn its own admission started"*, and *"a latch armed before then would belong to whatever was already running."* A `say` interleaved with a delegation turn introduces a `turn/start` the responder did not open; the plan does not say whether that is benign, and the latch's own comment suggests it is not obviously so.

So: a note and a say emitted close together, plus a delegation answer arriving in the same window, is a **three-way race with no stated resolution**. The plan's invariant 7 (*"a barge-in must not be assumed to have cancelled a dispatched write"*) is about barge-in, not about this.

**Fix.** Specify a per-session serialization for the two verbs — the harness precedent is right there: `runScheduleTransaction(agent, op)` chains per-agent operations through a `tails` map (`dsh-schedule/lib/index.js:702-717`) — and assert the order with the `agent/inbox/*` events rather than assuming it. State explicitly whether a note may be claimed by the say's own turn (my reading: it may, and that is fine if declared) and whether a note written while a turn is in flight defers.
**Estimate 4-8h.**

---

### F9 — HIGH — "no user checkpoint" against a live provider session

**The claim.** P1 exit criteria: *"four fixtures replay keylessly … **No user checkpoint** — P1 is machine-verifiable end to end."* P1 story 1: *"Drive a live GPT-Live-1 session and test …"*.

**The evidence.** A live GPT-Live-1 session needs the credential and the network; the repo's own discipline treats live probes as the expensive thing (`scripts/probe-delegation-path.mjs`, `scripts/probe:open → spike/open-failure-probe.mjs`, `docs/w1-entitlement-probe.md`, `docs/second-provider-spike.md`). The plan does correctly say the answer is recorded to a fixture *"so it is replayable keylessly (ADR-003) either way"* — the fixture is the deliverable. But the *spike itself* is not machine-verifiable without a key, and the plan promises no checkpoint.

**Fix.** Make the live probe an explicitly-flagged, separately-costed step, and assert only the fixture's replayability as machine-verifiable. Do not promise "no checkpoint" for a story whose first act is a network call.
**Estimate 0-2h** (sequencing honesty, not code).

---

### F10 — OBSERVATION — P2 and P4 are each two sprints

**The claim.** *"one shippable release per sprint, sized to finish in one session, because a previous long build died to context exhaustion"* (this is the repo rule the brief states; the plan's Definition-of-Done carries the per-sprint gate, the keyless replay, the real installed copy, and the dependency-ordered version bump).

**The evidence.** Counted against the plan: **P1** spike + contract + 4 fixtures + instruction text + docs — plausible for one session *if* the probe behaves. **P2** seven stories: a new merge-extended source kind, transport-minted attribution, a `say` write path with new plumbing (F6), a `note` path with a lifecycle it has not specified (F2), no-echo, idempotency (F1), and reason-carrying termination — plus, per the DoD, a gate run, keyless replay, an installed-copy verification, a CHANGELOG/version bump and a 100%-per-file coverage extension. That is two sessions. **P3** five stories, all test-shaped — one session, honest. **P4** four stories, one of which is a whole new client build face (F4) — two sessions.

**The quietly-double sprint is P2**; P4 is the second. Suggest P2a (the write path + provenance: `say` + `note`, the source kind, the hop, the barrier) and P2b (no-echo, idempotency, reasons) — the split falls naturally along "the capability ships" / "the capability is safe under retry and self-address".

### F11 — OBSERVATION — cite the primitive, not the wrappers

`send(message: UserMessage, target: InboxTarget, wakeup: boolean): void` (`runtime-types.d.ts:186`) is the parameterized primitive. The two verbs are `send(msg, 'next-step', false)` and `send(msg, 'next-turn', true)`; the plan's "`next-step` inbox, no turn" is describing `InboxTarget` without naming it, and never mentions `wakeup`, which is the flag that actually decides P2's central distinction. Citing `send` would put the fail-closed default and the wake flag in one visible call site. 1-2h.

### F12 — OBSERVATION — an asserted package is not installed

The *"Deliberately not in this plan"* table: *"the mailbox exists in-tree as `dsh-experimental-agent-team`"*. It is **not** in `~/.dsh/profiles/node_modules/@deepseek-ai/` (checked; the listing has no `dsh-experimental-agent-team`). Low stakes — it is a deferral, not a dependency — but it is a checkable claim that does not check.

### F13 — OBSERVATION — deleting the overlay leaves a dead seam to cover

`stripMarkup()`'s fixed positioning is a **documented correction**, not an oversight: strip.ts:36-49 explains the panel is opaque on purpose because it *"sits over the host's own text"*, reported from a screenshot. P4 story 1 frames it as the defect; the defect is the *reservation of space*, which only a column provides. Fine to delete — but the strip is a three-part seam: `stripMarkup` + `stripBootstrap` (strip.ts:52-80), `STRIP_ELEMENT_ID` **duplicated** in both halves (strip.ts:34, client/index.ts:500), the `mount` global and its double-mount dance (client/index.ts:825-870), and `stripRows()`'s two `body` rows. Deleting positioning and leaving the rest behind leaves dead code the 100% per-file gate still has to test. Count the removal, not the delete. 2-4h.

---

## What survives — explicitly, because it is right

- **The delivery mechanism.** `agent.followup` + an awaited `ctx.sessions.flush(session)` barrier before reporting success **is** the shipped pattern (`dsh-schedule/lib/index.js:934`, `:692-694`, `:965`, `:1221`; `dsh-session/lib/types/index.d.ts:417`). The plan read the precedent correctly and it is the right one.
- **`inject` for "no turn" is real and public.** `inject(message: UserMessage): void` exists and is documented on the Agent runtime type (`runtime-types.d.ts:209`). Its *limits* are the problem (F2), not its existence.
- **P4's target surface is real and is the documented path.** `priority: 'extension'` is a real band that may shadow a `builtin` and is released on unregister (`ui-sidebar-right/lib/client.js:3347-3360`); the two-stage registration into `ctx.sidebarRightTabs` plus the keyed `sidebar.right.pane.tab` seat is exactly as the plan describes (client.js:3704-3705, 3749-3758); `openTab(kind, options)` exists on the controller (client.js:3696-3698). `ui-sidebar-documentpreview` is a genuine third-party precedent that registers a tab through those stages with its own `dsh.client.inject`.
- **The `strip.ts:52-62` citation is correct.** Line 52 is `export function stripMarkup()`; line 55 carries `' style="position:fixed;right:12px;bottom:12px;z-index:40;'` verbatim. The brief's and the plan's line claims hold.
- **The "single no-import client face" claim is correct.** `client/index.ts:8-10` states the reason; `:95-104` states the structural `ClientContextLike` and that it *"needs one method, so it states one and imports nothing at all"*; `inject` is `[]` at line 33. (And the brief's inference from it — that reaching a client service is "a genuine architectural change rather than a small edit" — is the right instinct for the wrong reason: the change is real because of the build face, F4, not because of the import rule.)
- **Fail-closed classification as the default is correct** and is the one part of P1 that is machine-verifiable without a provider.
- **The test-path conventions fit.** Every proposed path matches `packages/*/tests/**/*.spec.ts`, which is exactly what `vitest.config.ts` includes (`include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts']`); `realtime-responder/tests/turn.spec.ts`, `realtime-audio-ws/tests/strip.spec.ts` and `realtime-agent/tests/tools.spec.ts` already exist. The only misfiled one is P4's truncation test (F5).
- **The gate's bite is understood.** `vitest.config.ts` enforces `perFile: true` with 100% statements/branches/functions/lines over `packages/*/src/**/*.ts` — so every new module this plan adds, including a new client build face, arrives with a full test file. The plan's DoD says this; its estimates do not account for it.

## Unverified

1. **The slot-body component contract.** `@deepseek-ai/dsh-client-ui-slots` is imported type-only by `ui-sidebar-right` and is **not installed** in the profile, so I could not read `slots.register`'s signature or the component type. My claim that a body is a React component rests on the call sites (`GuideBody`, `RightbarRoot`, `ExpandButton`) and on the shipped bundles being React (`jsx` ×101 / `createElement` ×3 in `ui-sidebar-right/lib/client.js`). If the slot runtime accepts a string-rendering function, F4's estimate drops materially.
2. **Whether the strip's page and the app's client-bundle page are the same page.** `client/index.ts:210-225` discusses the desktop page being `dsh-app://app` and `pageAuthority` returning `undefined` for it, which implies the strip's host page may differ from the app's React tree. If it does, P4's "replace the overlay with a tab" is not a re-parenting but a rebuild of the panel's controls against a different host.
3. **What `client-artefact.mjs` would say about a JSX-emitted bundle.** I read the guard in full and it does not ban `require`; whether `tsc`+`client-bundle.mjs` produce a compliant artefact from a `.tsx` source is untested by me.
4. **The plan's `spike/evidence/` and `research/raw/` artefacts.** I confirmed `research/` holds the four named documents and `spike/` exists, but did not open the raw per-track artefacts to check the plan's "1,555 lines total" claim.
