---
title: "P5 — the Deepgram adapter's live run"
status: active
version: 1.0.0
created: 2026-10-17
domain: architecture
author: Travis Driessen (run by Tara at the CEO's instruction)
evidence: scripts/deepgram-session-smoke.mjs, 2026-10-17
---

# P5 — the Deepgram adapter's live run

The first session the adapter opened against the real provider. It passed — after it failed twice, and **both
failures were invisible to 90 unit tests** because the tests used a fake socket that behaved more politely than
a real one.

## Result

```
established  1159 ms · provider=deepgram model=gpt-4o-mini voice=aura-2-thalia-en
audio        66 frame(s), 63360 bytes
transcripts  output: Say exactly: probe one.
PASS — settings accepted, injected line spoken, audio returned through the adapter
```

63,360 bytes at 24 kHz linear16 is ≈1.32 s of speech: the agent said the line it was asked to say, and the audio
came back through `transport → handlers.onAudio`. So the whole chain — Settings accepted, injection, TTS,
binary routing — works against the real thing.

## What the live run found that the tests could not

| # | Defect | Why the fakes missed it | Fix |
|---|---|---|---|
| 1 | The session sent `Settings` on a socket that was still `CONNECTING`, and `ws` **throws** on send before open. | The fake accepted writes whenever it was asked. | The transport buffers frames and flushes them in order on `open`. |
| 2 | The transport classified **every text frame as audio**: `ws` delivers a text frame as a `Buffer`, a `Buffer` **is** a `Uint8Array`, and the type check could not tell them apart. The session connected, received everything, and waited 20 s for an acknowledgement it had already been given. | The fake emitted strings for text, so the ambiguous case never occurred. | The `isBinary` flag is the authority; the type is only a fallback for sockets that do not pass one. |

Both are the same class of failure: **a fake that is more generous than reality hides the real contract.** The
lesson is not "test more" — it is that a fake socket has to model the two properties that actually bite, namely
*not being open yet* and *not telling text from bytes by type*. Both are now pinned by tests written from the
live failure, and the smoke script exists so the next person can re-run it.

## The inbound half — real speech in

`scripts/deepgram-input-smoke.mjs` streams a WAV through `session.sendAudio` in 20 ms frames — the pacing a capture
device produces, not one burst — with trailing silence so the provider's end-of-turn detector has something to
detect. First run:

```
heard        input: What's the weather?
answered     output: Please provide your location for the weather report.
audio        72000 bytes back
```

So the loop is proven in both directions: speech in through the seam, transcribed by the provider, answered by
the LLM, spoken back as 72,000 bytes (≈3 s at 24 kHz). The fixture is
`packages/realtime-deepgram/fixtures/whats-the-weather.wav` — 16 kHz mono 16-bit, the format the Settings declare,
because a mismatched file is a session that hears noise and reports nothing.

## Barge-in — interrupting the agent mid-sentence

`scripts/deepgram-barge-in-smoke.mjs` asks the agent to count slowly to twenty, waits until it is audibly mid-line,
then streams the user's speech into the socket.

```
detected   770 ms after the first frame of user speech
window     600 ms before detection: 80640 bytes · 600 ms after: 0 bytes
turns      "What's the weather?" · "Please specify a location for the weather update."
```

Three things follow, and the middle one is the measurement that matters:

- the provider **registers** speech during its own turn — 770 ms after the first frame of it;
- its audio **stops dead** at that moment: 80,640 bytes in the 600 ms before detection, **zero** in the 600 ms
  after. Truncation, not talking over;
- the interruption **becomes a turn** of its own, with the new question answered.

An earlier version of this script compared total bytes before and after the interruption and reported "the agent
kept speaking", which was wrong: a total cannot distinguish *stopping* from *finishing the sentence and then
answering*. The window measurement is the one that separates them, and it is the only reason the result is a
finding rather than an impression.

## What still is not proven

- **A live microphone.** The WAV proves the seam's `sendAudio` path and the provider's STT; a real capture device
  additionally exercises frame pacing under load and device resampling, neither of which a file can show.
- **Interruption / barge-in.** Nothing here speaks while the agent is speaking, so `UserStartedSpeaking` mid-turn
  and any truncation behaviour remain unexercised.
- **Prompt updates.** `promptUpdate` remains `'unknown'` — the replace-vs-append question this pathway has been
  carrying since P1. The cheapest remaining route is to point `UpdateThink` at the delegate shim (which now
  exists, P4) through a public URL and read the prompt the provider sends.

## Reproduce

```bash
set -a; . ./.env; set +a
pnpm build
node scripts/deepgram-session-smoke.mjs
```

Self-skips and exits 0 without `DEEPGRAM_API_KEY`, so a fork stays green. Exit 2 = the session never
established; exit 1 = established but no audio.
