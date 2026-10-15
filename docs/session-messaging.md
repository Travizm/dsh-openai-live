# Session-to-session messaging — what the spine has, and what it does not

Written 2026-10-14 against the **running app 0.2.0-rc.2**, the local harness checkout
`~/dev/deepseek-harness` (`@deepseek-ai/dsh-root` 0.1.5-rc.2), and the live journal
`~/.dsh/realtime-journal.jsonl` (13,343 rows, 2026-10-10 06:56 → 2026-10-14 19:48).

Two comments from Travis prompted this, and the third section answers the question they raise:

1. the GUI is terrible;
2. there is no way for the voice agent to write into the session — we need a session-to-session
   messaging protocol.

**Answer in one line.** The *primitives* exist in the spine, and what is missing is smaller than the
plugin's behaviour suggests — but the *protocol* exists only in two narrow in-tree forms, and neither
admits a voice session addressing an arbitrary chat session. What is actually absent is one thing: a
**producer identity for the voice**. Today the only way to write into a session is
`sessionController.prompt()`, which hard-codes `source: { kind: 'user' }`.

---

## 1. The journal, reviewed

Ten socket runs across five days. All-time: **9 of 12 delegations answered**, p50 latency **11 s**,
max **82 s**.

| run | window | delegations | outcome |
|---|---|---|---|
| 1 | 10-10 06:56 → 07:19 | 1 | `prompt.refused` — missing signal |
| 2–3 | 10-10 07:20 → 07:22 | 0 | socket only |
| 4 | 10-10 08:41 → 09:15 | 0 | 2 × `session.failed` (provider) |
| 5 | 10-10 09:15 → 10:11 | 2 | both answered |
| 6 | 10-10 10:11 → 17:19 | 1 | answered |
| 7 | 10-10 17:19 → 10-11 06:01 | 2 | **both `window.elapsed`** |
| 8 | 10-11 06:02 → 07:06 | 1 | **`window.elapsed`** |
| 9 | 10-11 07:07 → 10-13 07:12 | 5 | **all answered** (2 s, 12 s, 8 s, 40 s, 82 s) |
| 10 | **10-14 19:42 → 19:48** | 4 | **all answered** (11 s, 7 s, 12 s, 4 s) |

**The relay works, and it has worked since 0.6.9.** Every unanswered delegation sits in runs 7–8
(10–11 Oct) and every one ends in `window.elapsed` — the turn-latch and answer-window defects, before
responder 0.2.8. **There has been no unanswered delegation since.** Today's run answered four of four in
under twelve seconds each.

**The 180 s budget is confirmed live, not assumed.** `config.resolved` at 2026-10-11 07:06:51 reports
`delegationTimeoutMs: 180000` on both the agent and the responder. The earlier `45000` entries are the
history the change was measured against.

**`prompt.refused` fired exactly once**, 2026-10-10 06:57:24:

```
{"kind":"prompt.refused","detail":{"id":"item_EXBwaQZT0uvz1HVAUUxkb",
 "reason":"Cannot read properties of undefined (reading 'throwIfAborted')"}}
```

That is the missing-signal bug: the responder called `prompt(request)` with one argument, and the
controller reads `signal.throwIfAborted()` *before* it considers the request. It is fixed, and the
responder's own source now carries the paragraph explaining it. Worth noting **how** it was found — the
journal ran the code a hand-written structural type could not disagree with.

**`session.failed` ×3**, all on 10 Oct, all `class: RealtimeError`, all provider-level.

### Three findings from the review itself

**1. The journal cannot answer "what was said".** It records 12,255 `speech.sent` carrying `bytes`, 864
`transcript.input` carrying `chars` and `final`, and delegation events carrying `id`, `offsetMs` and
`chars`. There is **no text anywhere in it**. A wrong spoken answer is therefore undiagnosable from the
journal — you have to leave it and go to session logs, which is exactly the archaeology the journal
exists to prevent. Either the transcript becomes maskable-and-recorded, or the journal's own docs should
say plainly that it is a ledger of *events*, not of *content*.

**2. The steering pin has outlived several restarts and is still there.** Every boot from 10 Oct 18:21
through 13 Oct resolves `sessionId: session-ee033ab7-9741-43b0-a9db-277f076e9171` — one id, unrotated,
in the profile's patch layer. `docs/steering.md`'s first slice ("follow the live control state; treat the
configured id as an override") is **not implemented**. The relay currently survives the pin only because
that session still happens to resolve. This is the stale-pin class, still open.

**3. The strip's `steer` verb works.** `config.changed key=realtime-responder.sessionId` appears four
times across the window, which is a live re-steer from the panel without a restart. The one control the
GUI does well, it does well.

### Version skew to reconcile

| package | installed (`~/.dsh/profiles/desktop`) | repo |
|---|---|---|
| `dsh-openai-live` | 0.6.10 | **0.6.11** |
| `dsh-realtime-audio-ws` | 0.2.7 | **0.2.8** |
| `dsh-realtime-responder` | 0.2.8 | 0.2.9 |
| `dsh-realtime-agent` | 0.2.12 | 0.2.13 |

Also: the installed `dsh-realtime-audio-ws` resolves config with `openSessionOnConnect: true`, a field
the repo's `cordis.patch.yml` does not set. Worth reading the installed schema before the next install.

---

## 2. Comment 1 — the GUI is terrible

It is, and it is fixable in a specific way rather than a matter of taste.

**Where it comes from.** `packages/realtime-audio-ws/src/strip.ts:52-62` mints one raw HTML row:

```
position:fixed; right:12px; bottom:12px; z-index:40; ...
```

injected through the `webserver/index-inject` `html` row. It is an **overlay**, and the file says so:
*"This panel sits over the host's own text."* The opaque background was itself a correction after a
screenshot showed the translucent version superimposing two unreadable texts.

**The spine ships the surface it should be using — and explicitly rejected the overlay.** From
`.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.md`:

> The right column is a per-session docking surface — split panes, tabs, floating panels, and an
> undoable operation sequence — owned by `ui-sidebar-right` over the `ui-dockkit` engine, replacing the
> Detail panel.

Its rejected alternatives include *"A drawer over `shell.overlay`"*: **"a drawer is not a column and
never squeezes the conversation."** That is the category our panel is in.

**The plugin extension point is a registration, not a stylesheet.** From
`.agents/notes/implemented/architecture/2026-09-05-sidebar-tab-types-and-navigation.md`:

| face | contract |
|---|---|
| `ctx.sidebarRightTabs.register(definition)` | a tab **type**: `{ id, kind, patterns?, priority?, canOpen?, title }`; returns the disposer the plugin holds in its own `ctx.effect` |
| keyed slots `sidebar.right.pane.tab` / `.title` | the body and the chip, registered under the type's own `id` |
| `ctx.sidebarRight.openTab(kind, …)` / `openResource(address, …)` | how a caller asks the Sidebar to show something |
| `useTabInfo()` | `{ sidebar, panel, tab }` — record, navigation, visibility, abort signal, bound actions |
| `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar()` | the panel seat the frame reserves room for |

`priority: 'extension'` **outranks every builtin**, so a type shipped from outside the product wins
without touching it. The registry is deliberately a plain object without `Service.tracker` precisely so
a cross-package `register()` adds its effect to the *caller's* fiber.

**The real cost, stated rather than glossed.** Our client half is deliberately one file with no imports
(`src/client/index.ts:8-15`, `96-104`): a client face is served as a single resource, so any relative
value import emits a second file the loader never serves. Registering a tab type means reaching the
client context's service face and the slot system — a different client-face shape from the one we built,
and the `import`s we currently avoid would have to be reconciled with the module table. That is a real
slice of work, not a copy-paste. It is also the difference between a floating box over the transcript
and a panel the harness makes room for.

---

## 3. Comment 2 — "no way for the voice agent to write into the session"

**Stated precisely, because the distinction decides the fix:** the voice *can* write. The responder does
it on every delegation. It can only write **as the user**, and it can only write to *cause a turn and
read the answer*.

**The reason is one hard-coded line.** `SessionController.prompt()` in the spine builds the durable
attribution unconditionally — `dsh-api-session-controller/lib/types/commands.js`:

```js
const source = { kind: 'user', rpcId: request.requestId, ...(clientTimeZone ...) }
const message = createUserMessage({ content, source })
if (request.mode === 'steer') agent.steer(message)
else agent.followup(message)
```

There is **no field on the request for a producer**. Our responder (`dsh-realtime-responder` 0.2.8,
`lib/index.js:346-351`) calls exactly that with `mode: 'queue'`. So every voice-originated prompt lands in
the session log as a *user* message with a *user* rpcId — indistinguishable from Travis typing.

### What the spine provides instead

| primitive | where | what it gives |
|---|---|---|
| `agent.inject(message: UserMessage): void` | `packages/core/agent` runtime types (**public**) | model-facing context inserted with **no waking turn**; commits `agent/inbox/spliced` |
| `agent.followup(msg)` / `agent.steer(msg)` | `packages/core/agent` | `next-turn` (a distinct turn) vs `next-step` (steer the nearest step) |
| `MessageSourceMap` | `dsh-llm`, **merge-extensible** | a producer declares its **own** source kind and its own fields; transcript, UI policy and replay distinguish by `source` |
| `ctx.sessions.flush(session)` | `dsh-schedule` precedent | require a durability acknowledgement before reporting success |

**The design note that settles the semantics** is
`.agents/notes/implemented/architecture/2026-07-24-separate-context-injection-from-turn-execution.md`:

> `inject()` is the only caller-facing operation for supplementary model-facing input, and a turn means
> one execution of the model loop. A caller that owns context delivers an identified, frozen
> `UserMessage` through `inject()` and submits the direct message independently with `followup()` or
> `steer()`. … Every additional context is an independent `UserMessage` whose `source` names its producer
> and carries producer-specific fields. … Transcript and UI consumers distinguish direct user messages
> from injected context by `source`.

**And there is a shipped precedent for exactly the write we want.** `dsh-schedule` (reminders) does it
in this order — and the order is the part that matters, because the middle step is what makes a retry
safe rather than duplicating a turn (verified against the installed package,
`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-schedule/lib/index.js:930-965`):

```js
const message = createUserMessage({ content: [...], source: { kind: "plugin", plugin: "schedule" } })
this.agent.followup(message)                       // the write
this.agent.session.append("schedule/change", {     // a durable record OF the write, before the barrier
  version: 1, operation: "dispatch", id: ... })
if (!await ctx.sessions.flush(session)) throw new SchedulePersistenceError()   // the durability barrier
```

**Correction — this section previously got the source shape wrong, and the error propagated.** An
earlier version of this document claimed `MessageSourceMap` "already reserves
`schedule: { kind: 'schedule' } & ContextFormed`". Re-verified against the **installed** harness, that is
false in two ways:

- The base map declares **four** kinds, not a reserved roster —
  `dsh-llm/lib/types/message.d.ts:94`: `{ user, plugin: {kind:'plugin'; plugin:string} & ContextFormed,
  model, tool }`. Kinds such as `agent-message`, `session-reference` and `schedule` are **merge-added by
  other packages**, not reserved by the base.
- `dsh-schedule` does **not** write `{kind:'schedule'}`. It writes the generic **`plugin`** kind with a
  discriminator — `{ kind: "plugin", plugin: "schedule" }` — which is the convention an out-of-tree
  producer should copy.

Where the false string came from, because it is a trap: it *does* appear, in the app's **merged typert
catalogue** (`app.asar` → `dsh-llm/lib/typert.host.js`), a generated merge of every package's
declaration-merged additions across the whole composition. **A merged declaration catalogue is not the
declaration site** — reading one as the other is how this error was made and then cited. (Found by the
2026-10-15 adversarial chamber: Haggai F2, Karen K-05, Rusty F3, independently.)

**A plugin writing into a session as itself — durably, without impersonating the user — is a sanctioned
in-box pattern.** The voice needs the same shape and its own producer identity; nothing about it needs
inventing. But the identity rides a **kind-scoped field**, never the shared `form` union: `form` is
documented as a *semantic* axis (*"never visual… colors, icons, ordering… must not enter this union"*,
`message.d.ts:28-41`) and its `relay` value means *"a message another agent addressed to this one"* —
neither is a note/say distinction.

---

## 4. What the spine does *not* have

**No general session↔session bus.** `a2a`, `agent2agent` and `agent-to-agent` return nothing across the
harness `packages/` and `docs/`. There are exactly two narrow protocols, and a third cross-session
surface that is deliberately not one.

### 4a. Adjacent-agent messaging — non-experimental, but tree-edge only

`send_message({ agent_id, message })` and `interrupt_agent`, in `dsh-tool-subagent-control`. The contract
is in the tool's own description:

> The agent id of your **direct continuable child**, or your **direct parent** when you are a resident
> continuable child.

`SubagentService.sendMessage` enforces it (`dsh-subagent/lib/types/continuation.js:193-212`) — anything
else throws `UNAUTHORIZED`. The tool is marked with the process-stable symbol
`dsh.subagent.adjacentAgentSendMessageTool` so the host knows which `send_message` it is holding.
Delivery lands in the recipient's Agent inbox as a sourced message — `kind: 'agent-message'`,
`form: 'relay'`, `senderSessionId` (`dsh-subagent/lib/types/continuation-messages.js`). Host-authored
delivery has the same fence: `queuePrompt` / `steerPrompt` are both parent → direct child.

**A tree-edge relay, not a bus — and the voice session is not in that tree.**

### 4b. Agent Teams mailbox — a real protocol, but experimental and team-scoped

`@deepseek-ai/dsh-experimental-agent-team` carries a **`TeamMailbox`** (`lib/types/mailbox.js`,
`session-message.js`): durable peer messages with a minted `TeamMessageId`, a `team-message` source kind,
target-local dispatch, **delivery checkpointing and acknowledgement** against the Lead's log, per-member
pending-message caps, message byte caps, and recovery for members that restart — plus a shared task board
and `spawn_teammate` / `list_agents` / `send_message` / `wait_agent` on the tool side.

This is the session-to-session messaging protocol, and it is the design to copy if we ever want two DSH
sessions conversing as peers. Its limits are structural:

- **opt-in and team-scoped** — only members a Lead spawned participate;
- shipped under `packages/experimental/`, where the harness's own policy is that *"released products
  outside this group must not depend on experimental packages"*;
- **not composed in the `desktop` profile** — absent from `dsh.profile.bundles`, and `dsh-base` does not
  mount it.

### 4c. Cross-session references — read-only, on purpose

`ctx.sessionReferenceResolver` turns an `@`-mention of another session into a bounded, read-only,
untrusted snapshot injected as a separate sourced `user/message`
(`.agents/notes/archived/feature/2026-07-21-cross-session-references.md`). Its rejected alternatives
include *"Resume or fork the source — the feature supplies read-only background for one target message,
not identity or lifecycle continuity."* Useful as **evidence** for what crosses, not as a channel.

---

## 5. The answer, and the first slice

> **Limitation to state plainly, not discover later (added 2026-10-15).** Every message this plugin has
> **already** relayed is in the durable session record as `source: {kind:'user', rpcId:'realtime-…'}`.
> Measured on the live log: **11 of 12** `user/message` rows carry that source, and the twelfth is the
> human's. Structurally the kind is identical to a human turn; the only discriminator is a **string
> prefix on an internal correlation id**. That ambiguity is **permanent and not retroactively
> fixable** — for any period before the fix, an auditor asking "was this authored by the human?" has no
> answer from the record. Relying on that prefix is the same field-vs-name trap the research documents
> (GitHub's `dependabot[bot]` filter, which silently matched nothing against GraphQL's bare `dependabot`
> + `__typename: Bot`). After the fix there would be **two** markers with no rule for which is
> authoritative — so the fix must state a single choke point that reads provenance, and no consumer may
> re-derive it from a string. *(Found by Karen, chamber finding K-09.)*

**Does support exist in the spine?** For the primitives, yes — `inject()`, the two-destination inbox,
`followup`/`steer`, and a merge-extensible source map. For a *protocol*, only in the two forms above, and
neither one admits a voice session addressing an arbitrary chat session. **The one thing genuinely absent
is a producer identity for the voice.**

So the work is **not** "build a messaging protocol". It is:

1. **A source kind for the voice.** Declare `realtime` (or `voice`) on `MessageSourceMap` in the seam's
   own terms and have the responder write with it — `inject()` for context that must not wake the
   session, `followup()`/`steer()` for content that must — then `ctx.sessions.flush()` and require the
   acknowledgement. `dsh-schedule` is the reference implementation. This is what turns "the voice
   prompted me as if I had typed it" into "the voice said something".
2. **A read path the voice can use without a turn.** The delegation path already works; `inject()` is the
   complement, and it is what makes the voice a participant rather than an oracle.
3. **Then decide about the GUI**, which is an independent slice: register a `sidebarRightTabs` type at
   `priority: 'extension'` and delete `stripMarkup()`'s fixed positioning. The unknown to resolve first is
   how much of the slot/service face a no-import single-file client face can reach.
4. **Only if two DSH sessions must converse as peers** is a protocol build actually required — and the
   answer there is to read the Agent Teams mailbox design, not to invent a second one.

**The honest gap, which the next slice must probe before anything is designed on top of it:** whether an
out-of-tree plugin composing with the seam can reach `agent.inject()` and `createUserMessage()` from a
consumer row, or whether that requires a provider seam the harness owns. `agent.inject` is on the runtime
type and `createUserMessage` is `dsh-llm`'s, so both are reachable *inside* the tree — reachability from a
`dsh plugin add`-installed package is the assumption to test, not a fact to build on. **Probe that first;
it decides the size of everything after it.**

---

## Related

- `docs/steering.md` — the pin that rots, and the `SessionController` primitives it catalogues; its first
  slice is still unbuilt (§1 finding 2).
- `docs/usable-window.md` — why silent captures ship.
- `voice-build-review-and-a2a.md` (in the harness checkout) — a **different** question: cross-*harness*
  A2A between hermes, DSH and Buzz over ACP / MCP / JSON-RPC / webhook. Its versions are stale
  (voice 0.1.2, checkout 0.1.5-rc.2 against installed 0.6.10 / app 0.2.0-rc.2), but its option table is
  still the best starting point for that line.
