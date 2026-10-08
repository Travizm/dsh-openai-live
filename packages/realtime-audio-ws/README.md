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

## What it does not do yet

**There is no browser face.** This is the host end only: nothing here opens a microphone or plays audio.
The client half — `getUserMedia` → 24 kHz PCM16 → this socket, and playback the other way — is the next
increment, and it is where a device, a permission prompt and a human come in.

**No format negotiation.** The client is expected to know the session's format from configuration. A
`ready` frame carrying sample rate and channel count would be the natural first control message, and it is
deliberately absent rather than half-built.
