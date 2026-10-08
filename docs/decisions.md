# Decision record

Short ADRs. Each states the decision, the reason, and what it costs. Status: **accepted** unless
marked otherwise.

---

## ADR-001 — Client delegation, not Responses delegation

**Decision.** The plugin uses `delegation: {type: "client"}`.

**Why.** DSH is an external agent with its own models, tools and permissions. Client delegation is
the mode the protocol defines for exactly that: *your application runs the work and returns the
result*. Responses delegation asks OpenAI to run the backend instead, which would put a second
orchestrator beside DSH and make DSH's permissions advisory rather than authoritative.

**Cost.** We own the delegation loop, the context assembly and the 500-token budget. In exchange we
own permissions — which is the whole point.

**Consequence for the contract.** The v8→v9 bump carries the **client** vocabulary
(`commentary`/`thinking`/`instructions` appends, `delegation.created`, usage/closed). The
`response.*` family is a **separate capability** and must be scoped as its own story if ever built.

**Supersedes.** An earlier assumption that the round trip ran through `response.event`. Verified
live: `response.item.create` fails with *"requires Responses delegation"*, and `response.event` is a
server→client envelope exclusive to the Responses path.

---

## ADR-002 — Two rows: a provider and a consumer

**Decision.** `openai-live` (provider) and `openai-live-agent` (delegation consumer) are separate
rows on one seam.

**Why.** They fail independently and are configured independently. Bundling them would force a DSH
user who wants voice-but-not-delegation to carry the agent wiring anyway.

**Cost.** Two rows to version and test, and a contract bump to carry the seam.

---

## ADR-003 — Keyless replay as the CI contract

**Decision.** Conformance runs against recorded session fixtures and must pass with no API key.

**Why.** A test suite that needs a live key cannot run on a fork, cannot run on a contributor's
machine, and — as this build demonstrated within hours — stops entirely when the org's credit
balance hits zero. A gate that can be switched off by a billing event is not a gate.

**Cost.** Fixtures must be recorded, curated, and kept free of anything sensitive — which is
invariant 3 and invariant 5 working together.

---

## ADR-004 — No hand-rolled VAD

**Decision.** Endpointing is the engine's. The plugin never decides when an utterance has ended.

**Why.** It was a design rule first, and the spike proved the protocol enforces it: there is no
`session.input_audio.commit` event. A client-side VAD would be a second, competing turn detector.

**Cost.** Less control over turn latency. Accepted — a wrong detector is worse than a slow one.

---

## ADR-005 — Credentials as a tested invariant

**Decision.** A test proves no credential can reach a log, fixture, transcript or tarball.

**Why.** The plugin's whole job is to hold a live session, so credentials flow through every code
path it has. Review does not scale to that; a planted-string test does.

**Cost.** The mechanism must be built (W4) rather than assumed.

---

## ADR-006 — Upstream contribution over a private fork

**Decision.** Work toward an upstream PR, with acceptance criteria, rather than maintaining a fork.

**Why.** The ecosystem has a plugin targeting the *sunsetting* `gpt-realtime` family at the wrong
endpoint. The durable fix is upstream, not private.

**Cost.** Upstream review latency, and a design that must be acceptable to maintainers we do not
control.

**Amendment (2026-10-09) — the reason was half-right.** It was checked against the plugin's own
source. `AlexKaiqi/dsh-realtime-voice` registers `routeId: 'openai/gpt-realtime'`, so *the sunsetting
family* is confirmed; *the wrong endpoint* is not — it calls official `https://api.openai.com`, pins
that origin, and carries a second vendor (Doubao) alongside. The decision stands; its stated reason
does not, and the strategy should not be defended with an argument the evidence will not carry. Full
comparison: [competitive-landscape.md](competitive-landscape.md).

---

## ADR-007 — Non-governed: a standalone product repo

**Decision.** `dsh-openai-live` is built as a standalone product repository with **its own** gates
(secret scan before first push, tarball inspection before publish, keyless-replay CI). It is not run
as a governed Forge sprint.

**Why.** Three reasons, in order of weight:

1. **Scope.** The Forge vault governs *the Forge platform*. A DSH plugin is neither the platform nor
   vault content. Governance was volunteered onto this project; it was scoped back off by the CEO,
   not by the agent.
2. **Capability.** The governed pipeline cannot execute a code build — the worker's terminal is
   withdrawn, the orchestrator's is disabled, and the mechanism that would restore it is unbuilt and
   itself blocked behind an inactive sprint. A governance path that cannot execute is not a slower
   path; it is a stopped one.
3. **Separation of duty.** The sprint machinery holds a single active-sprint slot, occupied by an
   unrelated infrastructure cutover. A product should not be hostage to that.

**What is *not* decided here.** This is not a claim that governance is optional. The substantive
controls the review produced are kept — they are why there are invariants in
[design.md](design.md) and why the two irreversible acts still have gates. Only the *machinery* is
dropped.

**Reversal.** If the artifact is later brought under Forge, it enters as a **verification** sprint
over a built artifact — which is what that machinery is genuinely good at.

---

## ADR-008 — A file nothing reads is not a contract

**Decision.** This bundle does not ship the ecosystem's `plugin-spec.json` or
`spec/runtime-contract.json`, and no convention is adopted here until the thing that *consumes* it
has been found.

**Why.** A competing bundle ships both, and they make it look formal — which is precisely the
attraction. Neither is consumed: a grep over the harness's `packages/` and `docs/` finds them
nowhere, the installed market plugin (`safer-dsh-market`) does not read them, the official authoring
docs do not mention them, and `gh search code "plugin-spec.json"` returns only unrelated ecosystems
(ToolJet, elizaOS). They pass no gate, catch no drift, and register nothing.

Copying them would be cargo-culting — the appearance of rigour standing in for it — in a repository
whose entire thesis is that a check has to bite. The same instinct that produced this project's leak
scan ("every pattern unambiguous by construction, no allow-list") rejects it: before adding a
convention, find the reader.

**Cost.** We look less decorated beside a bundle that ships them, and the comparison is public
([competitive-landscape.md](competitive-landscape.md)). Accepted: a reviewer who reads *what consumes
a file* is worth more than one who counts files.

**Reversal.** If the harness or a market plugin begins reading them, adopt the convention then — to
the schema that consumer expects, not the schema we guessed.
