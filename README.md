# dsh-openai-live

**GPT-Live-1 full-duplex voice for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

> **Status: pre-release.** Verified against the live API, not against documentation. 168 tests, a
> per-file 100% coverage gate that is enforced rather than reported, and a built-artifact smoke that
> runs the published output under plain `node`. Not yet published to npm.

## Why this exists

DeepSeek Harness ships no full-duplex speech subsystem at all, and no plugin in the ecosystem
implements `gpt-live-1` — the only live, non-sunsetting full-duplex voice model. The nearest existing
plugin targets the retiring `gpt-realtime` family at a different endpoint with a different event
vocabulary. This is that port.

The interesting part is not the audio. It is that the model can **delegate**: mid-conversation it
raises a task for the host agent and waits to be answered, without stopping the conversation. Getting
that envelope right — and failing closed when it cannot be answered — is the domain of this project.

## The seam, not a monolith

Three packages, mirroring how DSH itself models `ctx.llm`:

| Package | Role |
|---|---|
| **`dsh-realtime`** | The **seam**. Registers the `realtime` service; owns providers, routes, and session lifecycle. Deliberately refuses to own turn-taking, endpointing, or any auto-answer path for a delegation. |
| **`dsh-realtime-openai`** | The **GPT-Live-1 adapter**. Wire types, transport, translation, and the session — four separable layers, with the translation layer pure and tested against recorded frames. |
| **`dsh-realtime-replay`** | The **keyless backend**. Plays a recorded session through the *real* adapter and session, so conformance runs in CI with no credential, no network, and no spend. |

A fourth package, **`dsh-openai-live`** (this repo's root), is a bundle: it carries the
`cordis.patch.yml` that mounts the two rows above and depends on all three.

## Install

```bash
dsh plugin --profile <name> add dsh-openai-live      # once published
dsh --profile <name> --dump-config                   # composes?
dsh --profile <name> web
```

Then supply the credential **from the environment** — it is a validated config field, never a file
this code reads:

```bash
export OPENAI_LIVE_API_KEY=…
```

A profile composes fine *without* one. The route registers, and opening a session fails with
`MISSING_CREDENTIAL` — an error that **names the setting and never the value**. That is deliberate: an
unconfigured machine should boot and then say precisely what is missing, rather than break the harness
at startup.

## Properties held to, and tested

1. **Fail-closed delegation.** An unresolvable or erroring delegation never auto-approves.
2. **The provider owns the turn boundary.** There is no hand-rolled VAD, and the seam refuses
   end-of-utterance calls outright — `session.input_audio.commit` *does not exist* in the API, which
   the server itself confirmed by enumerating its vocabulary.
3. **Credentials are a tested invariant, not a convention.** The credential error names the setting.
   No value reaches a log, a fixture, a commit, or a published tarball.
4. **Keyless replay.** The full conversation path is exercised with no API key present.
5. **Drift canary.** A scheduled check fails loudly when the provider changes shape, so the first
   signal is a red build rather than a user bug report.
6. **Appends resolve on the provider's acknowledgement**, correlated on the echoed `client_event_id`
   with a **FIFO fallback** — an undocumented echo must degrade to ordering, never to a hung promise.
7. **Usage is cumulative**, so a consumer replaces its figure rather than adding to it. The same value
   legitimately arrives twice, on `session.usage.updated` and again on `session.closed`.
8. **Every registry proves disposal** — a contribution is made from a child fiber, that fiber is
   disposed, and the contribution is observed gone.

## Verified against the live API

The `docs/` directory is the primary record. Everything in it was measured, and the traps each cost a
run:

| Document | What it holds |
|---|---|
| [docs/protocol.md](docs/protocol.md) | GPT-Live-1 over WebSocket: the full client and server vocabulary, the delegation envelope, audio formats, and the traps |
| [docs/design.md](docs/design.md) | architecture, scope, session lifecycle |
| [docs/decisions.md](docs/decisions.md) | ADRs — why client delegation, why a seam, why this repo is non-governed |
| [docs/w1-entitlement-probe.md](docs/w1-entitlement-probe.md) | entitlement, and why a zero balance is not an entitlement failure |
| [docs/w1-delegation-envelope.md](docs/w1-delegation-envelope.md) | the two delegation modes, measured |

## Working on it

```bash
pnpm install
pnpm gate      # build → typecheck (src AND tests) → coverage gate → built-artifact smoke
pnpm canary    # live drift check; self-skips without OPENAI_LIVE_API_KEY
```

The gate enforces **per-file 100% statements, branches, functions and lines**. That is enforced with
`perFile: true`, and the enforcement was proven to bite: one injected uncovered branch exits 1 naming
the file and each axis. Beyond unit tests there are two tiers a change cannot skip — a real
**composition** test that boots a `cordis.yml` through the actual Loader, and a **built-artifact**
smoke that runs the published `lib/` under plain `node`.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

No credential is stored in this repository. `.gitignore` was committed **before** the first tracked
file, and the full history is secret-scanned in CI — a secret removed in a later commit is still
published. Report a vulnerability per [SECURITY.md](SECURITY.md).

## Licence

MIT — see [LICENSE](LICENSE).
