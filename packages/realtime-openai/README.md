# dsh-realtime-openai

**GPT-Live-1 full-duplex voice for the [`dsh-realtime`](../realtime) seam.**

A function plugin that registers one provider route — `openai-live` by default — on the realtime seam
and drives it over the OpenAI Live WebSocket API.

> **Status: pre-alpha.** Verified against the live API: handshake, PCM16/24 kHz audio round-trip,
> both transcript directions, and the client-delegation envelope. Not published.

## Configure

```yaml
- name: dsh-realtime-openai
  config:
    apiKey: !!js process.env.OPENAI_LIVE_API_KEY   # the composition supplies it; this package never reads a key file
    voice: marin
```

| Field | Default | Notes |
|---|---|---|
| `apiKey` | *none* | Absent is legal: the profile still composes, and a session request fails with a coded error naming the **setting**, never the value. |
| `baseURL` | `wss://api.openai.com/v1/live/sessions` | Overridable for a proxy or a replay server. |
| `provider` | `openai-live` | The route registered on the seam. |
| `model` | `gpt-live-1` | |
| `voice` | `marin` | |
| `appendAckTimeoutMs` | `10000` | Bound on waiting for a context-append acknowledgement. |
| `establishTimeoutMs` | `20000` | Bound on waiting for `session.started`. |

## The delegation path

This adapter opens sessions in **client delegation** mode, because DSH is an external agent: the
harness runs the work and returns the result. The result travels back through
`session.commentary.append` (**spoken aloud**) or `session.thinking.append` (**silent context**),
each carrying the `delegation_id` from `session.delegation.created`.

**The `response.*` family is not used and is not valid here.** `response.item.create` and
`response.create` require *Responses* delegation — a different mode, where OpenAI runs the backend
itself. Switching modes requires a new session. If a Responses-mode row is ever wanted, it is a
separate capability, not a flag on this one.

## What the adapter deliberately does not do

- **No client-side endpointing.** There is no `session.input_audio.commit` builder because the event
  does not exist. Endpointing belongs to the provider; a second detector would be a competing turn
  boundary.
- **No auto-answer for delegations.** A delegation reaches the consumer and the consumer decides.
  There is no default path that resolves work the application has not authorised.
- **No session resumption.** `model`, `instructions` and `audio.output.voice` are fixed at startup
  and the delegation mode cannot change; offering `resume` would advertise what the wire cannot honour.
- **No invented task text.** A delegation carries an id, a target and an offset — no request text.
  Intent is reconstructed from the transcript plus application state, and nothing here guesses.

## Behaviour worth knowing

- **Appends resolve on the provider's acknowledgement**, not on the send. Correlation prefers the
  echoed `client_event_id` and **falls back to the oldest outstanding append of that kind**, because
  that echo is not documented and a missing correlation must degrade to FIFO rather than to a hung
  promise.
- **An acknowledgement of one kind never settles an append of another.**
- **A bounded handshake.** A socket that opens and never confirms is thrown, not left looking healthy.
- **A failed connect clears the establishment timer**, so no bound outlives its operation.
- **Unusable payloads on known frame types are ignored**, not thrown: provider noise must not become
  an outage. The drift canary is what turns "ignored" into "noticed".
- **Usage is cumulative, not incremental.** Every `session.usage.updated` and the final figure on
  `session.closed` report the running total, so a consumer must **replace** its figure rather than add
  to it. The same value can legitimately arrive twice, and summing would double-count.

## Verification

Against a **recorded live session** (`tests/fixtures/live-session.jsonl`, 26 server frames captured
from a real `gpt-live-1` session) — so the translation layer is checked against what the provider
actually sent, with no key and no network. That is the keyless-replay contract in practice; see
[`dsh-realtime-replay`](../realtime-replay) for the CI-shaped version.

Transport is exercised against a local WebSocket server: real integration, no egress.

## Known limitations and deferred work

- **Append bounds are characters, not tokens.** The provider's limit is 500 tokens; counting them
  exactly would bind this package to a tokenizer it does not own, so the seam's conservative
  character bound is used instead.
- **The model catalogue is advisory** and lists the configured model only, rather than spending a
  request to discover. Absence from a catalogue never gates a session.
- **The output transcript carries no finality flag.** The wire signals the end of an utterance by
  stopping, so every delta is reported non-final; a consumer that needs utterance boundaries must
  derive them from the provider's own endpoints.
