# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.5] — 2026-10-10

### Added

- **`pnpm probe:open` — the provider, asked directly.** `spike/open-failure-probe.mjs`. It drives the
  **production adapter** with the **production payload** and prints the refusal **redacted against the key** —
  the one thing `self-test` cannot do (it substitutes the provider) and the one thing the canary misses (a
  handshake sends no `session.start`, so it passes on an account with no credit, which is exactly what it
  did). Its first run named `INSUFFICIENT_CREDIT` / `credit_balance_exhausted` / `retryable=false` in a
  second, after an evening of instruments that could not.

### Fixed

- **A refusal's `code` is recorded, so the journal says what to *do*.** `dsh-realtime-agent` 0.2.10. The entry
  carried the error's class and nothing else, so the first real refusal it captured read
  `class=RealtimeError` — a value that cannot distinguish *add credit* from *replace the key* from *wait*.
  It now carries the seam's `code`, the provider's `providerCode`, the `remedy` and `retryable`: our own
  vocabulary, or a short provider identifier, and never the message — the message is where a key turns up,
  and the plugin that holds the key and can redact against it is the adapter, not the agent.
- **The file sink receives the entries recorded before it attached.** `dsh-realtime-audio-ws` 0.2.6.
  `config.resolved` is written at apply, above the `onEntry` call, so it reached the in-memory journal and
  never the file — and the file's silence then read as a plugin that had failed to load. A record that
  depends on load order lies by omission; the sink is handed everything the journal already holds before it
  is attached. Found by the first production run of that entry, which is what an instrument is for.

## [0.6.4] — 2026-10-10

### Added

- **The ask, the refusal, and the config that was resolved.** `dsh-realtime` 0.2.6 ·
  `dsh-realtime-agent` 0.2.9 · `dsh-realtime-audio-ws` 0.2.5. A journal for a session that never opened was
  byte-for-byte the same shape as one for a session nobody asked for — an accepted socket, then nothing — so
  neither could be told from the other and *"the voice is broken"* had no answer anywhere in the file.
  `session.requested` is now recorded by **whoever asks**, with its trigger (`connect` / `strip` /
  `autostart`); the ask and its outcome are written by *different plugins* on purpose, so the pair
  **brackets** a hand-off that crosses a plugin boundary — and a request with no outcome after it says the
  listener never ran, which no single entry can say because the opener's silence reads the same either way.

### Fixed

- **A refusal decided before the provider was called left no trace.** `dsh-realtime-agent` 0.2.9. The
  transport's start path calls the agent through `emit`, which **discards a returned outcome**, so a refusal
  that had already been classified — with a remedy already named for the user — reached no record at all. It
  is now journalled by **class, never message**, exactly as the provider's own error path already was, and
  for the same reason: a provider error can carry the key it refused. The boot path was worse — `autoStart`
  did not go through `requestSession` at all, so a **restart** that failed to open a session recorded nothing
  whatsoever, which is the path a restart actually lands on.
- **`config.resolved` was documented and had no producer.** `dsh-realtime-audio-ws` 0.2.5 ·
  `dsh-realtime-agent` 0.2.9. The kind was declared in the journal's vocabulary *and* promised by the table
  in `docs/diagnostics.md`, and nothing wrote it — so its **absence** read as evidence that nothing had been
  configured. A kind is not a capability. Each plugin now records its own at apply: values only, no field
  that can carry a secret, and `instructions` excluded deliberately, because the journal records what
  happened rather than copying the configuration into itself.

### Changed

- **The responder's call site borrows the session controller's real type.** No runtime change, and the
  responder is not republished for it — but it is the guard that would have caught 0.6.3's defect at compile
  time, so it is recorded here rather than left to the commit log.

## [0.6.3] — 2026-10-10

### Fixed

- **Every delegation was refused for want of a signal.** `dsh-realtime-responder` 0.2.5. The responder called
  the session controller's `prompt(request)` with **one** argument; the real method takes **two**, the second
  a required `AbortSignal` that the harness reads before it will even consider the request. Every delegation
  since the seam was written died with `Cannot read properties of undefined (reading 'throwIfAborted')` — the
  headline capability had never once worked in production, and the suite was green throughout.

## [0.6.2] — 2026-10-09

### Added

- **A record that can leave the process that made it.** `dsh-realtime-audio-ws` 0.2.4. The journal stays
  I/O-free: a sink is supplied by the deployment that wants one (`journalPath`, **off by default**, because a
  plugin that writes files merely because it was installed writes in someone else's directory), and every
  sink call is wrapped so a broken sink costs the copy and never the entry. Entries reach a sink *after*
  redaction, which is why this is a sink rather than a second writer with its own idea of what a secret looks
  like.

### Fixed

- **The strip was painted over the host's page and could not be read.** `dsh-realtime-audio-ws` 0.2.4. A
  fixed overlay whose background was a translucent wash let the host's own text read straight through it: two
  texts superimposed, neither legible, and no stack trace. The reported symptom was "the GUI is
  unreadable". It is now an opaque, theme-aware base with a soft shadow, and the guard asserts the **paint**,
  because jsdom has no compositor and no DOM assertion can see what is behind an element.

## [0.6.1] — 2026-10-09

### Added

- **A delegated turn's steps, narrated while it runs.** `dsh-realtime` 0.2.4 · `dsh-realtime-agent` 0.2.8 ·
  `dsh-realtime-responder` 0.2.4. Milestones are spoken from a phrase table keyed by the tool's **name** —
  never from the model's own argument text, so no model-authored text reaches the ear — and paced per turn:
  the first step is never held back, and later ones respect an interval and a per-turn ceiling.

### Fixed

- **Every real turn timed out, because the answer was matched on a field no event carries.** The responder
  read the session id off the event; the harness passes it *beside* the event, as the listener's first
  argument. A filter copied from the answer reader then dropped `tool/call` entirely, since `tool/call` is
  not a surface event and carries no `surfaceOp` at all.

## [0.6.0] — 2026-10-09

### Added

- **A control channel on the audio socket.** `dsh-realtime-audio-ws` 0.2.3. `status`, `start`, `stop`,
  `steer <sessionId>` and `set <key>=<value>` as **text frames** on the socket that already carries audio.
  A deliberate widening of a documented contract — the bridge said "a text frame is not part of this
  contract" and ignored one, and the comment and the contract were changed together rather than left
  disagreeing. Every frame produces exactly one reply, including an unknown verb, a stray argument, a
  frozen field or a rejected value: a channel that can answer a question with silence is not a control
  plane. One frame in flight at a time, so a reply can never be paired with the wrong request.

- **A field registry, and the classes it enforces.** `dsh-realtime` 0.2.3. A setting is **live** (its read
  site calls `get()` at the moment of use, so a change lands on the next use), **session-bound** (it
  travelled in the provider's `session.start` and only a reconnect can change it), or **restart-bound**
  (claimed once at load). A `live` field declares a setter and a frozen field declares none; a declaration
  that says otherwise **fails at load** rather than shipping an affordance the protocol cannot honour.
  Changes are journalled by **key only** — a secret-bearing setting's value is exactly what must not be
  retained — and a refusal carries a machine code and a reason written to be relayed verbatim.

- **A strip in the app's own page.** `dsh-realtime-audio-ws` 0.2.3. Two `webserver/index-inject` rows mount
  a panel: live fields get controls, session-bound fields get the value they will take and the words
  "reconnect to apply", restart-bound fields get no row at all. Every `set` reports its outcome beside the
  field it belongs to and a refusal is relayed with the host's own code. The panel's logic lives in the
  client bundle, where CI executes it; the injected script is a doorbell, and it is executed by a test too.

- **A session picker, and candidates as a property of the field.** `dsh-realtime-responder` 0.2.3. A
  setting may declare `choices()` — called per ask, like `get`, and refused at registration on any kind but
  `string`. The responder reads the harness's session store **optionally**: a profile without it degrades
  the picker to a text field rather than stopping the plugin, because an unsatisfied `inject` is silence
  and a missing enhancement must never be able to stop the plugin answering.

- **`status` for the agent, and outcomes for start/stop.** `dsh-realtime-agent` 0.2.7. Asking a running
  plugin what it is doing now has an answer: whether the voice is open, which provider and model it booked,
  which session it accepted — and, when it is closed, what a start would use. `start`, `stop` and the
  session request return their outcome rather than emitting into the dark, so a transport that can wait can
  report what happened.

### Changed

- **`autoStart` is restart-bound, and the gate says so.** It was documented as a field a change could
  reach, and no read site could honour one. Reclassified rather than wired: a control that silently does
  nothing is worse than no control, and the load-time refusal is what keeps the two from drifting again.

- **A live field is re-read at the moment of use, never captured at apply.** `dsh-realtime-responder`
  0.2.3 and `dsh-realtime-agent` 0.2.7 read `sessionId`, `maxPromptChars`, `answerTimeoutMs`,
  `redactSecrets` and the delegation timeout through accessors. This is what makes those five fields
  changeable without a restart, and a mid-turn change lands on the next turn rather than the running one.

### Fixed

- **`dsh-realtime-audio-ws` declares the seam it imports.** 0.2.3. `src/control.ts` imports the value
  `redact` from `dsh-realtime` while the manifest declared only `dsh-realtime-agent` and `ws`; the type
  imports beside it hid the omission, and the built `lib/` reached for a package the tarball never asked
  for. It resolved only because the installer's layout happened to hoist a copy — a boot error waiting for
  a layout change.

- **A reply that cannot be written no longer escapes.** The bridge's `reply` is total: a socket can die
  between the liveness check and the write, and a throw there would escape into a promise nobody awaits —
  and, on the host, break the reply queue for every frame behind it.

- **The session the voice steers becomes the strip's headline control, so the seeded refusal can go.**
  S1's last exit criterion left `cordis.patch.yml` pointing `sessionId` at a session that does not exist, so
  every admission is refused *with its reason* rather than the flat notice. The reason it existed — proof
  that a refusal speaks — is now permanent, and the field it was teaching about is a picker. The install
  below reverts the seed; expect a refusal, and hear why, until it does.

## [0.5.3] — 2026-10-09

### Fixed

- **The diagnostics route now lets its own page read it.** `dsh-realtime-audio-ws` 0.2.2. The route
  authenticated the request and answered `200`, and the browser discarded the body: a cross-origin
  response with no `Access-Control-Allow-Origin` is unreadable however correct it is, and the host's page
  is always cross-origin to loopback. The cause is an assumption carried from the sibling route —
  **WebSocket upgrades are exempt from CORS**, so the audio route never needed the header and the HTTP
  route inherited the design without the exemption. The header now reflects the caller's own origin,
  because the capability token is the authorisation here and not the origin; it travels with `Vary:
  Origin`, on the refusal branch as well as the answer, and a preflight is answered only after the
  verdict. Every test had asserted the HTTP status, which was right the entire time.

- **A journal entry for a session that opened is exactly that.** Stated here because it cost a
  wrong diagnosis: `session.opened` is written only after the provider session resolves, and the
  credential is resolved inside that call — so the entry is proof the credential was present. Reading it
  as a local optimism sent a search for a missing key that was configured all along, in `$DSH_HOME/.env`.

## [0.5.2] — 2026-10-09

### Added

- **A journal, owned by the seam.** `dsh-realtime` 0.2.2. A bounded ring buffer over the events the
  plugins already emit and consume — session open and close, socket verdicts, delegation seen, prompt
  admitted or refused **with the reason**, window elapsed, append acknowledged — readable as JSON. The
  seam owns it because it is the one object every bundle plugin already holds: a reader must not have
  to correlate three partial records to answer one question. Secrets arrive additively
  (`addSecrets`) rather than at construction, because plugins load in an order nobody guarantees, and
  entries are redacted **at emission**, by shape and by value.

- **A failure you can hear.** `dsh-realtime-responder` 0.2.2. A refused turn now speaks the session
  controller's own reason through `commentary.append`, rather than leaving the user the model's flat
  notice — the useful part first, nothing framed in front of it, redacted and bounded. A declined or
  timed-out turn keeps the flat notice **deliberately**: those carry no words, and inventing a reason
  for them would be worse than the honest silence they already had.

- **`GET /dsh-realtime/diagnostics`.** `dsh-realtime-audio-ws` 0.2.1. The journal as JSON, behind the
  same policy as the audio route itself — one `verdictFor`, two doors — so the two cannot drift until
  one of them holds the weaker answer. A rejected request records the verdict alone, because a wrong
  token is still a credential. `TOKEN_PARAM` is published with the route: nothing can address it
  without that query parameter, and a consumer restating the literal is a consumer that drifts.

- **A fault matrix, a self-test, and a redaction sweep.** Five faults — a controller refusal, an
  inactive responder, socket loss, an append acknowledged without playback, and barge-in — each driven
  through the real plugins and read back from one journal, asserted to leave **five distinguishable
  records**. `pnpm self-test <profile>` distils five checks into one verdict worth pasting into a bug
  report, printing the reason verbatim when something fails. The sweep plants a sentinel and drives it
  through every sink. None of this ships to a consumer; all of it is what makes the rest checkable.

### Changed

- **`speech.played` is now `speech.sent`.** The host hands frames to a transport; whether a speaker
  rendered them is known only to the page, and no host-side record can honestly assert it. A kind named
  for playback would be the diagnostics lying about itself — invariant 6, applied to a name.

### Fixed

- **A barge-in is not recorded, because the protocol never reports one.** Measured across the whole
  live vocabulary — nine event types and not one of them an interruption — and `design.md` invariant 2
  forbids the host detecting one for itself, because endpointing belongs to the engine. The fault
  matrix asserts the **absence**, so the day that vocabulary grows an interruption event a test fails,
  rather than a journal quietly claiming to have seen something no observer has.

## [0.5.1] — 2026-10-09

### Added

- **A settled delegation says *why* it produced nothing.** `dsh-realtime-responder` 0.2.1 and
  `dsh-realtime-agent` 0.2.5. The new `realtime-agent/delegation-settled` event is emitted for every
  turn that is **not** answered — `declined` (there was nothing to ask), `refused` (the session
  controller rejected the admission, carrying **its own reason**) or `timeout` (admitted, nothing came
  back inside the bound). Until now all three arrived as the same `undefined`, which is why the
  plugin's foundational failure could not be diagnosed from outside it. An answered turn is not
  settled: the answer is its own report.

- **`redact()` — the credential rule, in one place.** `dsh-realtime` 0.2.1. Diagnostic surfaces are
  places a provider key or the route's capability token could escape into, and a disclosure outlives
  the debugging session that introduced it. The primitive removes secrets by **shape** (`sk-…`, a
  bearer header, a private-key block, a JWT, a recorded fingerprint) and by **value**, because a
  32-byte base64url capability token has no shape any pattern could catch and only the caller that
  holds it can name it. It is applied at emission, not in a later pass: the controller's reason is the
  first text this plugin relays that it did not author.

- **An installed-profile probe.** `pnpm probe:delegation [profile|/abs/dir]`, driving the
  delegation→answer path through the installed artefacts and correlating the delegation id, the
  reconstructed prompt, the controller's verdict and reason, the agent's result and the returned
  speech into `review-evidence/q1-delegation-<target>.jsonl`. It also asserts the two properties of a
  profile that have broken this plugin before: no `@deepseek-ai` shadow, and the bundle actually
  installed. Three cases — answered, refused (with a **planted sentinel key**, so the probe doubles as
  the redaction proof) and timeout.

### Changed

- **Released as *patches*, not minors — and that is the point.** `dsh-realtime` goes 0.2.0 → **0.2.1**
  and `dsh-realtime-agent` 0.2.3 → **0.2.5**, not `0.3.0`. A 0.x caret **minor-locks**, so `^0.2.0`
  means `>=0.2.0 <0.3.0`: a `0.3.0` seam falls outside every published consumer's declared range
  (`dsh-realtime-agent`, `-openai`, `-replay`, and the 0.4.0 bundle all carry `^0.2.0`) and installs a
  **second copy** of the seam — the duplicate-package defect that breaks a host silently. Inside the
  range, every existing consumer receives the fix with no action and no bundle upgrade.

  The bundle still goes 0.4.0 → **0.5.0**, because it must: `0.4.0` declares
  `dsh-realtime-responder@^0.1.0`, which cannot admit the responder's `0.2.0`.

- **`createTurnRunner` resolves with a `TurnOutcome` rather than `string | undefined`.** The four ways
  a turn can end are named, so a caller can act on the difference between *the controller said no* and
  *nobody answered in time* instead of re-deriving it. A rejection that carries no message reports
  that absence rather than a fabricated reason.

### Fixed

- **The published manifests carried `workspace:` and could not be installed at all.** `npm publish`
  ships `package.json` verbatim, and `workspace:^` is a **pnpm** protocol — so
  `dsh-realtime-agent@0.2.4`, `dsh-realtime-responder@0.2.0` and `dsh-openai-live@0.5.0` went out with
  dependency entries no consumer can resolve:

      npm error code EUNSUPPORTEDPROTOCOL
      npm error Unsupported URL Type "workspace:": workspace:^

  `pnpm pack` rewrites the protocol to a real range (`{'dsh-realtime': '^0.2.1'}`); the pack was
  correct and the *publish path* was not. Republished as `0.2.5` / `0.2.1` / `0.5.1` through pnpm, and
  the three broken versions deprecated so nobody installs them by accident.

  The lesson is the one this file already carries: **a publisher's success message is not evidence.**
  All three reported success and would have been declared done. Installing the bundle from the registry
  into a clean directory is the only pass that sees what a consumer gets — and it is the pass that
  caught this, one step after the poll of the registry showed four green versions.

## [0.4.0] — 2026-10-08

### Added

- **The desktop app can reach the audio route.** `dsh-realtime-audio-ws` 0.2.0, and the bundle that ships
  it. Until now the client half derived its socket URL from `location`, which works on the served browser
  UI and cannot work in the app: that page's origin is `dsh-app://app`, whose host is the literal string
  `app`, so it built `ws://app/…` — a name that resolves nowhere and fails in a way that reads exactly like
  the host refusing the connection.

  The host half now contributes a row to the web server's index-injection table: the door built for
  plugins, gathered on every index render and every worker boot payload, read fresh at emit time, which is
  the only moment the OS-assigned port is known for certain. The row publishes the route path, the
  authority to open the socket against, and a capability token.

  The token is not decoration. The app's requests to loopback are cross-site, so the harness's own
  `SameSite=Strict` auth cookie cannot travel and the connection service refuses that page correctly and
  forever, however right the rest of the client half is. One token, generated per process and injected only
  into the page the host itself serves, is the credential that can. The route's own verdict path is
  unchanged — it still asks the connection service in the same position, as DSH's own transport does — and
  the token merely overrides a refusal for a caller presenting it.

### Changed

- **A page that cannot derive an authority now says so.** `pageAuthority` refuses to read one from a
  non-http(s) page, and the client reports *"no authority for the audio socket: this page has none of its
  own and the host injected none"* rather than failing at connect with a refusal it cannot explain.

## [0.1.3] — 2026-10-08

### Fixed

- **The client face's registration shape — and the guard that should have caught it.** `dsh-realtime-audio-ws`
  0.1.3. Version 0.1.1 replaced the ESM failure by compiling the client face to CommonJS, and shipped a
  second failure in its place: `Uncaught ReferenceError: exports is not defined`, which stopped the harness
  booting just as thoroughly.

  The contract, quoted from the module table's own source: *"executing a plugin bundle only **REGISTERS its
  factory** (`window.__ModuleLoader__.load({id, factory})`) … Materialization (`factory(require) → exports`)
  happens on first import"*. A client bundle is therefore neither ESM nor plain CommonJS — it is a script
  that registers a factory which **returns** its exports, which is why a compiled CommonJS body needs a
  local `exports` object to assign onto. The build now performs that wrap after compiling.

  **The corrected guard is the more important half.** The one shipped with 0.1.1 asserted "CommonJS and
  nothing else" — inferred from the words *lazy-CJS* rather than read from the contract — and so it
  returned a confident pass while the application was broken. It now asserts the registration, and keeps
  the plain-CommonJS artefact as a fixture that **must fail** it. A guard that encodes a guess is worse
  than no guard, and this one demonstrated why.

## [0.3.0] — 2026-10-08

### Added

- **A connection opens the voice session.** `realtime-agent/start` and `realtime-agent/stop` are new bus
  events; the audio route emits them when an authenticated client connects and when its last client leaves
  (`openSessionOnConnect`, default true).

  This exists because the microphone could not otherwise be heard. The agent ships `autoStart: false` so
  that mounting the bundle does not open a socket and spend credit, and the mic seam drops frames while no
  session is open. Both are correct, and together they meant a working microphone produced **silence that
  looked like a fault anywhere but in the source**. Now connecting is enough: no profile option, and no
  dependence on a model choosing to call `voice_start`.

  The route defaults to true where the agent defaults to false, and the difference is the action.
  `autoStart` opens a session at boot with nobody asking. This responds to a connection, which took an
  explicit authenticated step — and a frame arriving before that session exists is still dropped, not queued,
  because the mic seam's rule is unchanged.

  Shipped as `dsh-realtime-agent` 0.2.2 and `dsh-realtime-audio-ws` 0.1.2. No bundle version accompanies
  them: `dsh-openai-live` declares `^0.2.1` and `^0.1.0`, which admit both.

### Internal

- **The gate now inspects the built client artefact, not only its source.** `scripts/client-artefact.mjs`
  fails the build when a package declaring `dsh.client` emits anything but CommonJS, or emits CommonJS
  without an `apply` entry point. It proves its own detector first against fixtures that must be rejected
  and accepted — which caught a false positive on the very first run, where `exports.apply` read as the
  `export` keyword. Coverage cannot see this class of defect: it measures the source, and a source and its
  emitted artefact can disagree about module format silently.

### Fixed

- **The client face shipped as ESM into a loader that materialises CommonJS.** `dsh-realtime-audio-ws`
  0.1.1. The browser entry was emitted by the package's ordinary `tsc` build, so it carried `export`
  statements into a loader the harness itself calls *"the lazy-CJS module table"*. The renderer reported
  `Uncaught SyntaxError: Unexpected token 'export'`, and because the web boot fails loudly on a single bad
  entry, **the whole application refused to start** — a shipped defect with a visible blast radius.

  The client face now has its own CommonJS build target, and it imports nothing at all: the Cordis context
  it used is stated structurally instead, so the served artefact has no ESM syntax and no `require` calls.

  No bundle version accompanies this: `dsh-openai-live` already declares `dsh-realtime-audio-ws: ^0.1.0`,
  which admits 0.1.1, so a new bundle version would be a version with no change behind it.

## [0.3.0] — 2026-10-08

The voice loop closes in code. A session can now be heard, answered, and reached from a browser: four
packages ship, two of them new.

### Added

- **`dsh-realtime-responder` — the application that answers.** Until now a delegation was published to
  the bus and nobody replied, so a working voice session said, out loud, that it could not take care of
  the request. This package listens, admits a turn to a real DSH session
  (`sessionController.prompt`, which returns a receipt and not an answer), waits for the session's
  `assistant/message` on the `session/event` bus, and returns the agent's reply for the voice model to
  speak.

  It is a separate package rather than part of `dsh-realtime-agent` because the agent's contract is that
  an **application** answers; folding the answerer in would make the plugin answer itself, which is the
  shape the seam was designed to avoid.

  Both bounds govern: the agent's `delegationTimeoutMs` and the responder's `answerTimeoutMs`. The
  smaller one decides what is actually heard, so the shipped patch sets both to 45 s.

  It does **not** yet acknowledge-then-speak-late — the voice model waits in silence, and past the bound
  the responder declines rather than inventing an answer. That refinement needs a spike (does the
  provider hold a delegation open for a late append?) which requires audio in flight, so it lands with
  the client half.

- **The audio seams, in both directions.** `dsh-realtime-agent` no longer drops either end.
  `realtime-agent/audio` carries provider output audio — frame for frame, in order, unbuffered — and
  `realtime-agent/mic` writes capture frames into the open session. Input had no route at all before,
  because the object that captures it (a client half) cannot reach the plugin's context; the frames
  arrive as an event, and the agent keeps the only object that can write them.

  A microphone frame arriving with no session open is **dropped, not buffered**: a capture device may
  well start first, and a queue that grows while nothing drains it presents first as latency and then as
  an unbounded allocation. A write into a session that closed a moment ago is a race rather than a fault,
  so it is reported on `realtime-agent/error` instead of thrown from a listener — which has no caller to
  catch it.

- **`dsh-realtime-audio-ws` — the host end of the client half's transport.** The bundle could decode the
  provider's audio and hear nothing else: no socket existed for a browser to connect to. This package claims
  one WebSocket upgrade route on the harness web server and bridges it to the two events the agent already
  carries — `realtime-agent/mic` inbound, `realtime-agent/audio` outbound. It is transport and nothing else:
  no audio logic, no session, no format handling.

  It is an upgrade route rather than a Remote because a third-party plugin **cannot add a Remote** — that
  needs generated artifacts and a mount inside a DeepSeek-owned assembly. The web server, whose own README
  calls it *"a plain route registry with no harness vocabulary"* built so other plugins can claim routes, is
  the door that is actually open.

  **It authenticates, because it must.** Upgrade requests never reach the HTTP route handlers, so no gate
  answers them and a route would otherwise be an unauthenticated loopback endpoint carrying microphone
  audio one way and the agent's answers the other. The handler asks the connection service in the same
  position DSH's own transport asks it, and refuses in the same bytes.

  Frames are forwarded, never queued — the same rule the audio event carries — and a frame above
  `maxFrameBytes` closes the connection with 1009 rather than being truncated.

  No browser face yet: nothing here opens a microphone or plays audio.

- **The client half — `dsh-realtime-audio-ws/client`.** The browser face of the transport: it opens the
  route's socket, captures the microphone into it at 24 kHz PCM16, and plays what comes back. No client
  services, one file, and it injects nothing.

  `start()` **reports rather than throws** — a refused permission or a missing browser API arrives as
  `{ kind: 'failed', reason }`, because the reason is what tells someone whether to grant something or look
  elsewhere. It refuses outright if the audio graph will not open at 24 kHz rather than streaming at the
  wrong rate, which would arrive at half speed and read as a provider fault.

  Capture uses `ScriptProcessorNode` rather than an `AudioWorklet`: a worklet module must be fetched from a
  `blob:` URL, which a page's Content-Security-Policy can refuse, and the desktop app demonstrably has one.
  Deprecated and higher-latency — a disclosed trade to revisit once that policy has been read.

  There is no UI surface yet; the client publishes itself on `globalThis.__dshRealtimeAudio` with
  `start`/`stop`/`state`.

## [0.2.1] — 2026-10-08

### Fixed

- **`dsh-realtime-replay` was left behind at 0.1.1, which made every install contain two versions of
  the seam.** Its `dsh-realtime: ^0.1.1` requirement is, on a 0.x package, minor-locked — `^0.1.1`
  means `>=0.1.1 <0.2.0` — so it could not see `dsh-realtime@0.2.0`, and the resolved tree carried both.
  Two copies of a service package is the duplicate-instance failure this project has already been bitten
  by: one copy registers, the other is asked. The replay is now 0.2.0 against the 0.2.x seam, and the
  bundle's requirement moves with it.

  Found by **installing** the published bundle, not by reading the repository: every manifest, tag and
  check was correct, and only the resolved dependency tree was wrong.

## [0.2.0] — 2026-10-08

### Added

- **A failure taxonomy on the realtime seam.** `REALTIME_ERROR_CODES` gains `NOT_CONFIGURED`,
  `CREDENTIAL_REJECTED`, `NOT_ENTITLED`, `INSUFFICIENT_CREDIT`, `RATE_LIMITED`, `PROVIDER_TIMEOUT`,
  `NETWORK`, and `RealtimeError` carries an optional structured `detail` —
  `{ remedy?, setting?, retryable?, providerCode? }` — so a consumer can act on a failure rather than
  interpret its prose. Purely additive: `MISSING_CREDENTIAL` remains exported and no existing code
  changed meaning, per the file's own contract.

### Changed

- **An absent credential is `NOT_CONFIGURED`, not `MISSING_CREDENTIAL`.** One code had meant *absent
  or unusable*, which are a setup state and a failure with opposite responses. The error now names
  the setting and carries a remedy written to be relayed verbatim.
- **The provider's own error code is classified, not paraphrased.** It was previously preserved only
  inside the human-readable message, so `invalid_api_key`, `insufficient_quota` and
  `rate_limit_exceeded` all arrived as `PROVIDER_ERROR`. They now map to `CREDENTIAL_REJECTED`,
  `INSUFFICIENT_CREDIT` and `RATE_LIMITED` respectively, each with a remedy and a `retryable` flag.
  An unrecognised code deliberately keeps `PROVIDER_ERROR` — guessing a class is worse than admitting
  we do not know which one it is.
- **A provider that goes silent is `PROVIDER_TIMEOUT`, not `PROVIDER_ERROR`.** An unacknowledged
  append and a reported failure were indistinguishable to a caller branching on `code`.
- **A session opening the provider refused is classified** through the same translator, so a present
  but wrong key surfaces as `CREDENTIAL_REJECTED` rather than a generic failure.
  These were found by installing through the DeepSeek Harness plugin portal and then using it with no
  credential configured. The plugin loaded correctly; how it *failed* was the defect.

### Removed

- **`voice_say`.** It could never succeed. The tool promised unprompted speech and was implemented with
  the delegation-less form of `commentary.append`, which this provider does not acknowledge — so every
  call waited the full acknowledgement bound and then failed, on every fresh session. A tool the model
  will reliably call and that cannot work is worse than no tool, and the bridge already answers
  delegations automatically, so a manual "say this" tool had no remaining job either.

  Unprompted speech is not available in client delegation at all: `response.item.create` requires
  Responses mode, and the delegation mode is fixed at session creation. Delivering it means changing
  how delegations are delivered — an architecture decision, not a tool.

### Changed

- **A delegation-less context append no longer awaits an acknowledgement that cannot arrive.** The
  provider acknowledges an append only when it answers a delegation; a session-wide append is accepted
  in silence. Awaiting an ack for that form burned the whole bound and then reported a timeout about a
  frame the provider had already taken. It now resolves on the write, and the seam documents it as
  best-effort: applied once audio has flowed, at a time this seam cannot confirm.

## [0.1.3]

### Fixed

- **`@deepseek-ai/dsh-tools` is a `dependency`, not a `peerDependency`.** The consumer imports
  `defineTool` from it, and a peer is resolved from the *consumer's* `node_modules`. Under pnpm's strict
  layout a plugin installed into a profile cannot reach a package that only the profile's bundles
  declare — so the import failed and the row could not load. It is now installed into the package's own
  tree, where resolution does not depend on the host's layout. Safe because `defineTool` is a pure
  function returning a plain object: a second copy carries no shared state and no service identity.

  Found by installing through the DeepSeek Harness plugin portal, which runs pnpm. **Every verification
  we had ran npm, and npm installs peers automatically** — so the missing peer was invisible until a
  package manager that does not do that ran the install. Verify with the package manager the consumer
  uses, not the one that is convenient.

## [0.1.2]

### Added

- **`dsh-realtime-agent`** — the consumer the seam was missing. It holds a session, records the
  conversation, and answers what the voice model delegates. A delegation carries metadata only and no
  task text, so the request carries the transcript alongside it: the consumer knows the conversation,
  only the application knows its own state, and the request hands one to the other.

  Responders register on the Cordis bus and are dispatched with `serial` semantics, so several can be
  registered and the first to return a non-empty answer wins. Every other outcome — a decline, a
  responder that throws or rejects, no responder at all, or no answer inside the bound — is delivered
  to the model **out loud** rather than as silence or an invented answer. That is the seam's
  fail-closed invariant made audible.

  Shipped as a third row in the bundle, with `autoStart: false` so mounting the bundle cannot by
  itself open a socket or spend credit.

- **Voice tools** — `voice_start`, `voice_stop` and `voice_say`, so an agent can be heard rather than
  only heard *from*. `voice_say` throws when no session is open, naming the fix: a tool-thrown failure
  is the registry's own failure channel, and reporting it as a returned value would leave the model
  believing it had spoken when nothing was said.

## [0.1.1]

### Fixed

- **Source maps now resolve.** `sourceMap` and `declarationMap` were on, but `files` excluded `*.map`,
  so every published `.js` and `.d.ts` ended with a `sourceMappingURL` pointing at a map that was not
  in the tarball — and those maps referenced `../src/*.ts`, which was not published either. The
  packages now ship `lib` **and** `src`, and expose `./src/*`, so consumer tooling can step into the
  real source instead of following a dead reference.

  Found by installing the published packages from the registry and diffing them against the build.
  Nothing failed to install, typecheck, or run: the references were simply dead, which is exactly the
  class of defect that only an install-and-inspect pass catches.

## [0.1.0]

First release. Verified against the live GPT-Live-1 API rather than against documentation.

### Added

- **`dsh-realtime`** — the realtime capability seam. Registers a `realtime` service with a provider
  registry, per-route adapter registration, and session lifecycle. It deliberately refuses to own
  turn-taking, endpointing, or an auto-answer path for a delegation.
- **`dsh-realtime-openai`** — the GPT-Live-1 adapter, split into wire types, transport, translation
  and the adapter class. Client delegation only; results return through
  `session.commentary.append` (spoken) or `session.thinking.append` (silent).
- **`dsh-realtime-replay`** — a keyless backend that plays a recorded session through the real adapter
  and session, so conformance runs in CI with no credential and no network. The replay server answers
  the client's context appends itself, because a recording cannot contain an answer to a request that
  had not been made when it was recorded.
- **`dsh-openai-live`** — the bundle: a `cordis.patch.yml` mounting the seam and the adapter, plus the
  three packages as dependencies.
- A **protocol drift canary** (`pnpm canary`), scheduled, that asserts the provider's handshake shape
  and — via the vocabulary the endpoint enumerates when it rejects an unknown client event — that
  every client event this project sends is still supported.
- Documentation measured from live sessions: `docs/protocol.md`, `docs/design.md`,
  `docs/decisions.md`, `docs/w1-entitlement-probe.md`, `docs/w1-delegation-envelope.md`.

### Security

- `.gitignore` committed before the first tracked file; the full history is secret-scanned in CI.
- The credential error **names the setting and never the value**. No credential reaches a log, a
  fixture, a commit, or a published tarball.

### Notes

- Verified: `session.input_audio.commit` **does not exist**. Endpointing belongs to the engine, so the
  seam refuses to invent a turn boundary.
- Verified: the two delegation modes are fixed at session creation. `response.item.create` is rejected
  under client delegation, and client delegation has no `response.*` path at all.
- `gpt-realtime` carries a published sunset date; `gpt-live-1` does not.

[Unreleased]: https://github.com/Travizm/dsh-openai-live/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Travizm/dsh-openai-live/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Travizm/dsh-openai-live/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Travizm/dsh-openai-live/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Travizm/dsh-openai-live/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Travizm/dsh-openai-live/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Travizm/dsh-openai-live/releases/tag/v0.1.0
