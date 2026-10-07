# dsh-openai-live

**GPT-Live-1 full-duplex voice for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

> **Status: pre-alpha.** ✅ **W1 (protocol spike) PASSED 2026-10-07** — handshake, audio round-trip,
> transcripts, and the client-delegation envelope are all verified against the live API.
> See [`docs/w1-delegation-envelope.md`](docs/w1-delegation-envelope.md) and
> [`docs/w1-entitlement-probe.md`](docs/w1-entitlement-probe.md).
> Next: W2 (plugin skeleton). Not published. Not installable yet.

## Why this exists

DSH ships no full-duplex speech subsystem, and no plugin in the ecosystem implements
`gpt-live-1` — the only **live** (non-sunsetting) full-duplex voice model. The nearest existing
plugin, `dsh-realtime-voice`, targets the retiring `gpt-realtime` family at the wrong endpoint.
This plugin is the port that closes that gap, with the delegation envelope as its core domain
rather than an afterthought.

## Design

Two rows on one seam — a **provider** and a **consumer**:

| Row | Role |
|---|---|
| `openai-live` | Provider plugin. Owns the session with `gpt-live-1` over
`/v1/live/sessions`, the audio transport, and the **turn boundary**. |
| `openai-live-agent` | Delegation consumer. Consumes `session.delegation.created` and answers
with `response.event`, so a DSH agent can act mid-conversation. |

The runtime contract moves **v8 → v9** to carry the delegation event vocabulary.

## Non-negotiable properties

These are the invariants the design is held to. Each one exists because a specific failure was
identified during adversarial review, and each is intended to be **tested**, not asserted:

1. **Fail-closed delegation.** An unresolvable or erroring delegation **never** auto-approves.
2. **The provider owns the turn boundary.** Barge-in and turn-taking are decided in one place,
   not negotiated between rows.
3. **Credentials are a tested invariant, not a convention.** No credential may reach a log, a
   fixture, a commit, or a published tarball — proven by test, not by review.
4. **Keyless replay.** Conformance runs against recorded session fixtures and passes with **no
   API key present**, so CI can verify protocol handling without spend or secrets.
5. **Drift canary.** A scheduled check detects upstream contract changes rather than discovering
   them in production.
6. **No hand-rolled VAD.** Endpointing is delegated to the engine that owns it.

## Repo layout

```
dsh/            # the plugin: provider and consumer rows (W2+)
spike/          # W1 protocol spikes + recorded evidence
  evidence/     # raw probe output — the primary record
docs/           # design record and milestone results
```

## Roadmap

| | Milestone | State |
|---|---|---|
| W1 | Handshake + audio round-trip + delegation envelope proven | ⛔ blocked on credit |
| W2 | Plugin skeleton: two rows, contract v9, fail-closed delegation | not started |
| W3 | Conformance harness + keyless replay CI | not started |
| W4 | Secret-scan and provenance gates, drift canary | not started |
| W5 | Publication: GitHub → npm → marketplace | not started |

## Security

No credential is stored in this repository, and `.gitignore` is committed **before** the first
tracked file so that `.env`, `*.credentials.yaml`, `secrets/`, `*.pem` and `*.key` cannot be
added by accident. Secrets are read from the environment at run time and are never logged —
including on failure paths.

## Licence

MIT — see `LICENSE` (to be added at W2).
