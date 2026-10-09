# Diagnostics: what to record, and what each recording would answer

Written to scope the next build cycle, whose only job is to answer **"why are tool calls failing?"** — and to
answer it from recorded evidence rather than from a hypothesis. Every claim below is marked as proven or open,
because the last round's most expensive mistake was treating a tidy story as a finding.

## What already exists, and is better than it looks

| instrument | what it gives | cost |
|---|---|---|
| the seam journal, served at `/dsh-realtime/diagnostics` | every seam event in order, redacted, plus `config.resolved` — the configuration as applied | free |
| the same journal's route token | a per-boot capability token the audio route publishes to the page; the strip already holds it | free |
| `pnpm probe:delegation <profile>` | the delegation→answer path against the **installed** profile: answered / refused-with-reason / timeout, shadow-free check, package presence | free, no provider |
| `pnpm self-test <profile>` | five checks and one verdict — key, route, session, prompt, canned turn | one short session |
| **the harness session log** | **every turn, step, `tool/call`, `tool/result`, and the `source.kind` of every user message** | free |

That last row is the one that matters and it is already on disk, written by the harness rather than by us:

```
~/.dsh/sessions/<cwd-key>/<sessionId>/session.v4.jsonl.zstd
```

`--Users-asd-dev-deepseek-harness--` is the cwd key; `session-ea70184a-…` is the session the profile steers.
It is zstd-compressed JSONL and reads directly with `zstd -dc`.

## What the session log already proved

The steered session, twelve turns: **126 `tool/call` and 126 `tool/result` entries**, tools including `bash`,
`read`, `edit`, `write`, `grep`, `web_fetch`, `present` — and `voice_start`, `voice_say`, `voice_stop`.

- **Tool calls are not broken.** They work, repeatedly, in that session.
- **Every turn is typed text.** Every `user/message` carries `source.kind: 'user'`. There is **no
  voice-admitted turn in the log at all.**
- Turn 6 is the single word **"testing"**, answered conversationally in one step with no tool calls — which is
  correct behaviour for that input, and is not a failure of anything.

So the question sharpens considerably. It is **not** "why do tool calls fail". It is:

> **Why does a delegation that the provider has created never become a turn in the steered session?**

The provider side is proven (a delegation is created — see `docs/w1-delegation-envelope.md`), and the plugin
side is green with substitutes (see `probe:delegation`). What has never been observed is a voice delegation
*crossing into the session*. That is the whole of the remaining gap, and it is one boundary wide.

## What the recorder must capture

One correlated record per delegation, in order, so a single glance says which link broke:

| field | why it decides something |
|---|---|
| delegation id, created at | correlates the provider's event with ours |
| admitted? controller verdict, **its reason verbatim** | the `refused` case names the failure; S1 shipped speaking it |
| the prompt as actually sent, and its length | a truncated or empty prompt fails differently from a rejected one |
| turn id, and whether a `turn/start` appeared | **the link that has never been observed** |
| the turn's steps: `step/start`, every `tool/call` name, `tool/result` outcome | answers "were tools offered, and were they used" without guessing |
| the answer text, and whether it was appended | the return path |
| append acknowledgement, or the refusal verbatim | an ack proves injection, not hearing (invariant 6) |
| timings on both sides of the socket | separates a slow turn from a stalled one |

The responder already receives `session/event`, so it already sees `turn/start`, `step/*`, `tool/call` and
`tool/result` for the session it steers. **The instrument is a subscription it already holds** — it is
recording, not plumbing, that is missing.

## The GUI recording feature: yes, and it is mostly assembly

The strip already talks to the plugin's own routes with a capability token it already holds, and the journal is
already served. So a recording control is: a **start/stop** pair, a **name**, a **path shown on screen**, and
files written where a human can hand them over. Nothing about it needs a new transport.

A recording should be two files, because they fail differently:

- `recording.jsonl` — the correlated delegation records above, plus the journal slice, events only.
- `summary.json` — versions (**loaded**, not installed), the resolved config, the counts, and the one-line
  verdict per delegation.

## Fidelity rules, because "audit-grade" has to mean something specific

- **Events only, never audio bytes.** A fixture utterance is reproducible; 200 KB of PCM per run is not
  reviewable, and it is not what any question here needs.
- **No session ids and no credentials**, elided at the recorder. The leak scan is the gate that catches it, and
  it has already caught it once in this repo — a recording that cannot be committed cannot be audited freely.
- **Loaded versions, not installed ones.** The difference is an open question, below.
- **A recording that cannot answer a question is not worth capturing**, so every field above has a question
  next to it. A field with no question is a field to leave out.

## The open question to settle first, because it may make the rest moot

The strip in the running app rendered **six** settings rows. `realtime-responder@0.2.4` registers **nine** — the
three narration fields are absent from that render. Either that render predates the restart, or the page is
serving a stale list, or **the app has not loaded the released responder at all**.

Installed is not loaded. The probe reads the profile's `node_modules` and reported `responder=0.2.4`, which
proves only what is on disk. If the app is running an older responder, then an answer to every delegation is
being sent into nothing — which would explain every observation, including the absence of voice turns in the
session log, without any new bug at all.

**So the first thing the recorder must print is the version actually serving the request**, from inside the
plugin, and the first check is whether it agrees with the profile.

## First slice, in order

1. **A `/dsh-realtime/recording` route pair** on the audio plugin: `start` / `stop`, writing to a named path,
   reusing the diagnostics route's existing token check rather than deriving a second policy.
2. **The delegation trace in the responder**: subscribe to the session events it already receives and write the
   correlated record above. This alone answers the sharpened question.
3. **The strip's control**: start / stop / show-path, so a run is something a human can trigger and hand over.
4. **A scripted run-through**: replay the fixture utterance through the live session so a recording is
   reproducible rather than anecdotal — optional, and last, because steps 1-3 already answer the question.

## Known failure modes to instrument, from a ticket the app's own agent wrote

`voice-say-ticket.md` (in `~/dev/deepseek-harness/`) root-causes a `voice_say` failure at the wire: a
`session.commentary.append` with `delegation_id: null` immediately after `session.started` is a **valid** frame
the provider simply **never acknowledges** — it applies context only during an active turn. That matches this
repo's own measurement (`docs/usable-window.md`): the window is the model's generation, and it closes.

Any recording of a tool call that appends must therefore capture **whether a delegation was outstanding at the
moment of the append**, because that — not the append, and not the tool — is what decides whether anything is
heard.
