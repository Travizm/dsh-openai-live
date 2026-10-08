# Sprint plan

Standalone work in this repo — it owns its gates, there is no Forge governance contract over it.
A sprint here is **one shippable release**, sized to finish inside **one session**, because the
longest build in this project died to context exhaustion rather than to difficulty.

## The ordering principle

Tonight's evidence sets the order. We lost four hours to failures this plugin could not describe,
and — more importantly — **there is still an open unknown at the foundation**:

> Does the delegation→answer path work at all? The last voice test returned a sub-second refusal,
> which we proved means the responder is loaded and the session controller rejected the prompt.
> We do not yet know *why*, because the reason is discarded in a `catch {}`.

No feature work should start on top of that. And the tool that answers it is the same tool the
roadmap wants anyway: **the reason the diagnostics layer is first is that its first story is the one
that tells us whether the rest of this plan is building on rock or sand.**

## Options

**A — Observability first, then features, then portability. (Recommended.)**
S1 see it · S2 drive it · S3 hear it · S4 open it · S5 ship it.
Retires the unknown in S1's first story; every later sprint inherits a plugin that explains itself,
so its failures cost minutes instead of evenings.

**B — Narration first.** The flashy demo, sooner. Rejected: it builds on an unobservable base, it
cannot verify the current unknown, and its own failures inherit tonight's diagnostic tax in full.

**C — Consolidate into two sprints.** Faster to a nominal v1, but each increment becomes too large to
finish in a session, which is precisely the failure mode this plan exists to avoid.

## S1 — See it (observability)

*Retires: the open unknown. Also everything else's diagnostic cost.*

Stories:
1. **Reasons on the wire.** Stop discarding the controller's rejection; carry a reason out of the
   turn runner instead of collapsing refusal and timeout into `undefined`. *This story answers the
   open question.*
2. **A journal.** Bounded ring buffer over the events the plugin already emits and consumes:
   session open/close, socket accept/reject with the verdict, delegation seen, prompt admitted or
   refused **with the reason**, answer received, window elapsed, config as resolved.
3. **Spoken failures.** Narrate a failure through `commentary.append` so it reaches the user's ear,
   not a log nobody reads.
4. **`GET /dsh-realtime/diagnostics`.** The journal as JSON via the web server's route registry.

Exit criteria: gate green (tests + 100% per-file coverage, both growing); the reasons are asserted in
tests, not just present; published; installed into the app's profile; **one user checkpoint** — speak
a request and hear the failure reason rather than the model's flat refusal.

## S2 — Drive it (control + in-app UX)

*Retires: the console global as the on-switch, and the restart-per-config-change tax.*

Stories:
1. **Live config over the socket** — `status` / `set <key>=<value>`, so changing which session the
   voice steers costs a message, not two restarts and a false lead.
2. **A status strip via `webserver/index-inject`** — the same door the client face already uses for
   its settings: state, the steered session, the last failure.
3. **Start/stop and a session picker** in that strip; no devtools.
4. **Self-test** — key entitled, route accepting, session live, prompt admitted, canned turn returned,
   as one verdict whose output is worth pasting into a bug report.

Exit criteria: use the whole thing without a console; a stranger could too.

## S3 — Hear it work (narration)

*Retires: the all-or-nothing answer, which is the real ceiling on tool use.*

Stories:
1. **Spike:** what pacing does the provider's `commentary.append` actually support? Answer before
   designing (this is the one story whose cost is genuinely unknown).
2. **Narrate progress** — the agent's steps spoken as they happen, low-interruption: spoken for
   milestones, silent for chatter.
3. **Raise `delegationTimeoutMs`** — it is our row, not the platform's; tonight's claim that it was
   fixed was wrong.
4. **A transcript panel**, so the spoken exchange is reviewable after the fact.

Exit criteria: a tool request narrated live end to end — *"running it… 14 files… the README says…"* —
which is the demo that sells the plugin.

## S4 — Open it (provider-agnostic)

*Retires: the single-vendor dependency. This is the moat, and the honest adoption barrier.*

Stories:
1. **Spike:** pick and probe a second realtime provider (Gemini Live is the obvious candidate).
2. **A second adapter** against the existing seam — `realtime-openai` and `realtime-replay` prove two
   implementations fit, so this is an adapter, not a rewrite.
3. **Bring-your-own-key onboarding** that says which capability the key needs and proves it before
   saving, rather than failing at session create.
4. **Document the seam's contract** as the thing third parties implement.

Exit criteria: the plugin works on two providers; adding a third is a documented afternoon.

## S5 — Ship it (presence)

*Retires: discoverability. A plugin nobody finds is a private tool.*

Stories:
1. **The plugin-author checklist** — `peer`, never shadow (with tonight's case study); the lazy-CJS
   client contract; `registerUpgrade`; `index-inject`. All four were found by reading source.
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

**One session per sprint.** A handoff at each boundary. The repo must be left clean, green and
published at every sprint end, because that is the only state from which a fresh context can start
safely.

## Top risks

| risk | sprint that retires it | if it holds |
|---|---|---|
| The delegation path doesn't work and we don't know why | **S1** | Every later Sprint is guessing |
| Config read only at boot | S2 | Feature work slows to restart speed |
| `commentary.append` can't pace narration | S3 spike | Narration falls back to one spoken summary |
| A second provider's realtime API doesn't fit the seam | S4 spike | Single-vendor; audience stays small |
| The ecosystem's doors stay undocumented | S5 | Slower adoption, more broken third-party plugins |
