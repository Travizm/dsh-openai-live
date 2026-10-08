# Adjudication — external review of the sprint plan

Commission: `gpt-6-astra` (OpenAI direct), reasoning effort high, single run.
Artefact: `reviews/sprint-plan-review-20261008T230732Z-51f9152e7c089941.md` — verbatim, **untrusted input**.
Receipt: 12,115 prompt · 8,125 completion (5,553 of them reasoning) · 213 s · visible 13,692 chars.
Plan reviewed: `docs/sprint-plan.md`, sha256[:16] `51f9152e7c089941`.

**Verdict.** The plan has not established that full S1 is either *necessary* or *sufficient* to retire its
foundational risk. Accepted, and it is the strongest finding: it attacks the plan's ordering argument
rather than its content.

## Corrections

| # | Finding | Disposition | Change |
|---|---|---|---|
| Q1 | An exposed rejection is not a retired risk; W1 proves the provider round trip only | Accept | S1 story 1 gains an evidence criterion: controller admission **and** a DSH-produced answer, correlated by delegation id |
| Q2 | No evidence that the *whole* diagnostic layer is the minimum sufficient step | Accept | **S1 splits.** **S0** = the minimal reason-preserving patch plus an installed-profile probe; the full layer is re-justified on S0's evidence |
| Q3 | Credentials could leak through the journal, the route or the spoken failures | **Accept — new risk** | Redaction becomes a first-class story: sentinel keys through every sink, including packaged artefacts |
| Q4 | A diagnostic layer can vanish with the subsystem it diagnoses; acked is not delivered | Accept | A fault-injection matrix, and an S1 checkpoint seeded with a *retained* failure so repairing the defect cannot erase it |
| Q5 | Is `delegationTimeoutMs` genuinely ours? | Accept as experiment | 3/45/90 s runs; provider expiry independent of the local setting would refute ownership of the usable window |
| Q6 | The self-test is observability work, not S2 convenience | Accept | Self-test moves into S0/S1, ahead of the final physical checkpoint |
| Q7 | \"One session per sprint\" is a correlation, not a demonstrated cause | Accept as hypothesis | The mandate becomes **checkpoints**, not sessions; the session-length claim is recorded as untested |
| Q8 | Replay is not evidence that a real second provider fits the seam | Accept | The provider spike moves ahead of S2 control polish; \"a documented afternoon\" needs a timed trial |
| Q9 | Provider-agnosticism as a *moat* is a commercial claim without evidence | **Defer the study; accept the weakening** | \"Moat\" is restated as a hypothesis; a cohort study is disproportionate at this stage |
| Q10 | Which restart costs justify a control plane, and which settings can change safely | Accept | A field-level matrix (plugin-local versus provider-session-bound) becomes an S2 design gate |

## What this forces

1. **S0 before S1** — the minimal patch and a probe, so the ordering is earned on evidence.
2. **Redaction is a story, not a note** — the plan omitted a real risk that the reviewer ranked above its own second item.
3. **The retained-failure checkpoint** — a repair must not be able to delete its own regression test.
4. **Checkpoints, not sessions** — the unit of work is the evidence boundary, not the context window.
5. **Moat becomes hypothesis.**

## Still to do

`docs/sprint-plan.md` needs republishing as **v2** carrying this table. The S0 patch is the first build.

**Status 2026-10-09.** v2 is published — the table above is carried verbatim in
`sprint-plan.md`, and the accepted dispositions are folded into the sprint structure (S0 inserted
ahead of S1; Q3's redaction story, Q4's fault matrix, Q6's self-test, Q8's pulled-forward provider
spike and Q10's field-level gate are all placed). The S0 build is in progress.
