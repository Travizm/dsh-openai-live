# dsh-realtime-replay

**Keyless replay for the [`dsh-realtime`](../realtime) seam.**

A function plugin that registers a provider route backed by a **recorded session** instead of a live
one, so CI can exercise the whole realtime path with **no credential and no network**.

## Why this exists

A test suite that needs a live key cannot run on a fork, cannot run on a contributor's machine, and —
as this project demonstrated within hours of starting — stops entirely when the provider account's
credit balance hits zero. A gate that a billing event can switch off is not a gate.

## How it works: a replay *server*, not a player

The recording supplies the provider's side of the conversation. It cannot supply the client's side,
because a recording captures one direction of one conversation and therefore cannot contain an answer
to a request that had not been made when it was recorded.

So the replay transport does two things:

1. **plays** the recorded server frames, in order, on a macrotask — never synchronously, because a
   real provider speaks only after the client addresses it;
2. **answers** the client's context appends itself (`instructions` / `thinking` / `commentary`),
   echoing the correlation id, from an exact map of acknowledged events.

Audio appends are **not** answered. A suffix test would have invented `session.input_audio.appended`
— an event that does not exist — and a replay server that fabricates plausible events is worse than
no replay server at all.

**What it verifies is the shipping code.** Not a fake adapter: the real handshake, the real
translation, the real append correlation, the real teardown. The only thing replaced is the origin of
the bytes.

## Configure

```yaml
- name: dsh-realtime-replay
  config:
    fixture: ./recordings/staging-session.jsonl
```

| Field | Default | Notes |
|---|---|---|
| `fixture` | *required* | A recording; read at compose time so a missing or malformed one fails **at boot**, naming the file and line. |
| `provider` | `replay` | The route registered on the seam. |
| `baseURL` | `wss://replay.invalid/…` | Recorded but never dialled. The `.invalid` TLD cannot resolve, so replay can never be mistaken for a live profile. |
| `model` / `voice` | `gpt-live-1` / `marin` | Reported in the session facts. |
| `appendAckTimeoutMs` / `establishTimeoutMs` | `5000` | Bounds; tighter than a live profile because nothing here waits on a network. |

**No credential is accepted.** The transport never transmits, so a real key in a replay profile would
be a secret with no purpose and one more place to leak from.

## Recording format

JSONL, one `{t, event}` row per server frame — the raw output of a recording run, not a distilled
fixture. A distilled format would need its own translator, and the translator would be a second place
for the provider's vocabulary to drift.

```
{"t":0,"event":{"type":"session.started","session":{"model":"gpt-live-1",…}}}
{"t":300,"event":{"type":"session.input_transcript.delta","delta":"check staging"}}
{"t":900,"event":{"type":"session.delegation.created","delegation":{"id":"item_1","target":"client"}}}
```

The repository's own recordings are produced by the W1 spike, which writes exactly this shape; see
[`docs/protocol.md`](../../docs/protocol.md).

## What it does not do

- **No timing fidelity.** Frames are delivered in recorded order without pacing, so a CI assertion
  about ordering never depends on wall-clock timing. `t` is retained for a future paced mode.
- **No reconnection, no mid-session failures.** One recording is one conversation.
- **No Responses-mode replay.** This plugin replays the client-delegation path, which is the path the
  shipping adapter uses.
