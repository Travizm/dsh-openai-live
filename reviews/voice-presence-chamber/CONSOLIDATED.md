# Chamber review — sprint plan: voice presence in the session

**2026-10-15.** Adversarial chamber over `docs/sprint-plan-voice-presence.md` (v1, 336 lines).
**5 reviewers · 62 findings · 12 CRITICAL · 8 convergent clusters.**

| reviewer | lens | findings | CRITICAL | verdict |
|---|---|---|---|---|
| Chen | security / trust boundaries | 11 | 2 | request_changes |
| Quinn | quality / testability | 14 | 4 | **do not sign off** |
| Haggai | agentic-AI architecture | 12 | 1 | buildable after F1/F2/F4 |
| Karen | compliance / audit trail | 12 | 2 | **not signed off** |
| Rusty | systems feasibility | 13 | 3 | buildable with changes, not at these sizes |

Per-reviewer transcripts: `chen-security.md` · `quinn-quality.md` · `haggai-architecture.md` ·
`karen-compliance.md` · `rusty-feasibility.md` (all in this directory).

**Calibration — read this before the findings.** No persona knowledge base exists on this machine, so
all five are **principles-only reviewers, not KB-backed subject-matter experts**. They compensate by
reading the source: the strongest findings below cite a file and a line, and several were verified by
decompressing the live session log. **One convergent finding was itself version-stale and I adjudicated
it below — do not treat convergence as truth without the check.**

**Method.** Each reviewer read the plan in full, then verified the plan's codebase claims against the
harness. Synthesis is by the convergent-findings method: independent lenses arriving at the same
weakness from different directions is the strongest available signal.

---

## 0. Adjudication — where the chamber was right and I was wrong

This is the most important section, because it corrects the plan's **central design assertion**, and
because one convergent finding needed the check that convergence cannot give.

### The plan's premise was false. Verified against the installed harness.

The plan (P2 story 1) says: *"`source.kind = 'realtime'` … the discriminator DSH already uses on
`agent-message`"*, and grounds it in `session-messaging.md` §3: *"`MessageSourceMap` already reserves
`schedule: { kind: 'schedule' } & ContextFormed`"*.

**Three reviewers (Haggai F2, Karen K-05, Rusty F3) independently found this false. I re-verified against
the installed harness, and they are right:**

```
~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts:94
  export interface MessageSourceMap {
      user:   { kind: 'user' };
      plugin: { kind: 'plugin'; plugin: string } & ContextFormed;
      model:  ModelMessageSource;
      tool:   ToolMessageSource;
  }
~/.dsh/profiles/node_modules/@deepseek-ai/dsh-schedule/lib/index.js:930
      source: { kind: "plugin", plugin: "schedule" }
```

Two corrections follow. **First**, the base map declares **four** kinds, not a reserved roster; kinds
like `schedule`, `agent-message` and `session-reference` are *merge-added by other packages*. **Second**,
the shipped `dsh-schedule` does **not** write `{kind:'schedule'}` — it writes the generic `plugin` kind
with a `plugin: 'schedule'` discriminator, which is the actual convention an out-of-tree producer should
copy.

**Where the stale reading came from, because it is a trap worth recording:** the string
`schedule: { kind: 'schedule' } & ContextFormed` *does* appear — in the **app's merged typert catalogue**
(`app.asar` → `dsh-llm/lib/typert.host.js`), a generated merge of every package's declaration-merged
additions across the whole composition. I verified the plan against a *merged catalogue* and reported it
as the *base type*. **A merged declaration catalogue is not the declaration site.** Both reviewers who
flagged it (Karen, Haggai) also read the checkout rather than the merged view and reached the same
conclusion from the other side — so the finding survived the check either way.

### The `form` field is wrong, and it is wrong for a stated reason

`ContextForm`'s own docstring (`message.d.ts:28-41`) forbids what the plan does with it:

> `MessageSource.kind` answers *who produced this*; `form` answers *what kind of thing it is* … **The
> vocabulary is SEMANTIC, never visual** … Colors, icons, ordering, and collapse defaults are the
> consumer's business and **must not enter this union**.

The vocabulary is `instructions | catalog | snapshot | notice | relay | recall`. The plan proposed
`form: 'note' | 'say'` — a **visibility and turn-starting** axis — and cited `form: 'relay'` as precedent,
but `relay` is documented as *"A message another agent addressed to this one"* (`message.d.ts:51-52`),
which is not what `say` means. **Real, convergent, and mine to fix:** keep `kind: 'realtime'` (or the
`plugin` + discriminator convention), and put the verb in a **kind-scoped field** — `source.realtime.verb`
or similar — so the two vocabularies never share a switch.

### Where convergence was NOT enough — resolved in the reviewers' favour anyway

Rusty (F12) reported `dsh-experimental-agent-team` absent from the profile; I had verified it ships
**inside the app bundle** but is **not composed in the profile's bundles or dependencies**. Both true,
different scopes. The plan's wording ("exists in-tree") is accurate but read as a load-bearing claim it
never was — it is a deferral. Wording fix only; no design change.

---

## 1. Convergent findings — 2+ independent reviewers

Severity is consolidated: multiple CRITICAL or CRITICAL+HIGH ⇒ 🔴 CRITICAL-convergent.

| # | finding | Chen | Quinn | Haggai | Karen | Rusty | consolidated |
|---|---|---|---|---|---|---|---|
| **C-1** | `form: 'note'\|'say'` collides with `ContextForm` (semantic-never-visual); the `schedule` precedent is false; the real convention is `plugin` + discriminator | — | — | F1, F2 | K-05 | F3 | 🔴 **CRITICAL** |
| **C-2** | The `say` is the higher-authority verb (it starts a turn) and carries **no** trust, approval, or off-switch analysis — P3 covers only the note | SEC-02 | — | F5 | K-01 | — | 🔴 **CRITICAL** |
| **C-3** | The note's lifecycle is unspecified and `inject()` does not deliver or durably keep: returns `void`, best-effort, may miss a claimed batch, may be discarded — so "the session log shows a note" is unsatisfiable as written | — | Q-09 | F8 | K-04 | F2 | 🔴 **CRITICAL** |
| **C-4** | Idempotency as written is **unbuildable**: `createUserMessage` forbids a producer id (`id?: never`); the real pattern is a durable `session.append` record between the write and the flush | SEC-11 | — | — | — | F1, F7 | 🔴 **CRITICAL** |
| **C-5** | P4's truncation criterion is **unsatisfiable**: the provider emits no interruption event (asserted by an existing test) and playback is browser-side; the test is also filed in the wrong package | — | Q-04 | F10 | — | F5 | 🔴 **CRITICAL** |
| **C-6** | P1 must probe write-path **reachability** and its gate consequence — incl. that using a harness package at runtime trips `pnpm declared-deps` (devDependencies are not the declared set) | — | Q-01, Q-07 | F9 | — | F6 | 🟠 **HIGH** |
| **C-7** | Exit criteria are prose-level and self-reported; **no gate step can fail on any provenance property** | SEC-07 | Q-11 | — | K-07, K-11 | — | 🟠 **HIGH** |
| **C-8** | Traceability table maps criteria to the wrong package, and one criterion to two halves in one file | — | Q-08 | — | — | F5 | 🟠 **HIGH** |
| **C-9** | No loop / rate / inbox / amplification control; no-echo is **mis-cited** (the producer is not a DSH agent, so AutoGen's self-delivery guard does not fire) | SEC-05 | — | F6 | — | — | 🟠 **HIGH** |
| **C-10** | The provenance marker's mechanism is unspecified; the in-tree convention is a **producer-authored framing line in content**, and the voice already writes one today | SEC-04 | — | — | K-03 | — | 🟠 **HIGH** |
| **C-11** | Ordering between note / say / a delegation answer is unspecified; harness guarantees less than the plan assumes | — | — | F11 | — | F8 | 🟠 **HIGH** |
| **C-12** | Sprints are undersized (P2 and P4 are each two sprints) and **P4 is not independent of P2** | — | Q-14 | — | — | F5, F10 | 🟡 OBSERVATION |
| **C-13** | The framing artifact is **not under version control** — plan, research and `session-messaging.md` are all untracked, so the traceability claim is uncheckable | — | — | — | K-08 | — | 🟠 **HIGH** |

---

## 2. Unique HIGH/CRITICAL findings

| # | finding | reviewer | severity | why it stands alone |
|---|---|---|---|---|
| **U-1** | **No threat model.** The plan enumerates invariants and risks — what the plugin must not do — but never states the adversary, assets, or trust boundaries, while adding a write path into a session with filesystem and tool authority | Chen SEC-01 | 🔴 CRITICAL | Unique lens; the other reviewers tested the plan's own framing rather than asking whether the framing was the right layer |
| **U-2** | **The record is already ambiguous and will stay that way.** Decompressing the live session log: **11 of 12 `user/message` rows carry `{"kind":"user","rpcId":"realtime-…"}`** — voice turns already logged as the human, discriminated only by a string prefix. No migration statement, and after P2 there will be **two** markers with no rule for which is authoritative | Karen K-09 | 🟠 HIGH | Unique, and verified from the artifact rather than argued. Also the research's own field-vs-name trap, live in this repo |
| **U-3** | **P4's real cost is a new client build face, not reachability.** Reachability is near-certain (services are read off the plugin's own `ctx`); the cost is that a slot body is a React component, while `tsconfig.client.json` is `types: []` with no JSX and the face renders HTML strings by design. **Est. 20–32 h — the largest uncosted item in the plan** | Rusty F4 | 🟠 HIGH | Unique, and it inverts the risk the plan names. First thing to break: the client build |
| **U-4** | **P3's own fix recreates the defect it eliminates.** "Any instruction from us travels as its own user turn" puts plugin text on the highest-authority channel, formatted as the human | Karen K-04c | 🟠 HIGH | Unique; the sharpest single observation in the review set |
| **U-5** | **A third irreversible act with no gate.** A write into an append-only log cannot be un-written, so by the project's own definition there is now a third irreversible act — with no version policy, no rollback, no kill switch | Karen K-06 | 🟠 HIGH | Unique. ADR-009's settings registry is the ready mechanism |
| **U-6** | **P1's "machine-verifiable end to end" is false by one step** — the spike needs a live keyed GPT-Live-1 session | Rusty F9 | 🟠 HIGH | Also noted by Karen K-11; a sequencing-honesty defect |
| **U-7** | **The classification is an adversarial problem, not a reliability one.** Fail-closed-on-ambiguity defends against accident only; an adversary needs no ambiguity, just one unambiguously-shaped delegation | Chen SEC-02 | 🔴 CRITICAL | Overlaps C-2 but states the threat model the plan lacks |

---

## 3. What survived

Adversarial pressure is as informative about what holds as about what breaks. **Confirmed by 2+ reviewers
or verified independently:**

- **Producer identity as a new source `kind` is the right single change.** The harness's own convention
  (Haggai, Karen, Rusty — and I have verified the merge-extension mechanism). *C-1 corrects the field, not
  the kind.*
- **The two delivery methods are the right pairing**, verified against the Agent runtime type:
  `inject()` = non-waking model-facing context (note); `followup()` = the turn's sole ordinary message
  (say). Confirmed by Quinn, Haggai, Karen, Rusty. **Not a metaphor imposed on the seam.**
- **`followup()` + awaited `ctx.sessions.flush()` + require the acknowledgement is a real, vetted
  primitive** — and the reviewers read the actual precedent: `dsh-schedule` flushes and throws on `false`
  (`persistence.ts:24-26`). Quinn, Karen, Rusty, Haggai.
- **The defect statement is accurate and now quantified.** `SessionController.prompt()` hard-codes
  `source: {kind:'user', rpcId}` (`commands.js` — verified). Karen measured its footprint in the live log
  (U-2).
- **Transport-stamped attribution, never model-supplied, is the plan's best control** — Chen, Haggai,
  Karen, Rusty all affirm it.
- **Fail-closed classification is the right default** and maps invariant 1 correctly — all five.
- **Banning plugin directives from sharing the note channel** — Chen calls it *"the single most important
  correctness call in the document."*
- **The 100% per-file coverage claim is genuinely enforced**, not asserted (`vitest.config.ts`,
  `perFile: true` on all four axes) — Karen, Quinn, Rusty. *Quinn's Q-03 is the corollary: enforced and
  real, but not an accuracy gate for a heuristic.*
- **ADR-008 applied to the plan's own output is exactly right** — Karen: *"Exactly what an auditor wants
  applied to a field set."*
- **File:line claims verified, not taken on trust.** `strip.ts:52-62` with `position:fixed` on line 55 —
  confirmed by Chen, Quinn and Rusty independently.

---

## 4. Go / No-Go

**Verdict: REVISE, then re-review the changed sections. Do not dispatch P1 as written.**

The plan's **substance and sequencing survive** — the write primitives are real, the defect is real and
now measured, the abstraction is right, and the two mechanisms it borrows are the shipped precedents.
What does not survive is **the central field design (C-1), the idempotency mechanism (C-4), three
unsatisfiable exit criteria (C-3, C-5, C-7) and two large mis-estimates (U-3, C-12).**

**Recommended dispositions, by cluster:**

| cluster | disposition |
|---|---|
| C-1 | **Fix now.** Kind-scoped verb field; strike the false `schedule` precedent from the plan **and from `session-messaging.md` §3**, which is the upstream source of the error |
| C-2, U-1, U-5, U-7, K-01 | **Fix now.** Register the verbs in the ADR-009 settings registry as session-scoped and **default-off**; state what a voice turn is *not* (not consent, cannot authorise a gated action, cannot change config); add the disable path to P2's exit criteria; write the threat model as a P1 deliverable |
| C-3, C-4 | **Fix now.** Replace producer-minted `Message.id` with a `source`-carried id plus a durable `realtime/change` event written **between the write and the flush** (schedule's ordering); bind the note's lifecycle to `agent/inbox/inserted|claimed|discarded` rather than to the session log |
| C-5, C-8 | **Fix now.** Either drop the truncation criterion or replace it with a client→server played-bytes frame asserted in the audio-ws package; re-derive the traceability table after the write path's home package is decided |
| C-6, C-7, C-10, C-13 | **Fix now.** Add the reachability probe (partly answered already — see below); make the gate read a **replayed session log** so a provenance regression fails the build; bind the marker to the in-tree framing-line convention; **commit the plan, `session-messaging.md` and `research/` before P1** |
| C-9, C-11, C-12, U-3, U-6, U-8 | **Re-scope.** Adopt the three non-semantic loop breakers; add ordering; split P2 into P2a/P2b and P4 into P4a/P4b; cost the client build face explicitly; stop claiming P1 is machine-verifiable end to end |
| U-2 | **Document, don't fix.** Pre-existing voice rows are permanently ambiguous — state it in `session-messaging.md` beside the log's other limits |

**One correction in the plan's favour.** Quinn's Q-01 and Haggai's F9 ask for the write-path reachability
probe. **That probe was run earlier in this session** and answered: bare `@deepseek-ai/*` specifiers
resolve for out-of-tree plugins through the shared `$DSH_HOME/profiles/node_modules`; `createUserMessage`
is importable from `dsh-llm/message`; the Agent carries `inject`/`followup`/`steer`; and
`resolveAgent()` returns `{agent}`. So the *reachability* half is retired — **but Quinn's Q-07 is a real
consequence the plan missed**: using that package at **runtime** trips `pnpm declared-deps`, because the
gate's declared set is `dependencies + optionalDependencies + peerDependencies` and *not*
`devDependencies`. The fix is a manifest change with a named gate consequence, not a probe.

---

## 5. CEO ratification required

Per the adversarial protocol, **nothing is patched until Travis rules.** The chamber found no genuine
reviewer-vs-reviewer fight on substance — severity gradings differ, conclusions do not — so what follows
are product decisions, not tie-breaks.

1. **Ratify the C-1 correction** — the verb moves off the shared `form` union into a kind-scoped field,
   and the false `schedule` precedent is struck from both the plan and `session-messaging.md`.
2. **Does `say` ship default-off with an explicit enable?** Chen and Karen both call the absence a
   blocking gap; the plan never considered it. Cost: one more thing to turn on. Benefit: the voice cannot
   start a turn in a session until you say it may.
3. **P4 scope.** Rusty costs the client build face at 20–32 h — the largest uncosted item. Split it (P4a
   panel, P4b say fidelity), defer it, or fund it?
4. **Commit the artifacts** (§C-13). Your repo, so your call — the plan is currently unversioned, which
   makes its own traceability claim uncheckable.
5. **Re-review scope.** I recommend a second pass on **the changed sections only**, by Quinn and Rusty
   (testability and feasibility — the two lenses that returned do-not-sign-off verdicts).
