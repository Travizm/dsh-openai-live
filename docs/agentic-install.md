# Agentic install: what the harness already gives us, and the two things it does not

The question this answers: *can a person installing this plugin work on it — troubleshoot it, configure it,
diagnose it — from inside the harness, in chat?* The short version is **yes, and most of the machinery is
already there**; the gap is domain knowledge, not transport.

## What is already true, measured rather than assumed

Read from the harness's own session log (`~/.dsh/sessions/…/session.v4.jsonl.zstd`), the tools the app's agent
has actually **called** in one development session:

```
bash 87 · read 17 · edit 5 · write 4 · grep 3 · web_fetch 3 · present 2
voice_start 2 · voice_stop 2 · voice_say 1
```

Two facts follow, and they are the whole foundation:

1. **The agent inside the harness already has a shell and an editor.** It can run `pnpm gate`, read the
   source, edit it, run a probe and read the journal *today*, from chat, with no plugin of ours involved.
   "Work on the plugin inside DSH" is not a feature to build; it is a workflow that already functions, and
   `docs/diagnostics.md` is the file that tells a human how to drive it.
2. **Our bundle already publishes tools into the harness, and the model used them.** `voice_start`,
   `voice_stop` and `voice_say` come from `voiceToolDefinitions` in `dsh-realtime-agent`, registered on the
   harness's `tools` service like any other plugin's. This is not a proposal about a mechanism that might
   work — it is the mechanism, already in production, already exercised.

So the question narrows to: **what does an installer need that `bash` cannot give them?**

## Three things a shell cannot reach, and one it can

| Need | Reachable with `bash`? |
|---|---|
| The journal | **Yes** — it is a file at `journalPath`, and `read` on it answers most questions by itself. This is why the journal is a file at all. |
| The **running** process's state: is a session open, how many clients are on the audio route, what config did this process actually resolve | **No.** It lives in memory. A shell reads yesterday's file. |
| The provider's own answer *now* — is the credential good, is there credit, is the model entitled | **No** — unless the probe is run, which is one command the agent does not know to run. |
| Changing a **live** setting | **No** — the seam's settings registry is the only path, and it is in-process. |

## The proposal: domain tools plus one skill, and nothing else

Publish five diagnostic tools on the harness's `tools` service (the mechanism `voice_start` already proves),
each wrapping something that already exists:

| Tool | Answers | Wraps |
|---|---|---|
| `voice_status` | is a session open, on which model, with which session steered | the `realtime-agent/status` query that already exists |
| `voice_journal` | what happened, in order, the last N entries | `journal.snapshot()` — the same call the diagnostics route serves |
| `voice_diagnose` | is the whole path sound: route → session → delegation → answer | the five checks `scripts/self-test.mjs` already runs, in-process |
| `voice_probe_provider` | is the credential good, is there credit, is the model entitled | the handshake `scripts/protocol-canary.mjs` and the refusal probe already make |
| `voice_configure` | change a live setting, and read the registry | the seam's `settings.apply` — the only path, and the one the control channel already uses |

And **ship a skill with the bundle** (`dsh-realtime` renders one), because tools without an order are a
toolbox with no manual. The skill is short and it is the product:

> When the user says the voice is not working: call `voice_diagnose` first, then `voice_journal`. If the
> journal shows `session.requested` and nothing after it, the agent row is not loaded. If it shows
> `session.failed`, read the **code** — `INSUFFICIENT_CREDIT` is an account to top up and the entry carries
> the page; `CREDENTIAL_REJECTED` is a key; `NOT_ENTITLED` is model access. If it shows `session.opened`,
> the fault is downstream and the session log is the next file.

That is the difference between an agent that *can* act and an agent that *knows what to do*, and it is the
part that turns a plugin into something a stranger can install.

## What this is not

- **Not MCP, and not ACP.** Those exist (`mcp/mcp-client` consumes external servers; `acp` and `sdk` drive
  the harness from outside) and none of them is needed for an agent already inside the harness to call our
  tools. MCP would only matter for reaching this plugin from a *different* agent.
- **Not a fork of the harness.** Everything above is a plugin contribution: register tools, register a skill.
- **Not a substitute for the journal.** Tools read the record; the record is what survives the process, is
  what a support conversation can quote, and is what made tonight diagnosable. Tools make it reachable in
  conversation; they do not replace it.

## Order, if we build it

1. **`voice_journal`** first: it is the smallest, it wraps one existing call, and it is the one that turns
   "voice is broken" into a file the agent and the user can look at together.
2. **`voice_status` next**, because it is the other half of the same question and it already exists as an
   event.
3. **`voice_diagnose`**, which is `self-test` in-process and is the single command that answers *is it us or
   is it the provider*.
4. **The skill**, before the remaining two tools: it is what makes any of them get called at the right moment.
5. **`voice_probe_provider` and `voice_configure`** last, because they are the two that act on the outside
   world — one spends a little provider credit, one changes a running system.

## What landed

Built: `voice_journal`, `voice_status`, `voice_diagnose`, then `voice_configure` and
`voice_probe_provider` — order 5 taken before order 4, for the reason in the section below. Each is
registered by `dsh-realtime-agent`'s own plugin and answered from the seam, so no tool reads another
plugin's key string: the settings registry, the steering claims and the transport reports are capabilities
`ctx.realtime` owns, and every one of them is read when the tool is *called* rather than at registration.

Two of the five act on the outside world, and both say so in their own description rather than leaving a
caller to find out:

- **`voice_probe_provider` opens a throwaway session and closes it.** A bare handshake is not metered and
  succeeds while every real session is refused, so only a real attempt separates a refused credential from
  an account with no credit from a model it is not entitled to. It goes through the seam directly rather
  than through `open()`, so it cannot displace the live session it was asked about, and both paths ask for
  the *same* options through one builder — a probe that tested a configuration nobody uses would answer,
  confidently, about the wrong thing.
- **`voice_configure` reaches only `live` fields.** A session-bound or restart-bound field is refused by
  the registry, with its own reason relayed verbatim, because those reasons are written to be relayed. No
  credential is reachable through it at all: `apiKey` is config, not a registered setting.

Both are deliberately last in the list *and* in the description a model reads. A tool that spends credit
or changes a running system should be the one a caller reaches for after the cheap checks have failed, not
before.

### Still open: the skill

Order 4 is the one piece not built, and it is the one that makes the other four get *called*. The tools
answer questions; nothing yet tells a model which question to ask first, so a session that is merely quiet
still looks, from the outside, like a session that is broken.

There is also a question this document had skipped: it says the skill is rendered by `dsh-realtime`, but
that package is a **service** — it default-exports its class and has no `apply`, by the export-form
contract — so something with an `apply` has to render it. The candidates are the agent (which is already a
row and already holds the session), a new small plugin, or the responder. Whichever it is decides where
the triage text lives, and it should be decided before the text is written rather than after.

