# Delegation intent — the channel, the threat, and the contract

**P1 deliverable · 2026-10-15.** Answers the question this sprint exists to ask, records the threat
model, and states the classification contract. **Measured, not argued** — every claim below carries the
probe that produced it and an evidence file.

Probes: `spike/probe-delegation-channel.mjs` (parameters) · `spike/probe-client-vocabulary.mjs`
(event vocabulary). Evidence: `spike/evidence/delegation-channel-*.jsonl`,
`spike/evidence/client-vocabulary-*.jsonl`.

---

## 1. The channel — answered

### The instrument was checked before the answer was read

The reading below rests on `protocol.md`'s claim that the endpoint **rejects unknown fields**, which is
what makes a refusal a schema answer. That premise was itself untested in the version we run, so the
probe carried a **deliberately-bogus field** as a calibration:

| variant | outcome | the provider's words |
|---|---|---|
| **control** (the exact production payload) | ✅ **ACCEPTED** | `session.started` |
| **`session.__probe_definitely_unknown__`** | ❌ refused | `unknown_parameter` |
| `session.tools` | ❌ refused | `Unknown parameter: 'session.tools'.` |
| top-level `tools` | ❌ refused | `Unknown parameter: 'tools'.` |
| `session.delegation.tools` | ❌ refused | `Unknown parameter: 'session.delegation.tools'.` |
| `session.tools` + `tool_choice` | ❌ refused | `Unknown parameter: 'session.tools'.` |
| `session.delegation.intent_schema` | ❌ refused | `Unknown parameter: 'session.delegation.intent_schema'.` |

**Instrument: SOUND.** The control opened and a field that certainly does not exist was refused, so a
refusal is a schema answer rather than a flaky endpoint. *Had the bogus field been accepted, every
refusal above would have been unreadable — which is why the calibration is in the probe rather than in a
paragraph.*

### The vocabulary is closed, and the server enumerated it

Sent an unknown `type`, the endpoint does not return a generic error — it **lists everything it
accepts**. Twelve events, exhaustively:

```
'session.start', 'session.update', 'session.input_audio.append', 'session.input_audio.mute',
'session.input_audio.unmute', 'session.output_audio.fixture.play', 'session.instructions.append',
'session.thinking.append', 'session.commentary.append', 'response.item.create', 'response.create',
'session.close'
```

**This is not a list of spellings that worked. It is the endpoint's own answer**, which is a strictly
stronger instrument than guessing and observing — and it closes the question rather than narrowing it.

### The answer

- **There is no tool or function channel.** Four plausible spellings, each refused as `unknown_parameter`,
  against a schema proven closed.
- **There is no structured intent.** Not on the delegation, and not as an event in the twelve.

**So the verbs cannot be declared to the model and cannot be returned structurally. They must be
inferred client-side from the delegation's content, and the only lever is `instructions`.** That is not a
design preference — it is the endpoint's shape.

**v2's pre-committed yes-branch rule is retired rather than satisfied** (`sprint-plan-voice-presence.md`
P1 story 2): there is no tool channel to cap, so the spike cannot widen the plugin's authority. Recorded
here so the rule's absence is not later read as an oversight.

### A client event this repo never knew existed

`session.output_audio.fixture.play` appears in the server's enumeration and in **no note in this
repository**. It reads as *play output audio from a fixture* — a client-side path to the **voice's own
output channel**.

**Recorded, not relied upon:** its payload is unmeasured, its mode-gating is unmeasured, and it may be a
test affordance. Its relevance is direct and unclaimed — it is a candidate mechanism for a `say` that
must be spoken **verbatim** rather than paraphrased (R-P4a.4's identifier fidelity). **Claimed as a
follow-up probe, not as a capability**, and it must be measured before anything depends on it.

### The ❓ cells in `protocol.md`, dispositioned

| cell | disposition |
|---|---|
| `session.update` | ✅ **resolved** — exists; acknowledged `session.updated` |
| `session.input_audio.mute` / `.unmute` | ✅ **resolved** — exist; acknowledged `session.input_audio.muted` / `.unmuted` |
| `session.close` | ✅ **resolved** — exists; acknowledged `session.closed` |
| responses delegation **mode** | **out of scope, owned by ADR-001.** The *event names* (`response.create`, `response.item.create`) are valid — the enumeration proves that — but the **mode** is what refuses them under client delegation. The mode's behaviour is a separate question and is not reopened here |

---

## 2. Threat model and trust boundaries

**Assets.** (a) the integrity of the durable session log; (b) the agent's tool authority — anything the
session can execute; (c) the credential; (d) the user-consent record.

**Boundaries, in the order a frame crosses them:**

```
microphone ─▶ ASR/provider ─▶ delegation (id, offset_ms — NO TEXT) ─▶ [CLASSIFIER] ─▶ bridge ─▶ Agent inbox ─▶ session
                                          ▲                                ▲
                              untrusted: it is the model's output   the trust decision lives here
```

**Adversaries, and what each can actually reach.**

| adversary | reach | the control that bites |
|---|---|---|
| **untrusted content the coding session reads** (a repo file, a fetched page, tool output) | it reaches the delegated *answer*, the voice model reads it, and the model can then emit a delegation shaped as a write | **the classifier's fail-closed rule + the positive-rate floor** — an injected write must classify as a *question* |
| **a confused (not hostile) voice model** | mis-shaped delegation | the same rule; this is the ordinary case |
| **a network attacker on the local WS route** | frame injection into the plugin's own transport | the existing capability token + connection-service verdict; **unchanged by this plan, and it must be re-asserted for the write path** |
| **the model itself, as author of its own provenance** | it can try to name its actor, its session, or its verb | **attribution is stamped by the bridge at delivery, from code** — no model-supplied field may name any of them |

**The trust decision is a single point, and that is the point.** The classifier decides *whether* a
write happens. It cannot decide *what kind of write it is credited with* — that is the delivery path
(`inject()` ⇒ note/untrusted; `followup()` ⇒ say/attributed). One place to get right, one place to test.

**A boundary that must be stated because the note sits on it:** `agent.inject` places content on the
**user role** — the highest-authority channel in the transcript — and a note that lands immediately
before the agent's next tool decision is the strongest injection position available. Hence P3's
content-only rule and the untrusted framing line; both are load-bearing, neither is decoration.

---

## 3. The classification contract

A **decision procedure**, not a heuristic description. Three outcomes; the third is the default.

### The rule

```
1. If the delegation has no content-bearing transcript span    → QUESTION   (answer it — today's behaviour)
2. If it matches the WRITE-NOTE shape unambiguously            → NOTE
3. If it matches the WRITE-SAY shape unambiguously              → SAY
4. Otherwise                                                   → QUESTION   ← FAIL CLOSED
```

**Rule 4 is the whole safety argument.** There is no "probably a write" outcome and no confidence
threshold that admits a write. Ambiguity resolves *downward*, to the behaviour that exists today.

### The two failure axes are asymmetric, and the contract says so

| axis | what happens | cost |
|---|---|---|
| **say → question** | the write silently does not happen; the delegation is answered instead | the feature does nothing. **A capability loss.** |
| **question → say** | a message the user never asked for is written into their session, attributed to the voice | **a false record and an unrequested turn.** The dangerous direction. |

So fail-closed covers the dangerous axis and **nothing covers the other one** — which is exactly why the
probe suite needs a **positive-rate floor** (§4) and not only a fail-closed assertion. *A classifier that
returns QUESTION for everything is 100% covered, fails nothing, and ships a feature that does nothing.*

### Disposition owner

The contract is a judgement, and a judgement gating four sprints carries a name. **Owner: the
maintainer.** Any change to the rule above is a recorded decision, not an edit — the way
`plan-review-adjudication.md` dispositions every review finding.

### What the contract must NOT be

Not a confidence threshold on model output, and not a sentence in `instructions` alone. Given §1, the
`instructions` text is the only *lever* on the model's phrasing — but the *decision* must live in code
that can be read, tested and failed. An instruction is a request; the classifier is the gate.

---

## 4. What P1 has NOT answered, and the next live step

**The spike answered the schema. It did not answer behaviour**, and the difference matters:

- **Does instruction text actually produce a distinguishable shape?** Unmeasured. This needs audio — a
  live session, an utterance, and the delegation it produces. The *precedent* is that instructions do
  steer this (the shipped delegation brief changed behaviour measurably: no delegation at all → delegated
  correctly), but precedent is not measurement.
- **The corpus.** Fixtures must be **recorded, not authored**: capture the live session, record intent
  metadata **before** the classifier exists, keep per-fixture provenance, and include an **adversarial
  negatives set** (delegations carrying injected text that reads as a write, delegations echoing repo or
  web content, delegations that *ask* to be written) — each asserted to resolve to a QUESTION.
- **The positive-rate floor and the ambiguity ceiling**, pre-registered and enforced by that corpus.

**Next live spend, named:** one keyed session carrying a small set of scripted utterances — one plainly a
question, one plainly a note, one plainly a say, one deliberately ambiguous, one carrying injected text.
Recorded to a fixture, replayed keylessly thereafter. **Nothing downstream should be built until that
corpus exists**, because until it does, "the classifier works" is an assertion with no instrument behind
it — which is precisely the defect this project's own history keeps producing.

---

## 5. Companion change — the runtime dependency gate

P1 story 1's open item, recorded here so it is not lost: using a harness package at **runtime**
(`createUserMessage` from `dsh-llm/message`, the Agent from `sessionController.resolveAgent`) trips
`pnpm declared-deps`, whose declared set is `dependencies + optionalDependencies + peerDependencies` and
**not** `devDependencies`. `dsh-api-session-controller` is currently a *devDependency* of
`realtime-responder`. **The manifest change is required for P2a, and `pnpm declared-deps` is the gate
that will demand it** — so it is a named consequence, not a surprise.
