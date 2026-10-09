# Steering: which session the voice talks to, and why a pinned id rots

This documents a real failure found in the running app, the prior art for fixing it, and the design. It exists
because the failure was **silent**: the plugin was healthy, the sessions were healthy, and the voice answered
into a conversation the user had left.

## The failure, with its evidence

The profile's patch layer pinned one session:

```yaml
- id: dsh-realtime-responder
  config:
    sessionId: session-ea70184a-6ed5-4eb7-b907-548ffd8b48f5
```

The app creates a **new session on restart**. Two sessions were on disk, and the pinned one was not the live one:

| session | last written | what it was |
|---|---|---|
| `session-ea70184a-…` — the pin | 21:03 | where all the earlier work happened |
| `session-61da0ed8-…` — the live one | 21:42:53 | created at the 21:42 app restart |

The decisive observation: **no session log anywhere was written after 21:42:53**, and the voice attempt was
after that. A delegated turn writes its log. So no turn ran, in any session — the delegation was admitted
against a session the app had moved on from.

Worse, the *symptom was a lie*: asked what happened, the voice model answered *"I wasn't able to retrieve that
Git log. Something failed on my side when I tried to access it."* No tool call had run, because no turn had
run. That was the model improvising an explanation for a silence. Treated as data it sends a reader to debug
`git`.

Three defects, and only the first is the one people notice:

1. **A pinned id rots.** The app's session changes; the pin cannot know.
2. **The failure is silent.** Nothing in the journal, the strip, or the ear said "the session you are steering
   is not open".
3. **A silent failure is then narrated as a technical excuse by the model**, which is worse than silence,
   because it is confidently wrong.

## Prior art: how Codex addresses a conversation

Researched rather than guessed, because this is a solved-shaped problem. `codex app-server` is the interface
the Codex CLI, the VS Code extension and the macOS app all share, and its model is worth copying almost
directly — [README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),
[OpenAI's own write-up](https://openai.com/index/unlocking-the-codex-harness/).

**Threads are created by the client, and the client keeps the id.** `thread/start` opens a conversation and
**returns the thread object**; the client records that id and calls `thread/resume` with it later. There is no
global "current thread" that a sidecar guesses at — the party that knows which conversation is on screen is the
party that holds the id.

**The subscription is bound at creation, not configured.** `thread/start` "emits `thread/started` … and
**auto-subscribes you to turn/item events for that thread**". The binding follows the conversation rather than
being pinned in a config file and hoped for — which is precisely the difference between our design and theirs.

**Discovery is offered, but never as the authority.** There is a picker (`codex resume`, `--resume <id|latest>`)
and an index over `~/.codex/sessions/**/rollout-*.jsonl`, ordered newest-first **by the timestamp in the
filename, not by mtime** — and `thread/list` is **scoped to the current cwd**. So the list exists to *offer*
choices, not to silently decide.

**And "just take the newest" is a documented anti-pattern.** From
[openai/codex#3817](https://github.com/openai/codex/issues/3817):

> My workaround for now is getting the latest session id from the `~/.codex/sessions` directory, but my
> application lets you run multiple prompts in rapid succession so this is not reliable.

The sanctioned fix upstream was not a cleverer search — it was for the API to **return the thread id**
(`codex exec --experimental-json` returns `thread_id`). That is the design lesson: make the id **travel with
the conversation**, do not re-derive it.

## The harness already has every primitive we need

`SessionController` (`packages/api/session-controller`) exposes more than the pin we were using:

| primitive | what it gives | what it fixes here |
|---|---|---|
| `control(signal)` → `AsyncIterable<SessionControlFrame>` | "a complete live-control **baseline followed by replacement frames**" | the live binding: which session the app is actually on, streamed, not pinned |
| `list(request, signal)` | "visible Session summaries **ordered by activity**" | the honest picker source, from the harness rather than from our own guess |
| `inspect(sessionId)` | "inspect one **attached or persisted** Session without activating its Agent" | detects a stale pin: persisted ≠ attached |
| `resolveAgent(sessionId)` | the live Agent, "or the stable Session-domain failure" | explicit failure instead of a mysterious timeout |
| `prompt(request, signal)`, with exported `ApiSessionNotFound` | a named error for the stale case | the reason becomes speakable |

And the lifecycle events exist too: **`session/created`**, `session/disposed`, **`session/not-found`**. So the
harness already announces exactly what went wrong; we were simply not listening.

## The design

**Principle: the id travels with the conversation; the plugin never owns it and never guesses it.**

1. **Default to the live binding.** Follow `control()` — the app's own live-control state — and treat that as
   the target session. This is Codex's auto-subscribe, in our vocabulary. The pinned `sessionId` becomes an
   *override* for steering deliberately, not the default.
2. **Resolve, do not assume.** Before admitting a delegation, `inspect()` the target. `persisted` but not
   `attached` means the pin is stale, and that is a *speakable* fact.
3. **Never fail silently, and never let the model narrate a silence.** If there is no target session — or the
   configured one is not attached — the responder must say so in its own words, out loud, naming the session.
   The model must not be left to improvise an explanation; nothing in this path should let it.
4. **Ask rather than guess when ambiguous.** If several sessions are viable, that is a picker question. `list()`
   ordered by activity is the source; picking the head silently is the anti-pattern upstream documented.
5. **Make the staleness visible before it bites.** The strip already renders this field. It should show the
   session's *state* — attached, stale, or unknown — not just its id, so the rot is visible without a log
   archaeology session.

## First slice

1. **Speak the failure.** Catch `ApiSessionNotFound` (and the `inspect()`-detected stale case) in the responder
   and emit a spoken, configured sentence naming the session. Small, and it converts the whole class from
   silent to diagnosable.
2. **Follow the live control state** as the default target, with the configured id as an override.
3. **Show the state in the strip** next to the id.
4. **A test per case**, because each of the three defects above fails differently: a stale pin, no session, and
   several candidates.

Step 1 alone would have turned a two-hour investigation into one sentence at the moment it happened, which is
the entire argument for doing it first.
