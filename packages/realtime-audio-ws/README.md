# dsh-realtime-audio-ws

The host end of the client half's transport: a WebSocket upgrade route that bridges microphone audio in and
the agent's speech out.

It owns no audio logic and no session. It claims one path on the harness web server, authenticates the
caller, and connects that socket to the two bus events `dsh-realtime-agent` already carries —
`realtime-agent/mic` inbound, `realtime-agent/audio` outbound.

## Why an upgrade route, and not a Remote

Because a third-party plugin **cannot add a Remote**. The Remote assembly mounts a fixed, build-time set of
capabilities inside a DeepSeek-owned package — *"Additional capabilities require an explicit `/remote`
value import and mount in this assembly"* — and registration additionally needs generated
`typert.host` / `typert.remote-client` artifacts from the harness's own build. None of that is available to
a plugin shipped on npm.

The web server is the door that is open. Its own README describes it as *"a plain route registry with no
harness vocabulary"* where **other plugins register named routes**, and `registerUpgrade(route)` hands a
plugin an exact-path upgrade route plus the raw socket. So this is a supported extension point, not a
private API being leaned on.

It registers with `noServer: true` deliberately: a listening `ws` server would bind a second port and
bypass the route registry that makes this plugin lawful in the first place.

## Authentication is not optional here

Upgrade requests **never reach the web server's HTTP route handlers** — the server matches upgrades in a
separate table, and unmatched ones are simply closed with no HTTP response. So no auth gate answers them,
and a plugin's route would be an unauthenticated endpoint on loopback carrying the user's microphone in and
the agent's answers out.

The handler therefore asks the connection service, in the same position DSH's own transport asks it:

```ts
const rejection = services.connection.requestRejection(req)
if (rejection !== undefined) { rejectUpgrade(socket, rejection); return }
```

`rejectUpgrade` writes the same bytes DSH's transport writes for the same refusal, so a client cannot tell
this route's rejection from the gateway's. There is no second authentication scheme here to drift from the
first — which is the only reason to trust it.

## The wire

Binary frames only, both directions, in the session's declared input/output format (PCM16, 24 kHz, mono, for
the shipped adapter). A text frame is ignored rather than fatal: nothing on this wire is JSON.

Frames are forwarded, never queued. A client that cannot keep up drops audio instead of accumulating it,
which matches the `realtime-agent/audio` contract — a queue that grows while nothing drains it presents
first as latency and then as an unbounded allocation.

A frame larger than `maxFrameBytes` closes the connection with 1009 rather than being truncated.

## Configuration

| Field | Default | Notes |
|---|---|---|
| `path` | `/dsh-realtime/audio` | Absolute, no trailing slash. Registered exactly, so a collision with another route throws rather than shadowing. |
| `maxFrameBytes` | `480000` | Ten seconds of 24 kHz mono PCM16. Above this the connection is closed with 1009. |
| `maxConnections` | `1` | A second connection is closed with 1013 rather than queued. One microphone is the honest default. |

## Where it waits

This row appears **unloaded** in a composition without the web server and connection services, and that is
the intended behaviour: its fiber waits until they exist, so a profile with no web stack shows a row that
visibly waits rather than one that loads and silently claims nothing. The bundle-patch test pins it, and
`tests/plugin.spec.ts` proves the functional path against a real socket with both services present.

## The client half

`dsh-realtime-audio-ws/client` is the browser face: it opens this socket, captures the microphone into it at
24 kHz PCM16, and plays what comes back. No client services, one file, and it injects nothing — a client
face that needs nothing cannot be broken by another plugin's absence.

**How it runs.** There is no UI surface yet, so it publishes itself on a global:

```js
await __dshRealtimeAudio.start()   // asks for the microphone, then connects
__dshRealtimeAudio.state()         // { kind: 'idle' | 'live' | 'failed' }
__dshRealtimeAudio.stop()
```

`start()` **reports rather than throws**, so a refused permission or a missing API arrives as
`{ kind: 'failed', reason }` — the reason is what tells someone whether to grant something or to look
somewhere else. A settings card is its own increment.

**Two decisions inside it worth knowing.**

`ScriptProcessorNode`, not an `AudioWorklet`. A worklet module must be fetched from a URL — a `blob:` URL,
which a page's Content-Security-Policy can refuse, and the desktop app demonstrably has a CSP. A processor
node needs no module fetch, so it works anywhere and the whole capture path stays testable. It is
deprecated and its latency is worse: a disclosed trade, to revisit once the app page's `script-src` has
actually been read rather than assumed.

**It refuses rather than mislabels the sample rate.** 48 kHz samples declared as 24 kHz arrive at half speed
and read as a provider fault — the most expensive possible way to discover a missing resampler. If the graph
will not open at 24 kHz the client fails and says which rate it got.

## What it does not do yet

**No format negotiation, and no reconnect.** A `ready` frame carrying sample rate and channel count would be
the natural first control message; a dropped socket currently ends the conversation rather than being
rejoined. Both are deliberately absent rather than half-built.
