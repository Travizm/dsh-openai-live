# Second-provider spike: is the seam neutral, or OpenAI-shaped?

S2's pulled-forward spike (Q8). The question is narrow and consequential: **our provider-neutral seam
was designed against exactly one protocol.** Replay proves another implementation can reproduce *the
same* vocabulary, which is weak evidence about an independently designed API. So: read two, from their
official documentation, and see which of our design decisions were *protocol* and which were *vendor*.

**Verdict up front: four of them were vendor.** The seam is OpenAI-shaped in ways that would force a
second adapter to drop information the provider actually sends. None of the four is a rewrite; all four
are additions. Details in "What this means for the seam".

**Method.** Official documentation only, cited per claim, and the two load-bearing findings verified
in the source text rather than from a summary: Gemini's interruption event (`server_content.interrupted`
in Google's own code sample) and its cancellation of pending function calls (quoted verbatim below).

## Profiles

### Google Gemini Live API

- **Endpoint.** `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
- **Auth.** API key as a `key` query parameter; ephemeral tokens (`BidiGenerateContentConstrained`,
  `access_token`) for client-side use, minted via `AuthTokenService.CreateToken`.
- **First message is `setup`** — model, `generationConfig.speechConfig.voiceConfig`, `systemInstruction`,
  `tools[]`, `realtimeInputConfig.automaticActivityDetection` — and the client must await
  `setupComplete` before sending anything else.
- **Client events:** `setup`, `clientContent`, `realtimeInput`, `toolResponse`.
- **Server events:** `setupComplete`, `serverContent`, `toolCall`, `toolCallCancellation`, `goAway`,
  `sessionResumptionUpdate`, `usageMetadata`.
- **Audio:** input 16-bit PCM 16 kHz; output 16-bit PCM 24 kHz. WebSocket frames.

*Sources: <https://ai.google.dev/api/live>, <https://ai.google.dev/gemini-api/docs/live-api/capabilities>, <https://ai.google.dev/gemini-api/docs/live-api/tools>*

### Deepgram Voice Agent API — the strongest *independently designed* alternative

- **Endpoint.** `wss://agent.deepgram.com/v1/agent/converse`
- **Auth.** `Authorization: Token <key>` on the upgrade; short-lived JWTs via `/v1/auth/grant` for clients.
- **Events:** client `Settings`, `Update*`, `InjectUserMessage`, `InjectAgentMessage`,
  `FunctionCallResponse`, `ForceEndTurn`, `KeepAlive`, binary audio; server `Welcome`,
  `SettingsApplied`, `ConversationText`, `UserStartedSpeaking`, `FunctionCallRequest`,
  `FunctionCallCancelled`, `InjectionRefused`, `AgentAudioDone`, `LatencyReport`.
- A unified STT + LLM + TTS loop over one socket: the host declares tools in `agent.think.functions`.

*Sources: <https://developers.deepgram.com/docs/voice-agent-architecture>, <https://developers.deepgram.com/docs/configure-voice-agent>, <https://developers.deepgram.com/docs/voice-agent-speculative-replies>*

### Survey: most "alternatives" are clones, which is the point

| provider | bidirectional audio + one session + tools | independently designed? |
|---|---|---|
| Gemini Live | yes | **yes** |
| Deepgram Voice Agent | yes | **yes** |
| ElevenLabs Conversational AI | yes | yes |
| Cartesia Line | yes | yes |
| AssemblyAI Voice Agent | yes | yes |
| xAI Grok Voice | yes | **no** — OpenAI Realtime-compatible vocabulary (`input_audio_buffer.append`, `response.create`) |
| Azure Voice Live | yes | **no** — documented as "designed for compatibility with the Azure OpenAI Realtime API" |
| Amazon Nova Sonic | yes, but over an AWS HTTP/2 eventstream, **not a WebSocket** | yes |
| DeepSeek | **no** — `api.deepseek.com` is OpenAI-compatible chat completions only; no realtime voice API |

**A clone is worthless as neutrality evidence.** Testing the seam against a provider that reproduces
OpenAI's event names would confirm the design against itself. That is why xAI and Azure are recorded
here and then excluded, and why the two profiled providers are the two that are genuinely different.

## The capability matrix

| | OpenAI Live (today) | Gemini Live | Deepgram Voice Agent |
|---|---|---|---|
| **external delegation** | `delegation.created`, metadata only | `toolCall` / `toolResponse` (or **async** `NON_BLOCKING` with scheduling) | `FunctionCallRequest` / `FunctionCallResponse` |
| **intent reconstruction** | **host reconstructs from transcript** — no task text in the call | **arguments arrive in-band** (`FunctionCall.name` + `args`) | **arguments arrive in-band** (`arguments` JSON string) |
| **progressive output** | `.appended` acks, cap on append size | `clientContent` mid-session; **`turn_complete=true` interrupts generation**; no per-append ack documented | `InjectAgentMessage` with `behavior: default\|queue\|interrupt`; `AgentAudioDone` ack; **`InjectionRefused`** on refusal |
| **interruption** | **no event at all** | **`serverContent.interrupted: true`** | **`UserStartedSpeaking`**, plus `TurnResumed` |
| **cancellation** | none — "interruption ≠ cancellation" | **discards pending function calls and sends their IDs** via `toolCallCancellation` | **`FunctionCallCancelled`** per call; `defer_until_eot` for side-effecting calls |
| **endpointing** | provider | provider (VAD configurable; client may take over) | provider (Flux EOT; `ForceEndTurn` to take over) |

The endpointing row is the good news: **all three hand turn detection to the engine**, so
`design.md`'s no-hand-rolled-VAD rule and the seam's "frames are the only input" hold universally. The
decision that looked most likely to be vendor-specific is the one that isn't.

## What this means for the seam

Four additions. Each is additive, and each one exists because a *second* provider sends information the
current shape has nowhere to put.

1. **A delegation must be able to carry a payload.** `RealtimeDelegation` is `{id, target, offsetMs}`
   with a docstring that says there is "deliberately no task text". Both other providers send the
   arguments. As designed, a Gemini adapter would have to *discard* them and our agent would reconstruct
   intent from the transcript for no reason — re-deriving what the provider already told us. Add an
   optional payload field; the existing adapter leaves it empty and nothing changes.
2. **The interruption event must exist on the seam.** S1's fault matrix asserts its **absence**, and
   that assertion is *correct for OpenAI and wrong as a general claim* — measured on one sample and
   stated as a property of the class. Add the event; the OpenAI adapter never emits it, and the matrix
   row becomes "this provider reports no interruption" rather than "the protocol has none".
3. **The seam needs a cancellation signal, and the agent a cancel path.** `design.md` invariant 7 —
   "interruption ≠ cancellation" — is true of OpenAI and false of both others. Gemini discards pending
   function calls and names their IDs; Deepgram cancels them per call. We have no way to receive that,
   so today a cancelled delegation would run to completion and answer into a turn nobody is listening to.
4. **An append needs both an acknowledgement *and* a refusal.** OpenAI acknowledges appends; Gemini
   documents no acknowledgement; Deepgram refuses with a reason. A seam that models only the
   acknowledgement cannot represent two of the three, and the refusal is the more useful of the two —
   it is the same "carry the reason" rule S1 applied to controller refusals, one layer up.

## Effect on the field matrix (`control-plane-fields.md`)

The bet survives, and one row gains a nuance. Gemini puts `voiceConfig` and `systemInstruction` in the
**`setup`** message and `setupComplete` is awaited before anything else — so `voice` and `instructions`
are session-bound there exactly as they are for OpenAI, which is the direction the matrix assumed.
The nuance: Gemini's `clientContent` can append **content** mid-session, so an "instructions" change is
half-live — addressable as content, not as the system instruction. That is worth a UI distinction
("send this as context" versus "reconnect to change the system instruction"), and it is exactly the kind
of question the spike existed to surface.

## The live probe: designed, not run

**It has not run, and it cannot on this machine** — the only realtime credential present is
`OPENAI_LIVE_API_KEY`. The desk research narrowed what a probe needs to do to almost nothing: the docs
answered the six capability questions, so a handshake's job is now **confirmation, not discovery**. Its
script should be one WebSocket connection with no audio, asserting in order: `setup` is accepted and
`setupComplete` arrives; a `toolCall` carries `args` and not only an `id`; `server_content.interrupted`
arrives on a barge-in; `toolCallCancellation` names the ids of pending calls after one. Four assertions
against a vocabulary that is already documented — the cheap kind, in the shape
`references/` already recommends for a provider canary.

## Engineering estimate

An honest range rather than a promise, and the S4 spike exists to replace it with a stopwatch:

- **Seam additions (1-4 above):** the smaller half. Four additive changes, each with a test that proves
  the *absence* of a signal is distinguishable from a provider that does not send one.
- **The adapter:** one WebSocket transport, a translation layer, and the session object — the shape
  `realtime-openai` already demonstrates. The unfamiliar parts are Gemini's `setup`-then-`setupComplete`
  handshake, its two audio sample rates and its `interruption` semantics.
- **Estimated: one to two focused weeks** for one adapter plus the seam additions, of which the seam is
  perhaps a third. The estimate's largest uncertainty is not the wire protocol — it is the async
  function-calling model, which is a *different* concurrency shape from our answer-one-delegation-at-a-time
  agent and may want its own spike before it is designed against.
