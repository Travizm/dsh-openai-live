# Control plane: which fields can change while it runs

S2's design gate (Q10). Before building any UI that changes a setting, decide — from the protocol and
the code, not from taste — which settings can change *while a session is open*. `design.md` invariant 8
is the rule: **`model`, `instructions` and `audio.output.voice` cannot change after `session.start`,
and the delegation mode cannot change without a new session. The design must not offer a UI affordance
the protocol cannot honour.** An affordance that silently does nothing is worse than no affordance: it
teaches the user that the plugin is broken.

## The three classes

**Session-bound — changing one requires a new session, so the UI must say "reconnect".**
These travel in the provider's `session.start`. The adapter builds that frame once
(`realtime-openai/src/adapter.ts`: `sessionStart(target.model, target.instructions, target.voice)`) and
nothing afterwards can alter what the provider already accepted.

| field | plugin | why frozen |
|---|---|---|
| `provider` | agent | it selects which *adapter* opens the session; the session object is that adapter's |
| `model` | agent | in `session.start` |
| `voice` | agent | in `session.start` |
| `instructions` | agent | in `session.start` |

**Live — changing one costs a message, and that is the whole point of the control plane.**
These are read at the moment they are used, so a running plugin can pick up a new value without a
restart. The first row is the one that cost two restarts and a false lead: *which session the voice
steers* was a boot-time constant.

| field | plugin | read at |
|---|---|---|
| `sessionId` | responder | every admission — the session the answer is injected into |
| `delegationTimeoutMs` | agent | every delegation |
| `answerTimeoutMs` | responder | every turn |
| `maxPromptChars` | responder | every turn |
| `maxTranscriptChars` | agent | every delegation |
| `redactSecrets` | responder | every emission |
| `autoStart` | agent | the next start, not this one |
| `openSessionOnConnect` | audio | the next connect, not this one |

**Restart-bound — a route registration or a server limit. No UI control at all.**
`path`, `maxFrameBytes`, `maxConnections`, `diagnosticsPath`. These are claimed once against the web
server's registry or enforced by the socket itself. Offering a control for one would be the affordance
invariant 8 forbids, so the strip shows them read-only at most.

## What this means for the strip (S2 stories 3-4)

- **Live fields get controls.** A session picker for `sessionId` is the headline: it is the field whose
  immutability actually hurt.
- **Session-bound fields get a reconnect action, not a control.** Editing `model` or `voice` sets a
  *pending* value and the button reads "Reconnect to apply", so the user is told what will happen
  rather than being lied to by an instant-looking control.
- **Restart-bound fields get neither.**
- **Every change reports its outcome.** `set` on a frozen field is **refused with a reason** on the
  same channel — never silently ignored. That is the same rule the journal follows one layer down.

## Open question, to be closed by S4's second adapter

This classification is derived from **one** provider's protocol plus our own code. The `provider` field
being session-bound is an artefact of the adapter-per-route design; whether `model` and `voice` are
universally frozen at session start is exactly the kind of thing an independently designed API may
answer differently. The matrix above is therefore a *bet*, and S4's spike is what settles it. If a second
provider allows a live voice change, this document changes — and the strip gains a control rather than
losing one.
