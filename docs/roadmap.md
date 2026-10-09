# Roadmap

Where this plugin is, what's missing, and what it would take to be the voice assistant people
actually install for DeepSeek Harness.

## The diagnosis: failures here are invisible

Every hard problem in the first week of this plugin was the same problem wearing different clothes.
The plugin had no way to say what it was doing, so the only evidence was outside it: session logs
read off disk, a refusal timed by ear against a stopwatch, a `catch {}` that threw a reason away.

Three concrete instances, all from one evening:

- **A row that waits looks identical to a row that works.** `inject`ing a service that never appears
  produces no error and no output — just a plugin that never answers.
- **A refused prompt and an agent that never replied collapse into the same value.** `return undefined`
  means both "I couldn't ask" and "I asked and got nothing", so the two most different failures in the
  system are indistinguishable from outside it.
- **A plugin that shadows a host package breaks the host, not itself.** The symptom appears in a
  session with no visible connection to the cause.

That is the class. The corrective action is not three patches; it is a diagnostics layer, and it is
the highest-value work remaining in this repo.

## Layer 1 — a journal, always on

Every seam event, timestamped, in a bounded ring buffer: session opened/closed, socket connected or
refused *with the rejection*, delegation seen, prompt admitted or refused **with the reason the
controller gave**, answer received, window elapsed, injection row emitted, config as resolved.

It needs no new host capability. It is `ctx.on` over the events this plugin already publishes and
consumes, plus the error text that is currently discarded at three call sites.

Surfaced three ways, and the first is the interesting one:

- **Spoken.** The plugin can already speak — `commentary.append` is how an answer reaches the user.
  So a failure can be *narrated*: "the session refused the prompt: model unavailable". This turns the
  audio channel into the diagnostic channel, which is precisely what was missing when the only thing
  the user could hear was the model's own "I can't take care of that".
- **A route.** The web server's registry is "a plain route registry with no harness vocabulary" and
  explicitly built for plugins to claim routes on. `GET /dsh-realtime/diagnostics` returning JSON,
  and an HTML view of the same, costs one route registration.
- **A panel in the app.** `webserver/index-inject` accepts `html` and `script` rows, which is how the
  client face already receives its settings. The same door puts a status strip in the app UI.

## Layer 2 — a self-test that answers "what is wrong?" in one shot

A command that checks the whole chain and reports a verdict rather than a symptom:

- Is the provider key present and entitled? (a real session create, not a shape check)
- Does the upgrade route accept an authenticated connection?
- Is the target session live, and does the controller accept a prompt into it?
- Does a canned turn come back, and in what time?

Today that sequence is an hour of forensics across four tools. It should be one button, and its
output should be quotable in a bug report.

## Layer 3 — a real bi-directional interface

The audio socket is already duplex, so the control plane can ride it: `status`, `start`, `stop`,
`steer <sessionId>`, `set <key>=<value>`. The point is not elegance — it is that **the config is read
at boot and only at boot**. Changing which session the voice steers cost two restarts and a false
lead tonight; it should cost a message on an open socket. Live config is the single biggest usability
win available, and it is upstream-independent.

## The pathway to a plugin people install

Ordered, each step small enough to ship:

1. **v0.5 — observability.** The journal, reasons on the wire, the self-test command. A plugin that
   explains itself is the precondition for everything below, and it is also the best bug-report
   generator a maintainer can have.
2. **v0.6 — control and UX.** The in-app panel, live config, a session picker, start/stop that isn't
   a devtools global. **A plugin driven from a console global will not be installed by anyone.**
   *Shipped in 0.6.0:* the field gate, the control channel on the audio socket, and the strip.
3. **v0.7 — narration.** Progressive speech while the agent works: "running the command… 14 files…
   the README says…". This is the Codex-shaped feature and the demo that sells it — and it fixes the
   real ceiling, which is that an all-or-nothing answer must fit inside one delegation window.
   That window is **ours** (`delegationTimeoutMs` is a row in our own patch), so it can be raised;
   narration is still the better answer, because a voice that goes silent for ninety seconds reads as
   broken no matter how correct it is.
4. **v0.8 — provider-agnostic.** The seam (`dsh-realtime`) already separates the wire from the
   transport, and `realtime-openai` and `realtime-replay` are two implementations of it. Gemini Live,
   and DeepSeek's own realtime when it exists, are adapters — not rewrites. **Portability is the moat:**
   a plugin that requires one vendor's entitlement is a demo, a plugin that accepts any realtime
   provider is infrastructure.
5. **v1.0 — documentation and presence.** The plugin-author checklist (`peer`, never shadow;
   the lazy-CJS client contract; `registerUpgrade`; `index-inject`), a 30-second demo, and listings in
   the `dsh-plugin` catalogues. The ecosystem is young and the doors above are undocumented in one
   place. Whoever writes them down first is the reference implementation.

## What is DSH's to fix, and what is ours

**Ours**, and most of it: the discarded reasons, the diagnostics layer, the console-global on-switch,
narration, and the packaging discipline. None of it needs an upstream change.

**Theirs**, and worth asking for precisely — not a handover, a short list:

- **A documented author-facing log channel.** The plugin's own failures should land somewhere a user
  can find without a debugger. If the harness exposes a logger service, this plugin should be using it
  rather than inventing a route.
- **The four doors, documented together.** `registerUpgrade`, `webserver/index-inject`, the client
  module-table contract, and the rule that a plugin must never carry its own copy of a harness
  package. Each was discovered by reading source; together they are the difference between a plugin
  that behaves and one that takes the host's tools down with it.
- **A clearer signal for a row that never activates.** Today a waiting row is silence with a green boot.

Filing those as issues and a docs PR is cheap, and it is also how a plugin becomes the one the
ecosystem points at.

## The honest adoption barrier

Every user needs a realtime-capable key, and today that is one vendor's entitlement. Until that is
solved — by other adapters, or by the platform providing voice — the addressable audience is small
and technical. The mitigation is the same as the moat: make the seam the product, and let the
provider be a choice.

## Where this is right now

`dsh-openai-live 0.6.1`, six packages, 100% coverage on every file, published and verified by real install.
It works, and since 0.5.2 it **explains itself**: a bounded journal the plugins write to, the controller's
reason carried on the wire *and spoken*, a `GET /dsh-realtime/diagnostics` route, and `pnpm self-test
<profile>` for one verdict worth pasting into a bug report.

Since 0.6.0 it is no longer started from a devtools global: the strip in the app's own page carries start,
stop, a session picker and a control for every field whose read site can honour a change, and the same channel
refuses the ones it cannot with a reason rather than a shrug.

Since 0.6.1 a delegated turn **narrates** — steps are carried while the agent works, spoken or silent by
policy, paced against a window that story 1 measured rather than assumed (`docs/usable-window.md`).

Still true, and owed: an all-or-nothing answer must fit inside one delegation window, and a dropped socket
ends the conversation rather than being rejoined.

And two things are newly known to be false, both the same shape — **a failure with no voice**:

- **A pinned session id rots silently.** The profile pins one; the app creates a new session on restart; the
  delegation is admitted against a session the user has left, nothing says so, and the model then *improvises*
  an explanation for the silence. Diagnosed in `docs/steering.md`, with the prior art from `codex app-server`.
- **The journal lives only in the app's memory.** It is served, but only to a caller holding a per-boot
  capability token — so it cannot be handed over, and it cannot be read after the fact. Scoped in
  `docs/diagnostics.md`.

## The next cycle — anything required to answer "why did nothing happen?"

A user cannot debug what the product will not say. Both defects above are one defect: the plugin knows its own
state and does not report it. Ordered, smallest first.

1. **Speak the failure.** When there is no target session — or the configured one is not *attached* — say so
   out loud, naming the session, instead of admitting into the void and leaving the model to invent a reason.
   `SessionController.inspect` distinguishes attached from persisted, and `ApiSessionNotFound` is an exported,
   catchable name for the case. This alone turns a two-hour investigation into one sentence at the moment it
   happens. **Acceptance:** a stale pin produces a spoken sentence naming the session, never a silent no-op.
2. **Follow the live binding rather than the pin.** Default the target to the live-control state from
   `control()` — the app's own — and demote the configured id to a deliberate override. That is Codex's
   auto-subscribe in our vocabulary, and it is what "operate across the harness layer" means mechanically.
   **Acceptance:** restarting the app does not require a `Steer` before the voice works.
3. **Write the journal to a file.** The seam already holds it; mirror it to JSONL on disk so a run can be
   handed over and audited without a token. **Acceptance:** a run yields a file that says which link broke,
   with no debugger and no live session.
4. **A delegation trace in the responder.** It already subscribes to `session/event`, so it already sees
   `turn/start`, `step/*`, `tool/call` and `tool/result`. Record them per delegation. **Acceptance:**
   "answered" becomes "answered, and here are the tool calls it made".
5. **A recording control in the strip** — start, stop, show-path — so a run is something a human can trigger
   and hand over.
6. **Confirm the narration window in a real turn** — story 3's demo, still owed: a long agent turn, narrated,
   and heard.

Steps 1 and 3 are worth doing before the others: together they make every later bug one reading rather than
one investigation, which is the whole argument of this document applied to the failures now known to exist.
