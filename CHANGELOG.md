# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Travizm/dsh-openai-live/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Travizm/dsh-openai-live/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Travizm/dsh-openai-live/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Travizm/dsh-openai-live/releases/tag/v0.1.0
