# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
