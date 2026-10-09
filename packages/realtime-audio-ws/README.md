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

Binary frames carry audio, both directions, in the session's declared input/output format (PCM16, 24 kHz,
mono, for the shipped adapter). **Text frames carry control:**

| Frame | Answer |
|---|---|
| `status` | this route, the live voice, every setting, the journal's last entry |
| `start` | the session that opened — an outcome, not an acknowledgement |
| `stop` | the state afterwards |
| `steer <sessionId>` | the setting that declares a live `sessionId`, changed |
| `set <key>=<value>` | the setting named by its `<owner>.<field>` key, changed |

One frame in, exactly one frame out, and **every** frame is answered — a verb it does not have, an argument
where none belongs, a field frozen by its class, a value the setting's own rules reject. The reply is JSON:
`{"ok":true,…}` with the fields for that verb, or `{"ok":false,"verb":…,"code":…,"reason":…}` with a reason
written to be relayed verbatim. `set realtime-agent.autoStart=true` answers with the *restart* it needs
rather than a silence that reads as a broken control.

This was a deliberate widening of a contract that used to say the opposite — a text frame was ignored,
because nothing on this wire was JSON. The socket is the only duplex connection the client already holds,
one text frame in / one text frame out is smaller than a second route with its own authentication, and the
audio path is untouched: the two are told apart by the frame's own type.

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

`openSessionOnConnect` (default `true`) is **live**: read at the moment an authenticated client connects
and at the moment the last one leaves, so the seam's settings surface turns it off and on without a
restart — `set realtime-audio-ws.openSessionOnConnect=false`. Freezing it was the failure this plugin's
own docs describe: with it off and no way to change it, a working microphone produces silence that looks
like a fault anywhere but in the config. The rest of this row's fields (`path`, `maxFrameBytes`,
`maxConnections`, `diagnosticsPath`) are claimed against the web server's registry or enforced by the
socket at load, so they are restart-bound and get no control.

## Where it waits

This row appears **unloaded** in a composition without the web server and connection services, and that is
the intended behaviour: its fiber waits until they exist, so a profile with no web stack shows a row that
visibly waits rather than one that loads and silently claims nothing. The bundle-patch test pins it, and
`tests/plugin.spec.ts` proves the functional path against a real socket with both services present.

## The client half

`dsh-realtime-audio-ws/client` is the browser face: it opens this socket, captures the microphone into it at
24 kHz PCM16, plays what comes back, and drives the strip. No client services, one file.

**How it runs.** The strip in the app's own page is the way in — it is mounted by the injected row and by
the bundle itself, whichever lands second finding the panel already there:

```
[ microphone: idle ] [ Connect microphone ] [ Refresh ]
voice: open · fake/gpt-live-1
realtime-responder.sessionId   [ sess-1 ▾ ] [ Steer ]      applied
realtime-responder.answerTimeoutMs  [ 45000 ] [ Set ]
realtime-agent.model           fixed when the session opens — reconnect to apply
```

A live field gets a control, a session-bound field gets the value it will take plus the words "reconnect to
apply", and a restart-bound field gets no row at all — a control the protocol cannot honour is worse than no
control. Every `set` reports its outcome beside the field it belongs to, and a refusal is relayed verbatim
with the host's own code: `FROZEN_SETTING: "…" is claimed when the plugin loads — restart to change it`.

The same handle stays published on `globalThis[GLOBAL_KEY]` for the injected bootstrap and for anything else
that holds it — `start`, `stop`, `state`, `request`, `mount` — but it is no longer the on-switch:

```js
__dshRealtimeAudio.start()            // asks for the microphone, then connects
__dshRealtimeAudio.state()            // { kind: 'idle' | 'live' | 'failed' }
__dshRealtimeAudio.request('status')  // one text frame in, exactly one reply out
```

`start()` **reports rather than throws**, so a refused permission or a missing API arrives as
`{ kind: 'failed', reason }` — the reason is what tells someone whether to grant something or to look
somewhere else.

**Requests are serialised.** One frame is in flight at a time: the host answers in arrival order, and two
frames out at once would make pairing a reply with its request a guess the moment anything on the host
slowed down. A request with no socket is a rejection — reporting `{ok: false}` there would be
indistinguishable from the host refusing.

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

**No format negotiation, and no reconnect.** A `ready` frame carrying sample rate and channel count is the
obvious next control *frame* — the control channel is now there to carry one — and a dropped socket still
ends the conversation rather than being rejoined. Both are deliberately absent rather than half-built.

**The panel has no keyboard path and no permissions row.** The strip is clickable controls and text, so a
screen reader gets it, but nothing focuses it and the microphone's permission state is reported rather than
requested ahead of time. Both are increments, not gaps in the channel.
