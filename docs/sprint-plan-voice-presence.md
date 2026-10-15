# Sprint plan — voice presence in the session

**v2 · 2026-10-15.** Supersedes v1 (`sha256[:16]=33bf3f6e565128fe`), which was reviewed by a
five-lens adversarial chamber on 2026-10-15 (`reviews/voice-presence-chamber/CONSOLIDATED.md`:
5 reviewers, 62 findings, 12 CRITICAL, 13 convergent clusters — **no reviewer signed off v1**). v2 is a
**revision under those findings, not a rethink**: every change below is traceable to a cluster in the
consolidated review (C-1…C-13, U-1…U-7) and to a recommendation (R1–R24). CEO ratification was given
2026-10-15 ("go"): R1–R7 fix now, R8–R16 add, R17–R21 re-scope, R22–R24 document.

**What this plan is for.** The CEO ruled **Option C** on 2026-10-14: the voice gets **two verbs** into a
DSH session — a **silent note** (model-facing context, does not wake a turn) and a **visible say** (a
sourced message attributed to the voice, which does start a turn). This plan is the route to that, and
the two comments that produced it:

1. *"The GUI is terrible."*
2. *"There is no way for the voice agent to write into the session — we need a session-to-session
   messaging protocol."*

**Standalone work, its own gates.** ADR-007 applies unchanged: this repo owns its gates (leak scan,
keyless replay, built-artefact smoke, per-file 100% coverage) and is **not** run as a governed Forge
sprint. Nothing here needs a Forge story file; nothing here may skip this repo's `pnpm gate`.

---

## The evidence base

Four primary-source research documents, commissioned for this plan and **verified on disk** (1,555
lines total, plus raw per-track artefacts at `research/raw/`):

| document | what it settles |
|---|---|
| [`../research/market-voice-features.md`](../research/market-voice-features.md) | what market-leading realtime voice assistants actually ship, as a feature matrix |
| [`../research/voice-integration-patterns.md`](../research/voice-integration-patterns.md) | how coding agents/IDEs integrate voice, and whether voice is a distinct author |
| [`../research/session-messaging-protocols.md`](../research/session-messaging-protocols.md) | A2A/ACP/MCP scoping, framework messaging failure modes, provenance field design |
| [`../research/voice-platform-building-blocks.md`](../research/voice-platform-building-blocks.md) | what the builder platforms provide, and which parts to adopt or avoid |

Plus the grounding this repo already had: [`session-messaging.md`](session-messaging.md) (the spine
survey — **corrected 2026-10-15**, see below), [`steering.md`](steering.md), [`design.md`](design.md)
(8 invariants), [`decisions.md`](decisions.md) (ADR-001–009), and [`protocol.md`](protocol.md) (the
verified wire vocabulary).

---

## The finding that reframes the work

**The silent half is table stakes. The visible half is unclaimed by anybody.**

- **Silent injection ships everywhere.** GPT-Live `session.thinking.append` /
  `session.instructions.append`; OpenAI Realtime `conversation.item.create` plus out-of-band
  `response.create`; ElevenLabs `contextual_update`; Pipecat system frames. Every builder platform has
  it. Our `note` is therefore *not* a differentiator — it is a missing table stake.
- **A visible, voice-attributed, turn-starting, *sourced* message is shipped by nobody.** Every visible
  injection verb on the market is **user-attributed** — ElevenLabs `user_message` is documented as *"as
  if the user had spoken it"*, LiveKit is `generate_reply(user_input=…)`, Vapi's is a user message — and
  every assistant-side text channel is **audio-derived** (`bot-transcription`, `agent_response`). The
  closest precedents are GPT-Live's `session.commentary.append` (makes the model *say* things aloud, but
  imposes no UI requirement) and VS Code Voice Mode (which *"announces when it routes a request to an
  existing session"*). Ours is that pair **plus a durable, sourced log entry**.
- **And the market matches our "defect".** No shipping coding agent gives voice a distinct author
  identity: in Codex, Claude Code, Cursor, Windsurf, VS Code/Copilot, Replit and JetBrains Air the voice
  transcript becomes a **plain user-role message**. Codex's only visible authorship affordance in its TUI
  is a **colour** (`spoken: bool` → red bold vs dim) over identical text, so its own logs cannot tell
  spoken from typed. `SessionController.prompt()`'s hard-coded user provenance therefore **matches the
  leading implementation** — this is not a bug to fix to reach parity. It is a cell to claim.

**The one product with first-class provenance is not a coding harness.** Ticketing and chat platforms
converged on a clean two-axis model — **attribution independent of role** — and they implement our two
verbs as **one boolean or a type split**: Zendesk's comment `public: true|false` (verified verbatim),
Freshdesk reply-vs-private-note, Intercom `author.type` plus a separate note/reply axis, Slack
posted-vs-ephemeral. And the strongest validation of Option C specifically is the **Claude Agent SDK**:
`SDKUserMessage.origin?` — documented as *"Provenance of a user-role message"* — beside
`shouldQuery?: false`, documented as *"append the message to the transcript **without** triggering an
assistant turn… without spending a model call on it."* Two independent fields, mapping 1:1 onto the two
verbs.

---

## v2's central correction — the chamber's most important finding

**v1 verified its central design assertion against the wrong artefact, and the chamber caught it.**
v1 claimed `MessageSourceMap` "already reserves" a `schedule` kind and proposed riding the shared
`form` union with `'note' | 'say'`. Both false (C-1: Haggai F2, Karen K-05, Rusty F3 — re-verified
against the installed harness before this rewrite):

- The base `MessageSourceMap` declares **four** kinds (`dsh-llm/lib/types/message.d.ts:94`):
  `{ user, plugin: {kind:'plugin'; plugin:string} & ContextFormed, model, tool }`. Everything else is
  **merge-added** by other packages.
- The shipped `dsh-schedule` writes `{ kind: "plugin", plugin: "schedule" }` — the **actual** convention
  for an out-of-tree producer.
- `form` is documented **semantic, never visual** ("colors, icons, ordering… must not enter this
  union"), and its `relay` value means *"a message another agent addressed to this one"* — not a
  note/say axis.

**Where the error came from:** the false string *does* appear — in the app's merged typert catalogue
inside `app.asar`, a generated merge of every package's declaration-merged additions. **A merged
declaration catalogue is not the declaration site.** Full correction at
[`session-messaging.md` §3](session-messaging.md).

### The design rule that follows — trust is derived from the path, not from the prose

The gate decides **whether** to write (fail-closed). It cannot **label** what it wrote — trust and
visibility are a deterministic function of the **delivery path taken**:

| path taken | verb | trust | wakes a turn |
|---|---|---|---|
| `agent.inject(msg)` | note | untrusted (content-only) | **no** |
| `agent.followup(msg)` | say | attributed | **yes** |

This collapses C-1, C-2's trust half and Haggai's F4 into one change: nothing in the write path may
influence *what kind of write it is credited with*.

**And per [ADR-010](intent-gate-decision.md), nothing on the safety path is a model either.** Ten cells
were measured on one harvested corpus. The gate is a **positional rule**: the authorising imperative must
be at the head of the utterance, and any utterance that opens by attributing speech elsewhere — *"The
commit message said to tell the session…"* — is a question. The rule produced **zero dangerous errors**;
all nine model cells produced between three and twelve. The measurement is the reason the model comes off
the safety path, not an aesthetic preference for rules. Attribution — actor id, origin session,
verb — is stamped by the bridge at the moment of delivery, from code, never from model output.

---

## P1 — Settle the channel, name the threat, land the gate hook

*Retires: whether a write can be requested at all, whether the request can be classified, and what the
adversary looks like.* The spike, the threat model, and the gate hook that makes later sprints
enforceable. **P1 is measured live and replayed keylessly — it is not machine-verifiable end to end**
(the spike needs a live keyed GPT-Live-1 session; only the fixtures replay without one) *(U-6, R20)*.

**Stories.**
1. **The reachability probe is retired; its gate consequence is not.** Out-of-tree packages resolve bare
   `@deepseek-ai/*` specifiers through the shared `$DSH_HOME/profiles/node_modules`, `createUserMessage`
   is importable from `dsh-llm/message`, and the Agent carries `inject`/`followup`/`steer` — verified
   2026-10-15. **The open question is Q-07's**: using a harness package at **runtime** trips
   `pnpm declared-deps` (its declared set is `dependencies + optionalDependencies + peerDependencies`,
   not `devDependencies`). Story: make the manifest change explicitly, state the gate consequence, and
   pin the harness packages as `peerDependencies` *(R15, Q-07)*.
2. **The channel spike.** Drive a live GPT-Live-1 session (`delegation: {type:'client'}`) and measure:
   does `session.start` accept a function/tool declaration (the endpoint rejects unknown fields, so a
   rejection is a schema answer); does a declaration change any observed event; does structured intent
   exist *within* client delegation? **Pre-committed rule for the yes-branch** *(SEC-10)*: a tool
   channel from the voice is limited to **non-consequential, read-only intent, or rejected outright** —
   recorded with its reasoning, so the spike cannot quietly widen the plugin's authority. Record to a
   fixture; sanitized evidence to `spike/evidence/`; the answer lands in `docs/delegation-intent.md`.
3. **Threat model and trust boundaries — a P1 deliverable, not prose** *(U-1, SEC-01, R8)*. Assets:
   session-log integrity, agent tool authority, credentials, the user-consent record. Boundaries: audio
   channel → delegation envelope → bridge → session. Adversaries: untrusted repo/web content reached by
   the coding session; a network attacker on the local WS route; a compromised or confused voice model.
   A data-flow diagram annotated with which fields cross which boundary. **This is the file that makes
   C-2 auditable.**
4. **A classification contract, stated as a decision procedure with a named disposition owner** *(K-11,
   R24)*. Three outcomes: note / say / **question** — and *anything not matching is a question*. The
   contract states what makes a match unambiguous and what makes it ambiguous, and it states **both
   failure axes with their asymmetry** *(Q-12)*: say→question degrades to today's behaviour (the feature
   does nothing), while question→say **writes a message the user never asked for** — so the ambiguity
   ceiling binds on the second axis.
5. **The fail-closed proof — including the adversarial corpus** *(SEC-02, SEC-07, Q-02, Q-03)*.
   Fixtures are **recorded, not authored**: capture the live session, record intent metadata
   **before** the classifier is written, store per-fixture provenance (session file, offset, utterance),
   and keep an **adversarial negatives set** — delegations containing injected text that reads as a
   note or a say, delegations echoing repo/web content, delegations that ask to be written — each
   asserted to resolve to a question. **The accuracy gate is [ADR-010](intent-gate-decision.md)'s** *(Q-03)*:
   **zero dangerous errors** — adversarial or ambiguous utterances written rather than answered — over the
   committed harvested corpus, with benign errors reported alongside and never traded against them.
   Per-file coverage is explicitly **not** the accuracy gate for this module — stated in
   `docs/delegation-intent.md`. The corpus is **harvested, never authored**
   (`spike/harvest-transcripts.mjs`: 21 cases × 3 runs, real ASR output, resumable) and scored by
   `spike/measure-intent-classifier.mjs`; together they are the regression test for any later change to
   the rule or the prompt.
6. **Instruction text for the two shapes**, as a hypothesis with its test, measured like the existing
   delegation brief was.

**Exit criteria — each falsifiable** *(Q-11)*:
- every cell in the **new** `docs/delegation-intent.md` table carries an observation or is struck;
   `protocol.md`'s four pre-existing ❓ cells are listed with an owner (resolved here or explicitly out
   of scope) *(K-12, R24)*;
- the manifest change lands and `pnpm declared-deps` stays green *(Q-07)*;
- the spike fixture exists and replays **keylessly** through `dsh-realtime-replay`;
- the adversarial corpus resolves to *question* on every negative, and the gate holds **zero dangerous
  errors** over the harvested corpus — **as recorded tests, not prose**, and re-runnable;
- the threat model exists as a file with the four elements above.

**No user checkpoint** — the only live step is the keyed spike, which is explicitly flagged and
separately costed *(F9, U-6)*.

---

## P2a — The two verbs land, with provenance

*Retires: "there is no way for the voice agent to write into the session".* **P2 splits** *(C-12, R17)*:
P2a is the capability; P2b is safety under retry and self-address. **The gate is settled before P2a starts
— [ADR-010](intent-gate-decision.md), measured:** a positional rule, with no model on the safety path.
P2a stories:

1. **Producer identity, on the corrected convention.** A **merge-added source kind** `realtime`,
   following the shipped pattern — `{ kind: 'plugin', plugin: 'realtime' }` if we follow `dsh-schedule`
   exactly, or a merge-added `kind: 'realtime'` as `agent-message` does — **decided and recorded in
   `docs/delegation-intent.md` at P1**, with the **verb in a kind-scoped field** (`source.verb`), never
   on the shared `form` union *(C-1, R1)*.
2. **Trust derived from the path** *(C-2, R2)*. `inject()` ⇒ note/untrusted; `followup()` ⇒
   say/attributed. No classifier output may set trust.
3. **Attribution stamped in the transport** — actor id, origin session, verb, all minted by the bridge
   at delivery; no model-supplied field may name any of them *(re-affirmed by all reviewers)*.
4. **The say's write path** — `ctx.agents.get(sessionId)` as the sessionId→Agent hop *(F6)*, then
   `agent.followup(sourcedUserMessage)`, then a **durable `realtime/change` session event written
   between the write and the flush** — schedule's exact ordering *(C-4, R3)* — then
   `ctx.sessions.flush()` and **require the acknowledgement**. Two failure arms stated separately
   *(F7)*: a **throw from followup** means nothing was written (safe to retry); a **false barrier**
   means written-but-not-durable — the retry consults the `realtime/change` record rather than blindly
   re-issuing.
5. **The note's lifecycle is bound to the inbox, not the log** *(C-3, R4)*. `inject()` returns `void`,
   is best-effort, may miss a claimed batch, and may be discarded. So the note's assertions ride
   `agent/inbox/inserted | claimed | discarded` — the real audit surface — and the plan states the
   semantics: **best-effort, nearest-later pre-step, discardable, pending while idle** *(R21)*. A
   never-admitted note must be reconstructable as never-applied *(K-04a)*. The idle-session semantic is
   decided here and recorded.
6. **The marker is a producer-authored framing line in content** *(C-10, R13)* — the in-tree convention
   (`agent-instructions`, `runtime-context`, `skill-catalog` all do it; **the voice already writes one
   today**, *"Relayed from the voice conversation…"*). Source is the durable structural provenance; the
   framing line is the model-facing provenance. Distinct templates per verb. Asserted on a **recorded
   request fixture** — the framing line is present in the bytes sent to the provider — and stated as
   **not an authentication mechanism** (the Claude Code `<system-reminder>` collision is the reason).
7. **Termination carries a bridge-minted reason from a closed enum** *(SEC-08)*. No model-supplied
   string is ever rendered as a reason; one test asserts a model-supplied reason field is ignored and
   replaced.
8. **`send(message, target, wakeup)` named as the one call site** *(F11)* — the two verbs are
   `send(msg,'next-step',false)` and `send(msg,'next-turn',true)`, so the fail-closed default and the
   wake decision are visible at one place.

**Exit criteria — replayed-log assertions, not prose** *(C-7, R5)*. **The plan's single
highest-leverage change is here: the gate learns to read a session log.** A new gate step replays a
recorded session log and asserts, per verb: `source` kind and kind-scoped verb correct; **no turn for a
note** (no `turn/start` attributable to it); **a turn for a say**; the framing line present in the
recorded request bytes; the `realtime/change` record present between write and barrier. A provenance
regression must **fail the build**. The human checkpoint remains: speak a request that makes the voice
both note and say, and see both in the log — a supplement, not the evidence.

---

## P2b — Safety under retry and self-address

1. **No-echo, correctly grounded** *(C-9, F6)*. The producer is not a DSH agent, so AutoGen's
   self-delivery guard does not apply; "self-addressed write refused" is redefined as: a write whose
   origin session equals the target session is refused with a journaled reason.
2. **The three non-semantic loop breakers** *(SEC-05, R11)* — per-session write rate limit,
   identical-body drop within a window, bounded pending-verb inbox — each refusing **with a reason
   string**, so the journal says why a write was dropped. Copied from Claude Code's cross-session
   contract rather than invented.
3. **Ordering: a per-session write queue** *(C-11, R12)*, mirroring `dsh-schedule`'s
   `runScheduleTransaction` per-agent tail chaining. Both verbs carry a monotonic sequence; the
   replayed-log gate asserts total order; behaviour when a note and a say arrive in one window is
   decided (a note may ride the say's turn — declared, not assumed).
4. **Idempotency on the request id carried in `source`** *(C-4, R3)*. The request id is
   **bridge-minted and unguessable**; a delegation-supplied id can never replace an existing message —
   one test proves an attacker-chosen id cannot.

**Exit criteria:** replayed-write fixture; a retry after a false barrier writes exactly once; a
self-addressed write is refused with a reason; the three breakers fire with reasons under fixture load;
gate green (including the new replayed-log step). **One user checkpoint** — speak a request that makes
the voice both note and say, then read the session log.

---

## P3 — The trust boundary, on both verbs

*Retires: the hazard that a write is obeyed, spoofed, or mistaken for the user. **P3 now covers the say
too** *(C-2, F5)* — the say is the higher-authority verb: it starts a turn the session's model acts on.*

**Stories.**
1. **A note is untrusted and carries content only — never directives** *(re-affirmed by Chen as the
   single most important correctness call in v1)*. Any instruction from **us** travels with **its own
   provenance and framing line** — never as an unattributed `kind:'user'` turn *(U-4, R14)*. That was
   v1's own self-contradiction: its fix recreated the defect it eliminated.
2. **The say is declared, not just rendered** *(K-01, C-2, R9, R10)*. The verbs are registered in the
   **ADR-009 settings registry** as a session-scoped capability, **default-off**, with the enabling
   decision journalled by key and landing **in the session log** — so the record shows when the voice
   was authorised to speak and by whom. Every say carries a non-suppressible statement of what it is
   **not**: *not user consent, cannot authorise a gated action, cannot change config.* One test asserts
   a say cannot satisfy an approval/request ask or mutate session settings. **The disable path is a P2b
   exit criterion** — a documented way to turn both verbs off mid-session, with a recorded event.
3. **The marker is visible to both halves** — model (framing line, P2a story 6) and human (transcript).
   Both assertions in tests. **Structural properties are machine-checked; adversarial obedience is
   measured, not proven** *(SEC-07, Q-05)*: a scored adversarial corpus with a stated pass bar, labelled
   as a measurement. No criterion claims to "prove" model behaviour.
4. **Capability is enforced at the bridge chokepoint, not on the message** *(SEC-03)*. The capability
   lives in the bridge's own record of the verb — **never read from the message body** — with a test
   that constructs a note whose source *claims* `canStartTurn: true` and asserts the receiver still
   calls `inject()` and never `followup()`. The fields on the message are for audit and rendering;
   **no code path may branch on them for authorisation.**
5. **Fail closed on the consumer side** — an invalid note is dropped **whole**, with a journal reason,
   never partially applied. Discards additionally land on the session-record surface via P2a story 5 so
   the record never shows context the model never saw *(K-04a)*.
6. **Do not imitate an unsigned system channel** — the Claude Code `<system-reminder>` incident stands
   as the cited precedent; the note must be structurally distinguishable from user text and from model
   text.

**Exit criteria:** the structural set (role, fence, marker on both paths, no-directive channel,
capability-not-branchable, drop-whole-with-reason) asserted as unit tests; the adversarial corpus
measured with its bar recorded; a say cannot satisfy an approval ask or change settings (tested);
default-off verified; gate green.

---

## P4a — The surface (independent of P2)

*Retires: the overlay.* **Split from P4b** *(F5, R18)*: P4a is the panel and is genuinely independent;
**P4b (say fidelity) depends on P2 and ships after P2b.**

**The market verdict is unanimous and it is against the overlay.** Every mainstream editor examined
ships voice as an **inline microphone / Voice Mode control inside the existing chat panel's input**, or
as a TTS reader of the panel's replies. **No studied product mounts voice as a `position:fixed`
overlay.** That is independent corroboration of the harness's own verdict (*"a drawer is not a column
and never squeezes the conversation"*).

**Stories.**
1. **The client build face, first and honestly costed** *(U-3, R19)*. **The risk v1 named was the wrong
   one.** Reachability is near-certain — services are provided by name and read off the plugin's own
   `ctx` (`ctx.reflect.provide('sidebarRightTabs', …)`; our face already receives `ctx`). The real cost
   is that a slot body is a **React component**, while `tsconfig.client.json` is `lib:['es2024'],
   types:[]` with **no JSX**, and the face renders HTML strings by design — **est. 20–32 h, the largest
   uncosted item in the plan.** First thing to break: the client build. Two `inject` declarations in two
   vocabularies, plus module-table-reachable requires. **Decide before writing code** whether the panel
   becomes a React component in the slot system or keeps rendering strings through a slot that accepts
   one — different work, different estimate. **Own exit criterion:** the artefact still registers a
   factory, still passes `client-artefact.mjs`, and compiles the chosen shape.
2. **The panel becomes a real panel** — register a `sidebarRightTabs` type at `priority: 'extension'`,
   open via `ctx.sidebarRight.openTab/openResource`. **Removing the strip is a whole-seam removal, not a
   style edit** *(F13)*: `stripMarkup` + `stripBootstrap` + the duplicated `STRIP_ELEMENT_ID` in both
   halves + the `GLOBAL_KEY` mount dance + `stripRows()`'s two body rows — est. 2–4 h, all under the
   100% per-file gate.
3. **A voice-authored message renders as itself** — actor identity plus a label attached **once per
   group** (Zendesk's redesign precedent), **non-suppressible** (Teams' precedent). The harness's
   `ContextProvenanceView` already renders an unknown source kind as the bare kind — a foreign kind
   stays visible rather than disappearing.
4. **Verbatim fidelity for identifiers** — a `say` that voices a file path, a test name or a flag must
   not silently corrupt it; Perplexity's `require_repeat_verbatim` is the shipped answer.

**Exit criteria:** the voice panel is a column the frame reserves room for; no fixed positioning remains
in the client half; the whole strip seam removed under the coverage gate; identifiers survive a round
trip verbatim; gate green. **One user checkpoint** — restart, speak, see the panel in its column.

---

## P4b — Say fidelity (after P2b)

1. **Interrupted-say fidelity, in the only checkable form** *(C-5, R6)*. The provider emits **no
   interruption event** (an existing test asserts the vocabulary has none), and playback is
   browser-side — so v1's criterion was unsatisfiable as written and mapped to the wrong package. The
   honest shape: a **new client→server control frame reporting played-bytes on barge-in**
   (`bridge.ts` already routes text frames), asserted in `realtime-audio-ws/tests/`, with a
   redaction-sweep row and a fault-matrix row for the new event. **Both** the wire text and the
   committed (played) text are recorded as distinct fields on the same durable row, with the barge-in
   that caused the difference — **never a deletion**, so the record stays reconstructable. The
   comparison unit is the committed-words set. **Gate step:** a replayed barge-in case asserts the
   split — able to fail the build.
2. **Symmetric fiction checks** *(K-04)*: a note is never recorded as a conversation turn (P2a story 5);
   a note logged-then-discarded is reconstructable as never-applied; plugin directives are never logged
   as an unattributed user turn (P3 story 1).

**Exit criteria:** the played-bytes frame exists and is gated; a replayed barge-in shows wire text ≠
committed text with both recorded; no fiction in either direction; gate green.

---

## Migration and the record's history

**Stated plainly, because it cannot be fixed** *(U-2, R22)*: every message this plugin has already
relayed is in the durable record as `{kind:'user', rpcId:'realtime-…'}` — **11 of 12** user rows on the
live log, discriminated only by a string prefix. That ambiguity is **permanent**: for any period before
this change, "was this authored by the human?" has no answer from the record. Documented in
[`session-messaging.md` §5](session-messaging.md). After the change there will be two markers; the rule
is **one choke point reads provenance** — the bridge's stamped source — and **no consumer re-derives it
from a string**. `rpcId` retains its prefix and is documented as an internal correlation id, advisory
only.

## Change control — the third irreversible act

A write into an append-only log cannot be un-written, so by this project's own definition the verbs add
a **third irreversible act** beside publication and the tarball *(U-5, R16)*. It gets a gate:

- **No `say` ships** unless the replayed-log gate step exists and the disable path is tested.
- **Version policy:** the new source kind and the control-frame event are additive contract changes —
  minor bumps in dependency order per `docs/releasing.md` §2, with the registry (not the tree) as the
  range check.
- **Rollback:** the P2b/P3 settings-registry switch is the kill switch; the previous version pin is
  documented in `docs/releasing.md`.
- **The Option C ruling is now citable:** ratified in this document's header, hash-pinned below.

## Cross-cutting

**Invariants this plan must not breach, and where each bites.**

| invariant | where it bites here |
|---|---|
| 1 · Fail-closed delegation | P1's classification: ambiguous → question, never a write |
| 2 · No hand-rolled VAD | untouched — the verbs ride the existing envelope |
| 3 · Credentials are a tested invariant | sentinel tests extend to the new fields, the framing lines and the `realtime/change` record; persistence for note and say stated under Change control, with retention policy deliberately deferred *(SEC-09)* |
| 5 · Drift canary | a spike that adds a wire observation updates `packages/realtime-openai/tests/fixtures/live-session.jsonl` **and the canary's literal event list**, and the scheduled canary is run before the sprint closes *(Q-13)* |
| 6 · Ack ≠ delivery | P4b — a `say` may only log what was played, and **both** forms are recorded |
| 7 · Interruption ≠ cancellation | a barge-in must not be assumed to have cancelled a dispatched write |
| 8 · No affordance the protocol cannot honour | the panel may not offer a control the write path cannot apply; `note` may not claim to start a turn; the settings registry refuses what the code cannot honour *(ADR-009)* |

**The invariant the table previously omitted** *(F7)*: **model-visible ⟺ logged**
(`docs/architecture.md:121`). The framing line lives **in the message content** — hence logged — not in
a prompt-build wrapper; a new model-visible input rides the existing `user/message` event via its
source, which is exactly the mechanism the harness's 2026-07-24 note specifies. Asserted by the
replayed-log gate.

**Definition of done, every sprint.** `pnpm gate` green (leak scan → build → declared-deps → typecheck →
`test:coverage` → `test:built`) **plus the new replayed-log step from P2a onward**; 100% per-file
coverage maintained, both growing; classification and verbs replay **keylessly** (ADR-003); a **real
installed copy** verified; CHANGELOG and version bumped in dependency order; profile verified free of
shadowed harness packages; lessons written into the `dsh-plugin-development` skill.

**ADR-008 governs the research's output.** No metadata file is minted for the provenance fields — *a
file nothing reads is not a contract*. The fields ride the event wire the replay backend already parses,
and the keyless-replay gate asserts them, or they do not ship.

**One or two user checkpoints per sprint, at the end.**

## Traceability

Re-derived for v2 *(C-8)*: one criterion, one file, in the package that owns that half. The write
path's home package is decided at P1 story 1; the table is re-derived then and **committed with the
plan** *(C-13)*.

| criterion | sprint | resolves to |
|---|---|---|
| ambiguous delegation → question | P1 | `packages/realtime-responder/tests/delegation-intent.spec.ts` |
| positive-rate floor + ambiguity ceiling pass | P1 | `packages/realtime-responder/tests/classifier-accuracy.spec.ts` |
| manifest change; declared-deps green | P1 | `packages/realtime-responder/package.json` + `scripts/declared-dependencies.mjs` |
| threat model exists | P1 | `docs/delegation-intent.md` §threat-model |
| a note starts no turn; a say starts one | P2a | `packages/realtime-responder/tests/turn.spec.ts` |
| framing line present in request bytes | P2a | `packages/realtime-openai/tests/request-framing.spec.ts` |
| write→record→barrier ordering | P2a | `packages/realtime-responder/tests/change-record.spec.ts` |
| retry after false barrier writes once | P2b | `packages/realtime-responder/tests/idempotency.spec.ts` |
| self-addressed write refused with reason | P2b | `packages/realtime-responder/tests/no-echo.spec.ts` |
| three breakers fire with reasons | P2b | `packages/realtime-responder/tests/rate-limit.spec.ts` |
| planted directive does not execute (structural half) | P3 | `packages/realtime-responder/tests/note-trust.spec.ts` |
| marker in render | P3/P4a | `packages/realtime-audio-ws/tests/marker.spec.ts` |
| say cannot satisfy an approval ask | P3 | `packages/realtime-responder/tests/say-authority.spec.ts` |
| default-off + disable path | P3 | `packages/realtime-responder/tests/settings-gate.spec.ts` |
| panel has no fixed positioning | P4a | `packages/realtime-audio-ws/tests/strip.spec.ts` |
| client build face compiles | P4a | `packages/realtime-audio-ws/tsconfig.client.json` + `scripts/client-artefact.mjs` |
| interrupted say: wire vs committed split, gated | P4b | `packages/realtime-audio-ws/tests/played-bytes.spec.ts` |

*(Corrections from v1: `no-echo` and `note-trust` stay in realtime-responder — the plan's own "bridge"
wording referred to the responder's write chokepoint, now stated explicitly; the truncation criterion
moves out of `realtime-agent`, which owns the model-facing tool set, not the speech path.)*

## Top risks

| risk | sprint that retires it | if it holds |
|---|---|---|
| The delegation envelope cannot express an intent, and instruction-based classification stays ambiguous | **P1** | **Resolved by [ADR-010](intent-gate-decision.md), measured.** The envelope cannot express intent, so the gate reads the utterance's *shape* instead: the authorising imperative at the head, everything else a question. Nine of nine model cells produced dangerous errors; the rule produced none. The `human-relay` class (0/9) remains a known, correctable cost |
| A note is obeyed as an instruction, or spoofs the user | **P3** | The incident class the market documents |
| **A say is read as user consent** | **P3** | The Claude Code fabricated-consent incident, on the verb that starts turns — mitigated by default-off + the not-consent marker |
| A say logs text the user never heard | **P4b** | Caught by the played-bytes gate step, not discovered by ear |
| The client build face costs more than 32 h | **P4a** | The panel stays an overlay until re-costed; P4b unaffected |
| Unbounded turn creation from a loop or an attacker | **P2b** | Bounded by the three breakers with reasons |
| Provenance fields get minted into a file nothing reads | cross-cutting | ADR-008 violated by the work citing it |
| Scope creep into the market's unclaimed cells | cross-cutting | This plan never closes |

## Deliberately not in this plan

| deferred | why | when it reopens |
|---|---|---|
| **Per-agent voice** | unshipped by the market including OpenAI's own dots; a UX tax, not a blocker | when two sessions must share one audio channel |
| **Floor-lock / voice-lock** | a copyable idea (Perplexity), but turn-taking UX, not a write path | P4a follow-on, if the panel shows a mode control |
| **`SILENT \| WHEN_IDLE \| INTERRUPTED` scheduling enum** | Gemini ships it for async output; our two verbs plus the journal already express the policy | if a third verb appears |
| **WebRTC transport · AudioWorklet capture** | scoped in `sprint-plan.md` S4's two "steals", at their stated triggers | unchanged — S4 |
| **A durable peer mailbox between two DSH sessions** | the mailbox exists in the app bundle (`dsh-experimental-agent-team`) but is **not composed in the desktop profile**, and DSH policy forbids depending on experimental packages from a published product | if two sessions must converse as peers |
| **Wake word** | Microsoft documents accidental activation and keeps it off by default; a shared office is the worst case | not planned |
| **Transcript retention/redaction policy** | confidentiality is governed by the existing leak-scan + sentinel extension; a full retention policy is a separate decision | when the journal's retention/export question is answered |
