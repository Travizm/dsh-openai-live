# Sprint plan — v2

**v2 · 2026-10-09.** Supersedes v1 (the reviewed text, `sha256[:16]=51f9152e7c089941`).
v2 is a **transcription** of an adjudicated external review, not a rethink: every change below is
traceable to a row in `docs/plan-review-adjudication.md`, which is the record of what changed and why.
The review itself (`reviews/sprint-plan-review-20261008T230732Z-51f9152e7c089941.md`, `gpt-6-astra`,
reasoning high) is **untrusted input**; only the adjudicated dispositions are plan.

Standalone work in this repo — it owns its gates, there is no Forge governance contract over it
(ADR-007). A sprint here is **one shippable release**, sized to finish inside **one session**, because
the longest build in this project died to context exhaustion rather than to difficulty. *(The
session-length claim is a recorded hypothesis, not a demonstrated cause — see Q7.)*

## The ordering principle

Tonight's evidence sets the order. We lost four hours to failures this plugin could not describe,
and — more importantly — **there is still an open unknown at the foundation**:

> Does the delegation→answer path work at all? The last voice test returned a sub-second refusal,
> which we proved means the responder is loaded and the session controller rejected the prompt.
> We do not yet know *why*, because the reason is discarded in a `catch {}`.

No feature work should start on top of that.

**What v2 changes about the first step.** v1 answered the unknown with the whole diagnostics layer and
asserted that the layer was the minimum necessary step. The review's strongest finding is that this
was never established — *full S1 is neither shown necessary nor shown sufficient to retire the
foundational risk*. v2 accepts it: the first sprint is no longer S1. It is **S0** — the smallest thing
that answers the open question — and S1's full layer is then justified **on S0's evidence** rather
than on its own say-so.

## The adjudication, carried

Commission: `gpt-6-astra` (OpenAI direct), reasoning effort high, single run.
Receipt: 12,115 prompt · 8,125 completion (5,553 of them reasoning) · 213 s · visible 13,692 chars.
Reviewed plan: v1, `sha256[:16]=51f9152e7c089941`. Full text: `docs/plan-review-adjudication.md`.

| # | Finding | Disposition | Change |
|---|---|---|---|
| Q1 | An exposed rejection is not a retired risk; W1 proves the provider round trip only | Accept | S1 story 1 gains an evidence criterion: controller admission **and** a DSH-produced answer, correlated by delegation id |
| Q2 | No evidence that the *whole* diagnostic layer is the minimum sufficient step | Accept | **S1 splits.** **S0** = the minimal reason-preserving patch plus an installed-profile probe; the full layer is re-justified on S0's evidence |
| Q3 | Credentials could leak through the journal, the route or the spoken failures | **Accept — new risk** | Redaction becomes a first-class story: sentinel keys through every sink, including packaged artefacts |
| Q4 | A diagnostic layer can vanish with the subsystem it diagnoses; acked is not delivered | Accept | A fault-injection matrix, and an S1 checkpoint seeded with a *retained* failure so repairing the defect cannot erase it |
| Q5 | Is `delegationTimeoutMs` genuinely ours? | Accept as experiment | 3/45/90 s runs; provider expiry independent of the local setting would refute ownership of the usable window |
| Q6 | The self-test is observability work, not S2 convenience | Accept | Self-test moves into S0/S1, ahead of the final physical checkpoint |
| Q7 | "One session per sprint" is a correlation, not a demonstrated cause | Accept as hypothesis | The mandate becomes **checkpoints**, not sessions; the session-length claim is recorded as untested |
| Q8 | Replay is not evidence that a real second provider fits the seam | Accept | The provider spike moves ahead of S2 control polish; "a documented afternoon" needs a timed trial |
| Q9 | Provider-agnosticism as a *moat* is a commercial claim without evidence | **Defer the study; accept the weakening** | "Moat" is restated as a hypothesis; a cohort study is disproportionate at this stage |
| Q10 | Which restart costs justify a control plane, and which settings can change safely | Accept | A field-level matrix (plugin-local versus provider-session-bound) becomes an S2 design gate |

**What the adjudication forces, in one list.**

1. **S0 before S1** — the minimal patch and a probe, so the ordering is earned on evidence.
2. **Redaction is a story, not a note** — the plan omitted a real risk that the reviewer ranked above
   its own second item.
3. **The retained-failure checkpoint** — a repair must not be able to delete its own regression test.
4. **Checkpoints, not sessions** — the unit of work is the evidence boundary, not the context window.
5. **Moat becomes hypothesis.**

## Options

**A — Observability first, then features, then portability. (Recommended.)**
S0 answer the question · S1 see it · S2 drive it · S3 hear it · S4 open it · S5 ship it.
S0 retires the unknown directly; S1's layer is then justified on S0's evidence. Every later sprint
inherits a plugin that explains itself, so its failures cost minutes instead of evenings.

**B — Narration first.** The flashy demo, sooner. Rejected *for now*: it builds on an unobservable
base. **Q2 reopens it** — comparable results from S0's probe against the full layer would weaken the
feature embargo, and B becomes live again after foundational repair.

**C — Consolidate into two sprints.** Faster to a nominal v1, but each increment becomes too large to
finish in a session, which is precisely the failure mode this plan exists to avoid. **Q7 weakens the
premise**: if work resumes safely from a clean, tested, unpublished checkpoint, the rejection of C is
re-examined with smaller internal checkpoints.

## S0 — Answer the question

*Retires: nothing on its own. Establishes whether S1 is building on rock or sand.* (Q2, Q3, Q6)

The smallest thing that answers the open unknown, and the point where the review and the maintainer
independently arrived. It is a patch and a probe — **not** the diagnostic layer.

Stories:
1. **Reasons preserved.** Stop discarding the controller's rejection. The turn runner distinguishes
   *declined* (nothing to ask), *refused* (**with the controller's reason**) and *timed out*, instead
   of collapsing all three into `undefined`. The reason survives to whoever asked.
2. **Redaction on the reason path.** The reason is the first place provider text other than an answer
   reaches a human. It ships **redaction-safe from the start** — never deferred to a later hardening
   pass — with sentinel-key tests proving a planted key or the route token cannot travel on it. *(This
   is Q3's story beginning, not its whole; the journal, the route and the spoken surfaces are the rest,
   and they land together in S1.)*
3. **An installed-profile probe.** A script that drives the delegation path against the *installed*
   profile — shadow-free — and reports the correlated evidence: delegation id, the reconstructed
   prompt, the controller's verdict **with its reason**, the agent result and the returned speech.

Exit criteria: the probe runs against the installed profile and reports, for one real delegation,
either a DSH-produced answer or the controller's reason; the reason path is redaction-tested; gate
green. **No user checkpoint** — S0 is machine-verifiable end to end, and its output is the input to
S1's justification.

## S1 — See it (observability)

*Retires: the open unknown (on S0's evidence). Also everything else's diagnostic cost.* (Q1, Q3, Q4, Q6)

Stories:
1. **Reasons on the wire.** The reason S0 preserved, carried out of the turn runner and onto a
   surface. **Evidence criterion (Q1):** retirement requires controller admission **and** a
   DSH-produced answer for one real delegation, correlated by delegation id — an exposed rejection is
   not a retired risk, and W1 proves the provider round trip only.
2. **A journal.** Bounded ring buffer over the events the plugin already emits and consumes:
   session open/close, socket accept/reject with the verdict, delegation seen, prompt admitted or
   refused **with the reason**, answer received, window elapsed, config as resolved.
3. **Spoken failures.** Narrate a failure through `commentary.append` so it reaches the user's ear,
   not a log nobody reads.
4. **`GET /dsh-realtime/diagnostics`.** The journal as JSON via the web server's route registry.
5. **Redaction — the story (Q3).** Sentinel keys planted in resolved config and in controller/provider
   exceptions, then driven through **every** sink: the journal, the diagnostics route, the spoken
   failures, and the packaged artefacts. The route is tested under its intended access policy **and
   from an unauthorized caller**. Zero sentinel leakage, with useful failure categories preserved. Any
   leakage requires an allowlisted schema and redaction **before** publication.
6. **Fault-injection matrix (Q4).** Inject controller refusal, an inactive responder, socket loss,
   append-acknowledged-without-playback, and barge-in. Record journal entries, wire acknowledgements,
   output transcripts and actual playback **separately** — respecting invariant 6 (*ack ≠ delivery*).
7. **Self-test (Q6, moved from S2).** Key entitled, route accepting, session live, prompt admitted,
   canned turn returned — as one verdict whose output is worth pasting into a bug report. Runs before
   the final physical checkpoint, not after it.

Exit criteria: gate green (tests + 100% per-file coverage, both growing); the reasons are asserted in
tests, not just present; **zero sentinel leakage across every sink**; published; installed into the
app's profile; **one user checkpoint** — speak a request and hear the failure reason rather than the
model's flat refusal — **seeded with a retained failure (Q4)** so repairing tonight's defect cannot
erase the checkpoint that proves it.

## S2 — Drive it (control + in-app UX)

*Retires: the console global as the on-switch, and the restart-per-config-change tax.*

**Pulled forward (Q8):** the **second-provider spike**. Replay proves another implementation can
reproduce the existing vocabulary; it is weak evidence about an independently designed API, so before
any control-plane polish we probe a second live provider for external delegation, intent
reconstruction, progressive output, interruption, cancellation and permission ownership. Sanitized
traces, a capability matrix, consumer changes and engineering hours. *(The spike moves ahead of S2; the
adapter release stays at S4.)*

Stories:
1. **Field-level matrix first (Q10, design gate).** Separate plugin-local settings from
   provider-session-bound ones (`model`, `voice`, `instructions`, delegation mode). Test target-session
   and timeout changes **during** an active delegation, plus explicit reconnect handling for immutable
   fields. Settings that need a new provider session demand explicit reconnect UX — promising seamless
   mutation would violate invariant 8.
2. **Live config over the socket** — `status` / `set <key>=<value>`, so changing which session the
   voice steers costs a message, not two restarts and a false lead.
3. **A status strip via `webserver/index-inject`** — the same door the client face already uses for
   its settings: state, the steered session, the last failure.
4. **Start/stop and a session picker** in that strip; no devtools.

Exit criteria: use the whole thing without a console; a stranger could too.

## S3 — Hear it work (narration)

*Retires: the all-or-nothing answer, which is the real ceiling on tool use.* (Q5)

Stories:
1. **Spike: the usable window, measured (Q5).** Controlled **3-, 45- and 90-second** agent turns with
   `delegationTimeoutMs` set below and above completion, comparing a final answer against milestone
   commentary — including interruption and late-result cases, and respecting the 500-token append cap.
   *Completion tracking the local setting* supports ownership of the timeout; *provider expiry
   independent of it* refutes ownership of the whole usable window.
2. **Spike: pacing.** What pacing does the provider's `commentary.append` actually support? Answer
   before designing.
3. **Narrate progress** — the agent's steps spoken as they happen, low-interruption: spoken for
   milestones, silent for chatter.
4. **Raise `delegationTimeoutMs`** — only on story 1's evidence; it is our row, not the platform's, and
   tonight's claim that it was fixed was wrong.
5. **A transcript panel**, so the spoken exchange is reviewable after the fact.

Exit criteria: a tool request narrated live end to end — *"running it… 14 files… the README says…"* —
which is the demo that sells the plugin; and the usable window is a measured number, not a belief.

## S4 — Open it (provider-agnostic)

*Retires: the single-vendor dependency. This is the honest adoption barrier — **the moat is a
hypothesis** (Q9).*

Stories:
1. **A second adapter** against the existing seam — `realtime-openai` and `realtime-replay` prove two
   implementations fit, so this is an adapter, not a rewrite. *(Its spike already ran before S2.)*
2. **A timed independent trial (Q8).** "Adding a third is a documented afternoon" is a promise that
   needs a stopwatch: one independent adapter, timed.
3. **Bring-your-own-key onboarding** that says which capability the key needs and proves it before
   saving, rather than failing at session create.
4. **Document the seam's contract** as the thing third parties implement.

Exit criteria: the plugin works on two providers; adding a third is a *measured* afternoon.

## S5 — Ship it (presence)

*Retires: discoverability. A plugin nobody finds is a private tool.*

Stories:
1. **The plugin-author checklist** — `peer`, never shadow (with this project's case study); the
   lazy-CJS client contract; `registerUpgrade`; `index-inject`. All four were found by reading source.
2. **A 30-second demo** — one take: speak, the agent works, it is narrated back.
3. **Catalogue presence** — the `dsh-plugin` GitHub topic, npm description and keywords, the
   catalogues that index them.
4. **Upstream contribution** — a docs PR for the four doors, and precise issues for an author-facing
   log channel and a clearer signal for a row that never activates.

Exit criteria: someone who has never heard of the project can install it and succeed in under five
minutes, and the four doors are documented in the place an author would look.

## Cross-cutting

**Definition of done, every sprint.** Gate green; 100% per-file coverage maintained; a real installed
copy verified (the pattern that caught every defect tonight); CHANGELOG and version bumped in
dependency order; **profile verified free of shadowed harness packages**; the sprint's lessons written
into `dsh-plugin-development` — which is currently **blocked pending approval** and stays outstanding
until it lands.

**Consolidate the user's checkpoints.** Travis is needed only for physical checks: a restart, a
microphone, an ear. Each sprint should batch its user-dependent steps into **one or two checkpoints**
near the end, and everything before them should be machine-verifiable. Keep going until a human is
physically required.

**Checkpoints, not sessions (Q7).** The unit of work is the **evidence boundary**, not the context
window. Work stops at a clean, tested, published checkpoint from which a fresh context can start
safely. *Whether a sprint must fit one session is an untested hypothesis* — it stays a target, not a
mandate, until a bounded stop/resume exercise says otherwise.

## Top risks

| risk | sprint that retires it | if it holds |
|---|---|---|
| The delegation path doesn't work and we don't know why | **S0 → S1** | Every later sprint is guessing |
| Credentials leak through a new diagnostic sink (journal, route, speech) | **S0/S1** | A disclosure outlives the debugging session that introduced it |
| The diagnostic layer vanishes with the subsystem it diagnoses | S1 (fault matrix + retained failure) | The tooling dies exactly when it is needed |
| Config read only at boot | S2 (field-level matrix) | Feature work slows to restart speed |
| A second provider's realtime API doesn't fit the seam | **S2 spike** | Single-vendor; audience stays small |
| `commentary.append` can't pace narration, or the window isn't ours | S3 spike | Narration falls back to one spoken summary |
| The ecosystem's doors stay undocumented | S5 | Slower adoption, more broken third-party plugins |
