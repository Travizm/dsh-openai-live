# Market voice features — what ships in realtime/duplex voice assistants

**2026-10-15.** Companion to `docs/competitive-landscape.md` (2026-10-09, direct competitor
`AlexKaiqi/dsh-realtime-voice`). That doc settled the plugin-vs-plugin question. This one answers a
different one: **the maintainer wants to add two verbs — a silent note (model-facing context, does
not wake a turn) and a visible say (a sourced message attributed to the voice, starts a turn) — and
wants to know before designing UI what the market actually ships.**

**Method.** Targeted primary-source extraction, not listicles: vendor help centres, product pages,
developer docs and release notes for each product, plus one vendor engineering blog and one
independent lab measurement. Every cell below is either marked with a source in the evidence trail or
marked UNVERIFIED. Where a claim comes only from a search snippet rather than a page I actually read,
it says so. Transport/capture (AudioWorklet vs `ScriptProcessorNode`, WebRTC vs WebSocket) is out of
scope — prior finding, not re-derived.

**Scope.** Consumer assistants: ChatGPT Voice (Live / Advanced / Standard), ChatGPT Voice in Work &
Codex, OpenAI dots, Google Gemini Live, Apple Siri AI, Microsoft Copilot Voice, Amazon Alexa+,
Perplexity (Comet Voice Mode, iOS Assistant), Meta AI. Builder platforms whose *feature set* is the
relevant comparison: GPT-Live-1 API + Realtime API, ElevenLabs Agents, Vapi, Retell AI, LiveKit Agents,
Pipecat/RTVI. Coding-tool voice surfaces: VS Code Voice Mode (Copilot), Cursor, Windsurf/Devin Cascade,
Zed.

**Confidence, up front.** High on OpenAI (GPT-Live-1, dots, Codex) and Google — both publish
developer docs that state the primitives by name. High on LiveKit, ElevenLabs, Vapi, Retell, Pipecat —
their docs exposed the actual knobs and events. Medium on Apple, Microsoft, Amazon, Perplexity and
Meta — the *user-visible* features are documented, the turn-taking internals mostly are not, and I have
marked that gap rather than filling it. The two-verb capability is **not shipped as such by any product
I found**; the nearest shipped primitives are named in §6.

---

## 1. Master matrix — consumer assistants

`●` ships, documented · `◐` partial / configurable-off / one direction only · `○` not documented in
the sources I read (= treat as absent, not proven absent) · `?` UNVERIFIED

| Capability | ChatGPT Voice (Live) | Voice in Work & Codex | dots | Gemini Live | Siri AI | Copilot Voice | Alexa+ | Comet Voice | Meta AI |
|---|---|---|---|---|---|---|---|---|---|
| Barge-in (stop speaking on user speech) | ● [1][6] | ● [8] | ● [11] "keep talking to it while it works" | ● [18][19] | ? | ◐ [28] mute/inactivity model; interruption not documented | ? | ● [16] provider-side | ? |
| Backchannel *output* ("mhmm", "got it") | ● [1][6] | ● (same model) [8] | ● (same model) [12] | ○ | ? | ? | ○ | ◐ via Realtime model [16] | ● fillers, explicit toggle [38] |
| Backchannel *input* handling (don't steal turn) | ● [17] measured: 1/60 false stops | ● | ● | ? | ? | ? | ? | ◐ [16] VAD tuned; model-side | ? |
| Endpointing / silence handling | ● waits on thinking pauses [6]; API exposes turn detection [7] | ● | ● | ? app; API: no client-side turn-taking [47] | ? | ◐ 30 s warn / 60 s auto-end [30] | ? | ● "voice lock" to hold the floor [16] | ? |
| Published latency numbers | ◐ no E2E from vendor [7]; ~1.1 s ack, ~1.4 s yield measured by Agora [17] | — | — | — | — | — | — | — | — |
| User transcript visible | ● in-chat, tap orb for full transcript [1][9] | ● in the task's chat [8] | ● in the dot conversation [12] | ◐ transcript on ending the Live chat [18] | ◐ conversation history in Siri app [24][25] | ◐ transcript after the conversation [29] | ◐ voice history in privacy settings [34] | ● sessions saved to history [36] | ? |
| Live (streaming) captions during speech | ◐ orb toggles full transcript [9]; live-ness not stated → ? | ? | ? | ○ [18] | ? | ? | ? | ? | ? |
| Agent output transcript visible | ● same chat log [1][9] | ● [8] | ● [12] | ◐ on transcript view [18] | ◐ history [24] | ◐ transcript [29] | ? | ◐ | ? |
| Role attribution (who said what) | ● by chat turn structure [1][9] | ● voice turns are attributed in the task chat [8] | ● [12] | ◐ transcript view [18] | ◐ history | ◐ transcript | ? | ◐ | ? |
| Tool/long-task transparency | ◐ "visual results through supported widgets" [1]; progress spoken via commentary [4] | ● progress, blockers and results back into the voice conversation [1][8] | ● messages with progress/questions/decisions; Activity View [11][12] | ● Connected Apps actions on screen + **Undo** [18] | ◐ app actions; no progress UI documented [23][26] | ● agent mode "shows what it's doing and why"; Outlook voice catch-up [31] | ◐ agentic web tasks run behind the scenes, reports back [32] | ● screen awareness [35][37] | ? |
| Voice selection | ● 9 remastered voices, named [1] | ● same set [8] | ◐ visual identity per dot (shape/colour/eyes); **per-dot voice = open feature request** [11][13] | ◐ asked to change pace/accent mid-conversation [21]; a picker inside the Live app is not documented → ? | ● pick a voice + voice enrolment [25] | ● preferred voice; playback speed on mobile [29] | ● 4 personality styles Brief/Chill/Sweet/Sassy [32] | ● 10 voices [35] | ? |
| Wake word / ambient | ○ push-to-start, mic mute [1] | ○ hotkey + screen context [8] | ◐ call button, always-on agent layer [12] | ◐ "Hey Google, let's talk Live"; lock-screen continue [18] | ● "Hey Siri", side button, Dynamic Island, glance on Vision Pro [24] | ● "Hey Copilot", off by default, on-device 10 s buffer [30] | ◐ wake word on Echo devices is not stated in the sources read; proactive suggestions verified [32] | ○ toolbar hotkey ⌥⇧V, panel listens on open [35] | ? |
| Push-to-talk / typed hybrid | ● type + attach images inside the voice chat [1]; dictation is separate [8] | ● voice inside an existing typed task [8] | ● type while on a call [12] | ● switch Live ↔ text in the same chat [18] | ◐ Spotlight/context-menu text entry [24] | ● dictation + voice are separate [28] | ? Alexa.com typed chat seen only as a snippet [34, not read] | ● panel + tab context [35] | ? |
| Cross-session memory | ● memory + web search in Live [1]; intelligence levels [1] | ● voice uses the task's conversation; switch tasks by voice [8] | ● context from past conversations, per-dot memory [11][12] | ● memory of past chats + Connected Apps, toggleable [18][22] | ● personal context across messages/mail/photos, Spotlight index [23][26] | ● voice chats reference memory (Jan 2026) [31] | ● knows purchases/listening/shipping; asks it to remember [32] | ◐ context across tabs in a session [35] | ○ disabled while full-duplex demo on [38] |
| Multi-session / multi-agent addressing | ● "Let me talk to the task reviewing the tests" / "take me back" [8] | ● same | ● routes work across channels [12] | ○ | ○ | ◐ Outlook voice catch-up [31] | ○ | ○ | ○ |

**Read the row that matters.** Cross-session memory is universal. Live captions are not: the
consumer apps expose transcripts *around* the conversation (ChatGPT via orb, Gemini on exit, Copilot
afterward, Siri in the history app) rather than a caption bar, and no consumer product I read documents
streaming word-by-word captions in the voice surface itself. Builder platforms do ship them (§2, §3).

---

## 2. Master matrix — builder platforms (the layer we actually model our design on)

| Capability | GPT-Live-1 API | Realtime API | ElevenLabs Agents | Vapi | Retell | LiveKit Agents | Pipecat / RTVI |
|---|---|---|---|---|---|---|---|
| Interruption control | model-side, prompt policy [4] | server VAD `threshold`/`silence_duration_ms`; client-side if disabled [47] | per-agent on/off toggle [41] | `stopSpeakingPlan`: numWords, voiceSeconds, backoffSeconds (1 s) [43] | interruption sensitivity 0–1 (0.9 dashboard / 1 API), per-node override [45] | adaptive vs vad, `enabled=false` allowed (hard error on realtime w/ server turn detection) [47] | enable/disable; disable = queue reply, mute = discard [53] |
| Backchannel distinction | backchannel **policy** in prompt; "moderate" is prose, not a number [4] | — | — | smart endpointing incl. backchannel prediction (Krisp/prosody) [43] | backchannel output off by default, frequency 0–1 (0.8), editable word list [45] | adaptive interruption model, acoustic, no transcript needed; `backchannel_boundary` cooldown (1.0, 1.0) [48] | MinWordsUserTurnStartStrategy(min_words=3); Krisp VIVA interruption prediction [53] |
| Endpointing knobs | natively supports turn detection [7] | server VAD / semantic VAD (`eagerness`, `interrupt_response`) [47] | turn timeout 1–30 s; soft timeout filler; turn eagerness [41] | start-speaking wait 0.4 s; smart-endpointing probability→wait curve e.g. `200+8000x` [43] | transcription mode speed/accuracy; Deepgram endpointing 100–10,000 ms (1,000 default) [45] | turn detector (semantic+acoustic) default, dynamic endpointing, STT endpointing [47] | VAD turn-start strategies [53] |
| Live user transcript event | transcript events [3] | input audio transcription (async, "guidance, not exact") [15] | `user_transcript` [39] | `transcript` partial/final + role + `isFiltered` [44] | dashboard transcript; per-node [45] | `lk.transcription` stream, interim + final + segment ids [49] | `user-transcription` [52] |
| Live agent transcript event | output transcript [3] | response output transcript (audio) [15] | `agent_chat_response_part` for streaming display, `agent_response` for history [39] | `model-output` (token/tool-call, `turnId`) [44] | ? | published in sync with audio playback; **truncated on interruption** [49] | `bot-transcription` per sentence; `bot-tts-text` for word timing [52] |
| Post-interruption transcript fidelity | app-side concern [5] | app-side | `agent_response_correction` truncates displayed text to what was spoken [39] | `user-interrupted` with `turnId` so tokens can be discarded [44] | ? | transcript truncated to match spoken output [49] | only spoken text committed to context [53] |
| Tool call / result visibility | nested events for hosted tool progress, citations, files, images [5] | function call items in conversation [14] | `client_tool_call`, `agent_tool_response{name,id,type,is_error}`, `agent_tool_response_full_payload` (64 KB cap, sensitive-data warning) [39] | `tool-calls` message with full toolCallList [44] | dashboard + webhook payloads [45] | agent state → thinking indicator during tool calls [51] | function-call frames; `FunctionCallResultFrame` non-interruptible [53] |
| **Silent** context injection | `session.instructions.append`, `session.thinking.append` (ack carries `start_ms`/`end_ms`) [3] | `conversation.item.create` (role system/user/assistant) — no response triggered [14]; out-of-band `response.create` with `conversation:"none"` [14] | `contextual_update` — "non-interrupting background information" [40] | `clientMessages` / assistant overrides | contextual updates / dynamic variables [45] | text stream to agent; system prompts; `generate_reply` [49] | `InputTextFrame` / system frames into context |
| **Visible, turn-starting** injection | `session.commentary.append` → **spoken aloud**, no UI requirement [4][5] | `response.create` (writes to the default conversation) [14] | `user_message` — "as if the user had spoken it" [40] | user/assistant messages via client API | contextual updates are user-side | `generate_reply(user_input=...)` — user-attributed [49] | `TextFrame` → bot output |
| Assistant-attributed, non-spoken, visible message | — none found | — none found | — none found | — none found | — none found | `agent_transcription` is audio-derived only [49] | `bot-transcription` is audio-derived only [52] |
| Ship-your-own transcript UI | — | — | Transcript Viewer, word-highlight synced to playback [42] | — | — | `AgentChatTranscript` + thinking indicator [51] | RTVI reference clients [52] |
| Agent state surface | commentary/thinking channels [3] | app-side | `agent_response_complete` [39] | `speech-update` started/stopped + role + turn [44] | ? | `agent_state_changed` listening/thinking/speaking; `user_state_changed` incl. `away` [50] | VAD + speaking events [52] |

**The gap this table proves.** Every platform ships a silent-injection verb. Every platform's
visible-injection verb is *user-attributed* (`user_message`, `generate_reply(user_input=…)`) or is
*audio-derived* (a transcript of something spoken). The only assistant-attributed channel that exists
is GPT-Live's `session.commentary.append` — and OpenAI's docs put it on the *audio* side: text you
want GPT-Live to **say aloud**, with no requirement that any UI ever display it [4][5].

---

## 3. Axis-by-axis detail

### 3.1 Turn-taking, barge-in, backchannel, latency budget

Two architectural camps:

- **Full-duplex models** (GPT-Live-1, Gemini Live native audio, Meta's full-duplex demo) decide
  interaction many times per second and treat a pause as *input*. GPT-Live's launch post contrasts
  this with turn-based Advanced Voice Mode, whose silence-based turn detection "could be mistaken for
  the end of turn… causing the model to interrupt at unnatural times" [6]. Backchannels ("mhmm",
  "yeah", "got it") are a first-class output behaviour of the model, not an add-on [1][6].
- **Pipelines** (LiveKit, Pipecat, Vapi, Retell, ElevenLabs) expose explicit knobs and, increasingly,
  a *model that separates backchannel from barge-in*. LiveKit's adaptive interruption handling is
  acausal-free and explicit about it: it analyses acoustic signals to "identify intentional
  interruptions (barge-ins) from conversational backchanneling", needs aligned transcripts, and
  defaults to a 1.0 s start / 1.0 s end cooldown around agent turns precisely because the model can
  confuse the two at turn boundaries [48]. Pipecat's equivalent is `MinWordsUserTurnStartStrategy` plus
  the Krisp VIVA interruption-prediction strategy [53]. Vapi exposes backchannel prediction inside its
  smart-endpointing plan and routes the *output* side to `stopSpeakingPlan` [43]. Retell ships
  backchanneling **off by default** with a 0–1 frequency (0.8 when on) and an editable word list per
  language [45].

Endpointing is a latency dial with a stated cost. Retell frames it plainly: "a longer window gives
more accurate transcripts but adds directly to the delay the caller hears" [45]. Retell's own published
test numbers: 180 ms time-to-first-token, 620 ms end-to-end, **140 ms barge-in response**, 45 ms jitter
σ, and a stated industry threshold of <800 ms E2E / <200 ms barge-in [46]. ElevenLabs exposes a *soft
timeout* that speaks a filler ("Hhmmmm...yeah.") when the LLM is slow, once per turn [41].

**Latency numbers are contested, and the conflict is informative.** OpenAI published benchmark deltas
but no end-to-end number: +30 percentage points on Full Duplex Bench over GPT-Realtime-2.1, #1 on Tau3
with GPT-6 Astra at medium effort, and a customer claim that interruptions fell ~80% for language
tutors (Speak) [7]. Agora Media Lab then measured the shipping ChatGPT app on real devices with an
artificial mouth and dual-track waveform capture (n=30/condition): ~1.1 s to acknowledge, **~1.4 s to
yield when interrupted** (498 ms slower than turn-based Advanced), but 1/60 false-interruption probes
missed vs 22/60 for Advanced — and a new failure mode: GPT-Live spontaneously answered background
voices in 4 of 30 ten-second windows where older modes stayed silent [17]. Agora also argues the user
feels *variance*: median improved only 205 ms, but the P90 spread collapsed (σ 489 → 104 ms) [17]. A
secondary trade-press piece claims OpenAI's often-quoted "sub-300 ms" figure belongs to a different
model; I saw only the snippet and did not read that page, so it is listed UNVERIFIED.

**Copyable:** a `barge-in` that ignores acknowledgements needs a boundary policy, not just a model
(1 s cooldowns, min-words thresholds, or a frequency parameter) — and the *transcript* must be
truncated to what was actually heard (§3.2).

### 3.2 Transcript: is the voice's output visible, and can you tell who said what?

The market splits into three shapes, none of which is "captions in the voice surface":

1. **Transcript as chat log (strongest attribution).** ChatGPT Voice "works within a chat, so you can
   listen while following the response in text, type when you cannot speak, and review earlier
   messages" — and the features page adds: "See the full transcript by tapping the orb. Tap it again to
   go back to a more simplified view" [1][9]. Attribution is structural: the voice's turn is an
   assistant message in the existing chat, distinguished from a typed user message by nothing more than
   role and modality. Voice in Work/Codex extends this: voice uses the task's conversation and model,
   so voice-originated work lands in the same task thread [8].
2. **Transcript as post-hoc artifact.** Gemini Live: "ending a chat… provides a transcript", and "To
   exit the Live chat and review the transcript, tap End or swipe right" [18]. Copilot Voice:
   "Once the conversation has ended, a text transcript of the conversation is made available to you"
   [29]. Perplexity iOS: "All voice sessions will be saved to your session history once you're done"
   [36]. Alexa: voice history and transcripts are reviewable in privacy settings [34].
3. **Transcript as first-class live stream (builder layer).** LiveKit publishes transcriptions to the
   frontend in realtime on the `lk.transcription` text stream, with `sync_transcription` displaying
   "text word by word as it speaks", TTS-aligned word timestamps for word-level sync, and interim vs
   final streams keyed by `segment_id` [49]. ElevenLabs emits `user_transcript` and offers
   `agent_chat_response_part` explicitly so you can "display the agent's text as it is produced"
   [39]. Vapi emits partial and final `transcript` messages with a `role` field and an `isFiltered`
   flag [44]. RTVI's protocol has `user-transcription`, `bot-transcription` and — for word timing —
   `bot-tts-text`, with an honest caveat that bot transcription lacks real-time timestamps because TTS
   services mostly don't expose them [52].

**The correction problem, which is the real design lesson.** Three platforms independently solved
"the transcript must not contain words the user never heard":

- ElevenLabs `agent_response_correction` carries `original_agent_response` and a
  `corrected_agent_response` — "Contains truncated response after interruption", described as
  maintaining conversation accuracy [39].
- LiveKit: "If the agent is interrupted, the transcription stops and is truncated to match the spoken
  output" [49].
- Pipecat: only words that actually played reach the assistant context; on interruption the
  aggregator commits the partial, spoken-so-far text, so "the bot's message ends where the user cut it
  off, not where the LLM's generation ended" [53].

**Copyable:** if we render the voice's `say` in the DSH session, we must truncate on barge-in the way
ElevenLabs/LiveKit/Pipecat do, or the session log becomes a record of text that was never spoken — a
correctness problem in a coding harness where the log is what the model reads next.

### 3.3 Tool / action transparency

Three distinct patterns, and the harness-relevant one is the third:

1. **Cards and widgets in the voice surface.** ChatGPT Voice "can use web search and memory, show
   visual results through supported widgets" [1]; Comet Voice asks about what is on screen and
   navigates by voice [35][37]; Gemini Live runs Connected Apps actions in the conversation and offers
   **Undo** on screen ("Tap Undo or ask Gemini to undo the action") [18]; Alexa+ surfaces price
   history, comparisons and shopping guides [32].
2. **Progress as spoken narration.** GPT-Live's prompting guide instructs: "Delegate before giving an
   answer that depends on backend work. Do not guess the result while waiting", and provides
   `session.commentary.append` for "updates you want GPT-Live to say aloud" while a backend agent works
   [4][5]. The delegation guide is blunt that the two are decoupled: "Live speech and delegated work
   continue independently. A completed backend response does not itself mean the user heard the answer"
   — and tells apps to verify the booking record *and* the played audio separately [5]. Agora frames the
   UX this as three clocks: acknowledgement onset, substantive-answer onset, answer completion [17].
   ElevenLabs' soft-timeout filler is the low-rent version of the same thing [41].
3. **Task state surfaced in a durable surface, with the voice as one channel.**
   - ChatGPT Voice in Work & Codex: "If ChatGPT starts work, keep talking to check progress or steer
     the task" and "It brings progress, blockers, and results back to your voice conversation so you
     can keep talking while work continues" [1][8]. Codex changelog: voice can "start, check, or steer
     work in other threads" [10].
   - dots: "Tell your dot where to send different kinds of updates. For example, ask it to keep
     routine progress in ChatGPT and bring decisions to you in Slack"; progress, results and requests
     for input are inspectable in the dot's Activity view; "Ending a voice call doesn't necessarily stop
     assigned work" [11][12].
   - Microsoft: agent mode in Word/Excel/PowerPoint "shows what it's doing and why, giving users
     transparency and control, so they can review, adjust, or steer the outcome" [31].
   - Vs Code Voice Mode: "Voice Mode announces when it routes a request to an existing session or
     starts a new one" [54] — a spoken, system-attributed routing notice.
   - LiveKit: the chat component "shows a typing or thinking indicator when the agent is processing
     input or composing a response… for example, while the agent is calling an external tool"; the
     indicator is driven by the agent's state machine [51].
   - Gemini Live API goes furthest on *explicit* control: async function calling with scheduling
     `SILENT | WHEN_IDLE | INTERRUPTED`, and `interaction_status` (`IN_PROGRESS` vs `IDLE`) because
     with asynchronous reasoning "`turnComplete: true` does not indicate an idle session" [20].

**Copyable:** `SILENT`-style scheduling is the market's only explicit "run it but don't narrate it"
enum, and Gemini *and* GPT-Live both separate "the work finished" from "the user heard it". Our note/say
split is the same distinction expressed as tool verbs.

### 3.4 Voice / identity

- **Roster size is now a marketing surface.** ChatGPT remastered nine voices for GPT-Live, each with a
  blurb (Arbor, Breeze, Cove, Ember, Juniper, Maple, Sol, Spruce, Vale); changing voice mid-conversation
  "starts a new voice call in the same chat" [1]. The API ships a named roster with language/regional
  metadata (`quartz`, `ripple`, `vesper`, `willow`, `stone`, `gleam`, `meridian`, `bossa`, `tempo`,
  `beacon`, `delta`, `cinder`) and supports an authorised custom voice [3]. Comet offers 10 voices [35].
  Alexa+ reframes identity as *personality style* rather than timbre: Brief / Chill / Sweet / Sassy,
  "shape her tone without changing her capabilities" [32].
- **Per-agent voice is conspicuously missing.** dots lets you name and visually customise each dot
  (shape, colour, eyes, accessories) and each has a handle, but nothing in the docs gives a dot its own
  voice; an OpenAI community thread explicitly requests "persistent voice, separate from ChatGPT and
  Codex", which is evidence the behaviour does not exist yet [11][13]. For a harness where the voice
  speaks *for* a session, per-agent voice is an unclaimed differentiator — with the caveat that a
  distinctive voice per session becomes a UX tax the moment two sessions share one audio channel.

### 3.5 Modes: ambient, wake word, push-to-talk, typed hybrid

- **Wake word with a documented privacy shape:** "Hey Copilot" is off by default, requires the app
  running (open/minimised/background), a small on-device service keeps "a 10-second audio buffer in
  memory to listen for the phrase. That buffer is never recorded or stored", and the wake phrase is
  English-only; Microsoft also warns "language and accent variations may cause accidental activation"
  [30]. Siri has the deepest invocation surface (Hey Siri, side button, Dynamic Island swipe, Spotlight,
  control-click on content, glance-to-speak on Vision Pro, Camera-app Siri mode) [24][25].
- **Continuous listening without a wake word:** Gemini Live can continue on the lock screen and be put
  on hold; "you can't start Gemini Live on a locked screen" [18]. Alexa+ is proactive by design
  (traffic and sale suggestions) [32].
- **Floor-holding instead of push-to-talk — the single most copyable turn-taking UX in this corpus.**
  Perplexity's engineering write-up: "Rather than using a traditional push-to-talk approach where voice
  is off by default and the user has to press to speak, we invert it. The interaction stays ambient by
  default, but when the user wants to hold the floor for a moment they can lock the voice and take
  ownership of the turn… we see this as more than a one-off feature" [16].
- **Typed/voice hybrid in one thread is table stakes:** ChatGPT accepts text and images inside a Live
  conversation and can reply in voice "without starting a separate chat" [1]; Gemini switches
  Live ↔ text in the same chat without a new chat [18]; LiveKit treats `lk.chat` text input and audio
  as one session and interrupts current speech to process a typed message [49]; dots: "You can also
  type messages while you're talking" [12].

### 3.6 Multi-session / context

- **Memory is universal in consumer assistants.** ChatGPT Live uses memory and web search [1]; Gemini
  Live uses memories of past chats and Connected App info, with a single Memory toggle [18][22];
  Copilot voice chats reference memory since Jan 2026, with memories editable only in personalization
  settings and explicitly "cannot modify or edit their memories directly from voice chat due to privacy
  safeguards" [31]; Alexa+ knows purchases, listening, shipping address and takes dictated facts [32];
  Siri AI's personal-context story is the whole product (messages/email/photos + Spotlight index with
  attribution back to the app) [23][26].
- **Cross-conversation *voice* addressing is rare and OpenAI is the only one shipping it.**
  "Let me talk to the task reviewing the tests", then "Take me back to the previous task"; the
  destination task must support voice and be on a connected host; only one voice chat can be active
  across the desktop app at a time [8]. dots carries context across ChatGPT/Slack/Teams/calls so
  "changing where you talk to it doesn't start a new dot or reset its memory" [12]. Nobody in the
  builder column offers anything comparable — LiveKit and Pipecat model one session, one agent.

### 3.7 Coding-tool voice surfaces (the closest analogue to our host)

| Tool | What ships | Source |
|---|---|---|
| **VS Code Voice Mode (Copilot)** | Spoken conversation with the agent *while it works on your code*; sends the request to the active chat/agent session using its model and attached files; can be asked about running sessions or to start a new one; hands-free mode restarts listening after the agent stops; interrupt by speaking or hotkey; mic mute without ending the session; transcript toggle (`agents.voice.showTranscript`) shows the conversation transcript **in the chat input**; voice selection; separate dictation with an on-device model, 20-minute cap, and an LLM-cleanup toggle | [54] |
| **Cursor** | Voice input is **dictation only** — records the full clip, batch STT, waveform/timer/cancel/confirm in the Agents window | [55] |
| **Windsurf / Devin Cascade** | "Use Voice input to use your voice to interact with Cascade. In its current form it can transcribe your speech to text." Progress is surfaced as a Todo list in the conversation, not spoken | [56] |
| **Zed** | Voice input / voice activation is on the public roadmap, not shipped | [57] |

**The most relevant shipped precedent in the entire corpus** is one sentence in the VS Code docs:
"Voice Mode announces when it routes a request to an existing session or starts a new one" [54].
That is a *system-attributed spoken message that changes what the session the user is talking to is* —
exactly the shape our visible `say` takes, and evidence that harness users tolerate being told, out
loud, what the voice just did on their behalf.

---

## 4. Distinctive things individual products do, and whether we can copy them

| Product | Distinctive | Copyable for us? |
|---|---|---|
| GPT-Live-1 API | `instructions` / `thinking` / `commentary` append trio, with acknowledgment carrying `start_ms`/`end_ms` on the session timeline [3][4] | Directly maps to note/say; we should carry a similar placement/timeline estimate so a note can be positioned in the session |
| GPT-Live-1 API | commentary append is spoken by the model *without* any requirement that the UI show it [4][5] | Yes — and it is the reason our `say` must be *both* spoken and logged, a combination nobody ships |
| ChatGPT Voice | intelligence level (Instant/Medium/High) selectable inside a voice session [1]; "ask it to respond faster, slow down, add more detail, or keep it brief" [9] | Yes — verbosity should be a first-class control, not a prompt |
| ChatGPT Voice in Codex | "Let me talk to the task reviewing the tests" / "take me back" [8] | Yes, and it is a differentiator: nobody else addresses multiple sessions by voice |
| dots | Route different *kinds* of updates to different surfaces; Activity view as the durable log; call ending doesn't stop work [11][12] | Yes — maps to "note goes to the session, say goes to the voice + log" |
| Gemini Live API | Function scheduling `SILENT`/`WHEN_IDLE`/`INTERRUPTED`; `interaction_status` separate from `turnComplete` [20] | Yes — expose the same enum on our two verbs |
| Gemini Live app | On-screen **Undo** for agent actions [18] | Partly — a voice-initiated write into a coding session wants an obvious reversal path |
| Retell | Backchannel *frequency* + editable word list; per-node overrides incl. non-interruptible disclosure [45] | Yes — per-turn control of "can this be interrupted" is what makes sourced announcements safe |
| LiveKit | Adaptive interruption detection with explicit boundary cooldowns, and `agent_false_interruption` → "resuming speech" [47][48] | Yes — resume-after-false-stop is a cheap, high-perceived-quality trick |
| LiveKit | `agent_state_changed` (listening/thinking/speaking) driving a thinking indicator during tool calls [50][51] | Yes — one status line in the session covers most of the "is it working?" anxiety |
| ElevenLabs | `agent_response_correction` truncating displayed text to spoken text [39] | Yes — mandatory for us |
| Perplexity | "voice lock" — invert push-to-talk: ambient by default, user locks the floor [16] | Yes, and cheaper than wake word |
| Perplexity | Tool results returned as structured JSON with `response_text` and `require_repeat_verbatim` flags; keep the toolset under ten [16] | Yes — a verbatim flag is essential when the voiced content is a file path, test name or symbol |
| Microsoft | Wake word with an explicit on-device 10 s buffer that is never stored, plus an accidental-activation warning [30] | Only if we add a wake word; the warning argues for push-to-talk in a shared office |

---

## 5. Table stakes vs differentiators (for a plugin in this space)

**Table stakes — a reviewer will assume these exist, and their absence reads as a defect:**

1. Barge-in that actually stops audio, with the *variance* controlled, not just the median. Targets in
   the wild: <200 ms barge-in / <800 ms end-to-end [46]; measured GPT-Live ~1.4 s to yield [17].
2. Acknowledgement-proof interruption: "mm-hmm"/"okay"/"right" must not steal the turn. Shipped
   everywhere as min-words, frequency parameters, cooldowns, or an acoustic classifier [43][45][48][53].
3. Agent-side backchannel output ("mhmm", "got it") — now the default expectation from GPT-Live users
   [1][6], and configurable as a *policy* at the API [4].
4. Tunable endpointing/turn timeout exposed as numbers (1–30 s turn timeout, 0.4 s start-speaking wait,
   100–10,000 ms endpointing, interruption sensitivity 0–1) [41][43][45].
5. A visible transcript with role attribution in the same surface as the work [1][9][49]; post-hoc-only
   transcripts (Gemini, Copilot, Perplexity) are the consumer norm but the *builder* norm is live.
6. Transcript truncation on interruption so the log matches what was heard [39][49][53].
7. Silent context injection that does not wake a turn — `contextual_update`, `conversation.item.create`,
   `instructions.append`/`thinking.append` [3][14][40]. The *note* verb is table stakes.
8. Tool call/result visibility to the client with name, id and errors, plus a way to stream the full
   result if the client is trusted [39][44].
9. A named voice roster and a way to pick one; mute without ending the session; typed input in the same
   conversation [1][3][35][49].
10. Some form of memory/context continuity across sessions, with an explicit control to turn it off or
    review it [18][22][31][32].

**Differentiators — few ship these, and they're where the two verbs earn their place:**

1. **A visible, assistant-attributed, turn-starting message that the user did not say.** Nobody ships
   it. The nearest neighbours are GPT-Live `commentary.append` (spoken, not necessarily visible) [4][5],
   VS Code Voice Mode's routing announcement (spoken, system-attributed, no log requirement) [54], and
   `user_message`/`generate_reply(user_input=…)` (visible, but attributed to the *user*) [40][49]. If we
   ship `say` as "visible + attributed to the voice + starts a turn + sourced", that is a genuinely new
   cell in §2's last row.
2. **Sourced rather than guessed progress.** GPT-Live's own guidance is "Do not guess the result while
   waiting" [4]; Agora's three-clock framing says users feel acknowledgement vs substance vs completion
   [17]; dots routes different *kinds* of update to different surfaces [11]. A voice that narrates only
   events the harness actually emitted is strictly better than one that summarizes.
3. **Silent-vs-spoken as an explicit enum on a tool verb** (Gemini's `SILENT|WHEN_IDLE|INTERRUPTED`
   [20]) rather than as a prompt instruction. Expressible, testable, and it composes with the next one.
4. **Verbatim flag for identifiers.** Perplexity's `require_repeat_verbatim` [16] is the only shipped
   precedent, and a coding harness is exactly where paraphrase is dangerous (paths, test names, flags).
5. **Multi-session addressee control by voice** ("talk to the task reviewing the tests") — ChatGPT-only
   [8], and uniquely valuable in a harness where several sessions run at once.
6. **Floor-holding (voice lock) instead of push-to-talk or a wake word** [16]. In a shared office, a
   wake word buys accidental activation — Microsoft's own docs warn about it [30].
7. **False-interruption resume** (`agent_false_interruption` → resume speech) [47]. Cheap, visible
   quality win.
8. **Reversibility of voice-initiated writes.** Gemini Live's on-screen Undo [18] and Retell's
   per-node non-interruptible disclosure [45] are the market's two answers; for us the answer is
   probably "a note never mutates the user-visible conversation; a say always is".

---

## 6. The two verbs, against shipped primitives

| Verb we want | Nearest shipped primitive | What's missing there | Consequence for us |
|---|---|---|---|
| **note** (silent, model-facing, no turn) | GPT-Live `session.instructions.append` / `session.thinking.append` [3]; Realtime `conversation.item.create` [14]; ElevenLabs `contextual_update` [40]; Pipecat system frames | Nothing material — this is a solved, table-stakes primitive | Design risk is low; the only open question is *placement* (GPT-Live solves it with `start_ms`/`end_ms` acknowledgements [3]) |
| **say** (visible, voice-attributed, starts a turn, sourced) | GPT-Live `session.commentary.append` (spoken, no UI mandate) [4][5]; VS Code Voice Mode routing announcement (spoken, system-attributed) [54]; LiveKit `generate_reply(user_input=…)` and Vapi/ElevenLabs user messages (attributed to the *user*) [40][44][49]; `bot-transcription` / `agent_response` (audio-derived) [39][52] | The combination: visible **and** attributed to the voice **and** turn-starting **and** sourced from a real harness event | This is the novel cell. The hard part is not the transport but the fidelity rules: truncate on barge-in like ElevenLabs/LiveKit/Pipecat [39][49][53], stay distinct from user utterances in the log, and carry a verbatim flag for identifiers [16] |

---

## 7. UNVERIFIED / not confirmed against a primary source

1. **Siri AI transcript during conversation** — the Siri app syncs conversation history across devices
   [24][25], but no source I read documents live captions or a per-utterance transcript view during a
   conversation. Treated as absent, not proven absent.
2. **Siri AI barge-in / backchannel / turn-taking** — no Apple primary source found that documents
   interruption handling or backchannel behaviour in Siri AI. Everything in §3.1 for Siri is unknown.
3. **Siri AI tool/action progress UI** — App Intents schemas, View Annotations and on-screen awareness
   are documented [23][26]; a progress or tool-card surface in the voice conversation is not.
4. **Microsoft Copilot Voice tool cards / live captions** — transcripts are documented as available
   *after* the conversation [29]; agent-mode transparency is documented for Word/Excel/PowerPoint and
   Outlook, not for the voice surface [31].
5. **Amazon Alexa+ turn-taking internals** (barge-in, backchannel, endpointing) — the engineering post
   describes architecture and latency *goals* ("We minimized latency", Bedrock model routing) without
   numbers or turn-taking mechanics [33]. Alexa voice history/transcripts is snippet-level evidence from
   a privacy-settings page I did not read in full [34].
6. **ChatGPT Voice "supported widgets"** — named in the help centre [1]; which widgets, and whether they
   render during a Live conversation, is not documented anywhere I found.
7. **Whether ChatGPT Voice transcript is live-streamed word-by-word in the orb view** — the page says
   "See the full transcript by tapping the orb" [9]; streaming behaviour is unstated.
8. **Meta AI** — the only well-documented turn is the experimental full-duplex toggle and its trade-offs
   (pauses, filler words; disables image generation and saved-detail personalisation while on) [38].
   Everything else about Meta AI voice is unverified here.
9. **Vendor latency conflict** — OpenAI published no end-to-end figure [7]; Agora's independent
   measurement (~1.4 s yield, ~1.1 s ack) is a third party's lab protocol [17]; a trade piece claiming
   the "sub-300 ms" figure belongs to another model was seen only as a search snippet and not read.
   Retell's 620 ms/140 ms figures are the vendor testing itself [46]. Treat all E2E numbers as
   directional.
10. **Per-dot voice** — the community request for a persistent voice per dot is a *feature request*
    [13]; the docs give per-dot name, appearance and handle, not voice [11].
11. **Windsurf/Devin Cascade and Zed voice** — Cascade is documented as speech-to-text input only [56];
    Zed's voice work is roadmap-level [57]. Neither has documented spoken agent responses.
12. **GitHub Copilot Voice (Microsoft Garage)** — seen only as a search snippet; not verified. The
    shipping artefact in VS Code is Voice Mode [54].
13. **ElevenLabs/Vapi/Retell turn-taking internals were read from docs, not measured.** Their knob names
    and defaults are verified; their real-world behaviour is not.

## 8. Evidence trail

All URLs accessed 2026-10-15.

1. OpenAI Help Center — *ChatGPT Voice* · https://help.openai.com/en/articles/20001274/ (Live/Advanced/Standard; nine voices; widgets; Voice in Chat / Work and Codex; usage limits)
2. OpenAI Help Center — *Voice Mode FAQ* (same article family) · https://help.openai.com/en/articles/8400625-voice-conversations-beta
3. OpenAI API docs — *Managing GPT-Live sessions* · https://developers.openai.com/api/docs/guides/live-conversations (`instructions.append`/`thinking.append`/`commentary.append`, `start_ms`/`end_ms`, voice roster, delegation/store)
4. OpenAI API docs — *Prompting GPT-Live* · https://developers.openai.com/api/docs/guides/live-prompting (Backchannel policy, Interruption policy, Delegation policy, commentary for spoken updates, "do not guess the result")
5. OpenAI API docs — *Delegation and tools in GPT-Live* · https://developers.openai.com/api/docs/guides/live-delegation (task state ownership, hosted tool progress/citations/files/images, sideband, playback controls, "Live speech and delegated work continue independently")
6. OpenAI — *Introducing GPT-Live* (2026-07-08) · https://openai.com/index/introducing-gpt-live/ (full-duplex, "mhmm"/"yeah", waits instead of interrupting, background-noise handling, nine remastered voices, delegation to GPT-5.5, SynthID update)
7. OpenAI — *Build more natural voice experiences with GPT‑Live‑1 in the API* (2026-09-10) · https://openai.com/index/introducing-gpt-live-1-in-the-api/ (native ASR transcripts and response text, keyword biasing, turn detection, Full Duplex Bench +30 pp, Speak −80 % interruptions, telephony, silent context management)
8. ChatGPT Learn — *ChatGPT Voice* · https://learn.chatgpt.com/docs/features/voice (Voice in Chat/Work/Codex, start voice chat inside an existing task, task-to-task switching, appshots/screen context, one voice chat at a time)
9. ChatGPT — *Voice* product page · https://chatgpt.com/features/voice/ ("See the full transcript by tapping the orb", interrupt anytime, adjust pace/detail)
10. OpenAI Developers — *Codex changelog* · https://developers.openai.com/codex/changelog ("ChatGPT Voice and multi-folder projects 26.715"; audio inputs and tool outputs; streaming realtime V3 conversations)
11. OpenAI — *Introducing dots* (2026-09-29) · https://openai.com/index/introducing-dots/ (always-on agent, own cloud computer and browser, message or call, progress/questions/decisions, Activity View, custom rules)
12. ChatGPT Learn — *Meet dots* · https://learn.chatgpt.com/docs/dots (call your dot, type while talking, route different kinds of updates, Activity view, ending a call doesn't stop work, per-dot name/appearance)
13. OpenAI Community — *Give dots their own persistent voice, separate from ChatGPT and Codex* (feature request) · https://community.openai.com/t/give-dots-their-own-persistent-voice-separate-from-chatgpt-and-codex/1402327
14. OpenAI API reference — *Realtime client events* · https://developers.openai.com/api/reference/resources/realtime/client-events (`conversation.item.create`; `response.create` incl. out-of-band `conversation:"none"`)
15. OpenAI API reference — *Realtime server events* · https://developers.openai.com/api/reference/resources/realtime/server-events (input audio transcription caveat, noise reduction, turn detection config)
16. OpenAI developer blog — *How Perplexity Brought Voice Search to Millions Using the Realtime API* · https://developers.openai.com/blog/realtime-perplexity-computer (voice lock, toolset under ten, `response_text` + `require_repeat_verbatim`, context-management lessons, VAD tuning)
17. Agora Media Lab — *OpenAI Didn't Publish GPT-Live's Latency. So We Measured It.* (2026-07-10) · https://www.agora.io/en/blog/openai-didnt-publish-gpt-lives-latency-so-we-measured-it/ (~1.1 s ack, ~1.4 s yield, 1/60 false stops, background-voice answer 4/30, P90 spread collapse, three clocks)
18. Google Support — *Talk naturally with Gemini Live* · https://support.google.com/gemini/answer/15274899 (interrupt toggle, hold/mute/end, transcript on exit, Live↔text switching, Connected Apps in Live incl. Undo, memory of past chats, camera/screen share, lock-screen continuation)
19. Google AI for Developers — *Gemini Live API overview* · https://ai.google.dev/gemini-api/docs/live-api (barge-in, tool use incl. Google Search, audio transcriptions of input and output, proactive audio, affective dialog, 70 languages, WebSocket)
20. Google AI for Developers — *Live API capabilities* · https://ai.google.dev/gemini-api/docs/live-api/capabilities (`output_audio_transcription`, async function calling with `SILENT|WHEN_IDLE|INTERRUPTED`, `interaction_status` vs `turnComplete`, session resumption, 128k context)
21. Google blog — *Gemini Live: a more helpful, natural and visual assistant* (2025-08-20) · https://blog.google/products-and-platforms/products/gemini/gemini-live-updates-august-2025/ (on-screen visual guidance, Calendar/Keep/Tasks/Messages, speech speed and accents)
22. Google blog — *The Gemini app can now recall past chats* (2025-02-13) · https://blog.google/feed/gemini-referencing-past-chats/
23. Apple Newsroom — *Apple introduces Siri AI…* (2026-06-08) · https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant/
24. Apple Newsroom — *Siri AI… is here* (2026-09-14) · https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/ (beta in English, invocation surfaces, Siri app iCloud-synced conversation history, Live Rewind 15 s snippet)
25. Apple Support — *How to get Siri AI* · https://support.apple.com/en-us/127893 (requirements, voice pick + enrolment, app actions, Visual Intelligence)
26. Apple Developer — *What's new in Apple Intelligence* · https://developer.apple.com/apple-intelligence/whats-new/ (App Intents schemas, entity schemas → Spotlight semantic index with attribution, View Annotations API for on-screen awareness)
27. Apple Support — *Siri AI: Use the Siri app on iPhone* · https://support.apple.com/guide/iphone/siri-ai-use-the-siri-app-p7ny364ngxlj/ios (conversations in one place, continue across devices)
28. Microsoft Support — *Get started with voice features in Microsoft Copilot* · https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-with-voice-features-in-microsoft-365-copilot (dictation vs read-aloud vs Copilot Voice; transcript after the conversation)
29. Microsoft Support — *Using Copilot Voice* · https://support.microsoft.com/en-us/microsoft-copilot/using-copilot-voice-with-microsoft-copilot (greeting, mute, time limits, transcript handled as conversation history, voice choice, mobile playback speed)
30. Microsoft Support — *How "Hey Copilot" wake word works* · https://support.microsoft.com/en-us/microsoft-365-copilot/how-hey-copilot-wake-word-works-in-microsoft-365-copilot (off by default, on-device 10 s buffer never recorded/stored, English-only, accidental activation, 30 s warning / 60 s auto-end)
31. Microsoft Tech Community — *What's New in Microsoft 365 Copilot, January 2026* · https://techcommunity.microsoft.com/blog/microsoft-copilot-blog/what%E2%80%99s-new-in-microsoft-365-copilot--january-2026/4488916 (voice chats reference memory; Outlook voice catch-up; agent mode "shows what it's doing and why")
32. Amazon — *Introducing Alexa+* (updated 2026-07-21) · https://www.aboutamazon.com/news/devices/new-alexa-generative-artificial-intelligence (experts/services orchestration, agentic behind-the-scenes web tasks, personal memory, four personality styles, proactive suggestions, Alexa for Shopping surfaces)
33. Amazon — *How Amazon rebuilt Alexa with generative AI* · https://www.aboutamazon.com/news/devices/new-alexa-tech-generative-artificial-intelligence (Bedrock model routing, Nova/Claude, "we minimized latency", personality optimisation)
34. Amazon — *Personalize your Alexa Privacy Settings* · https://www.amazon.com/b?ie=UTF8&node=23608614011 (voice recordings and transcripts reviewable) — **page not read in full**; snippet-level only
35. Perplexity Help — *Voice Mode (Comet)* · https://www.perplexity.ai/help-center/comet/en/articles/13860420-voice-mode (screen awareness, navigate by voice, context across tabs, mic/headphone mute, 10 voices)
36. Perplexity Help — *Perplexity Voice Assistant for iOS* · https://www.perplexity.ai/help-center/en/articles/11132456-how-to-use-the-perplexity-voice-assistant-for-ios (app integration, sessions saved to history, Action Button/shortcuts, voice settings)
37. Perplexity changelog — *Comet Voice Mode improvements* (2026-02-25) · https://www.perplexity.ai/changelog/comet-voice-mode-improvements (GPT Realtime 1.5, screen awareness, navigate, tab context)
38. Meta Help Center — *Toggle the Full-duplex demo on or off on Meta AI* · https://www.meta.com/help/artificial-intelligence/904614701712615/ (pauses/fillers/expressions; experimental; disables image generation and saved-detail personalisation)
39. ElevenLabs docs — *Client events* · https://elevenlabs.io/docs/eleven-agents/customization/events/client-events (`user_transcript`, `agent_response`, `agent_chat_response_part`, `agent_response_correction`, `agent_response_metadata`, `client_tool_call`/`client_tool_result`, `agent_tool_response`, `agent_tool_response_full_payload`, `agent_response_complete`)
40. ElevenLabs docs — *Client to server events* · https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events (`contextual_update` = non-interrupting background info; `user_message` = as if the user spoke)
41. ElevenLabs docs — *Conversation flow* · https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow (max duration, turn timeout 1–30 s, soft-timeout filler, interruptions on/off, turn eagerness)
42. ElevenLabs UI — *Transcript Viewer* · https://ui.elevenlabs.io/docs/components/transcript-viewer (word-by-word highlighting synced to playback, play/pause, scrub)
43. Vapi docs — *Speech configuration* · https://docs.vapi.ai/customization/speech-configuration (start speaking plan 0.4 s, smart endpointing + backchannel prediction, probability→wait function, stopSpeakingPlan numWords/voiceSeconds/backoffSeconds)
44. Vapi docs — *Server events* · https://docs.vapi.ai/server-url/events (transcript partial/final with role and isFiltered; tool-calls; speech-update started/stopped with turn; model-output with turnId; user-interrupted with turnId)
45. Retell AI — *Conversational turn-taking and interruptions* · https://www.retellai.com/learn/how-ai-voice-agents-handle-interruptions-and-natural-turn-taking (interruption sensitivity 0–1 defaults, per-node overrides, non-interruptible response, backchanneling off by default freq 0.8 with word list, denoising modes incl. background-speech removal, transcription mode endpointing 100–10,000 ms)
46. Retell AI — *Latency Face-Off 2025* (2025-07-13) · https://www.retellai.com/resources/ai-voice-agent-latency-face-off-2025 (Retell 180 ms TTFT / 620 ms E2E / 140 ms barge-in / 45 ms jitter / 99.7 % continuity; thresholds <300 ms, <800 ms, <200 ms; competitor numbers)
47. LiveKit docs — *Turns overview* · https://docs.livekit.io/agents/logic/turns/ (turn detector default, endpointing min/max + dynamic, VAD-only, STT endpointing, realtime-model caveats incl. Gemini Live can't hand turn-taking to the client, interruption events)
48. LiveKit docs — *Adaptive interruption handling* · https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/ (barge-in vs backchannel from acoustics, `backchannel_boundary` (1.0, 1.0), aligned transcripts requirement, realtime all-or-nothing gate, metrics)
49. LiveKit docs — *Text and transcriptions* · https://docs.livekit.io/agents/multimodality/text/ (`lk.transcription` stream, sync_transcription word-by-word, truncation on interruption, TTS-aligned word timings, interim/final with segment ids, `lk.chat` text input interrupts speech, `generate_reply`)
50. LiveKit docs — *Agent session* · https://docs.livekit.io/agents/logic/sessions/ (`agent_state_changed` listening/thinking/speaking, `user_state_changed` incl. `away`, `user_transcription_timeout`)
51. LiveKit docs — *Chat components* · https://docs.livekit.io/frontends/agents-ui/chat/ (`AgentChatTranscript`, realtime transcripts + typed messages, thinking indicator "while the agent is calling an external tool")
52. Pipecat docs — *The RTVI Standard* · https://docs.pipecat.ai/client/rtvi-standard (`user-transcription`, `bot-transcription` per sentence, `bot-tts-text` for word timing, `user-started-speaking`, `vad-user-started-speaking`, documented timestamp limitation)
53. Pipecat docs — *Interruptions* · https://docs.pipecat.ai/pipecat/fundamentals/interruptions (in-flight LLM/TTS cancellation, only spoken text committed to context, `MinWordsUserTurnStartStrategy(min_words=3)`, Krisp VIVA interruption prediction, mute vs disable semantics, provider-side barge-in for realtime services)
54. VS Code docs — *Voice support* · https://code.visualstudio.com/docs/configure/accessibility/voice (Voice Mode spoken conversation with the agent while it works, `agents.voice.showTranscript`, `handsFree`, voice selection, mute, "announces when it routes a request to an existing session or starts a new one", dictation on-device + 20-min cap + LLM cleanup)
55. Cursor — *Tiled Layout and Upgraded Voice Input in the Agents Window* (changelog 3.1) · https://cursor.com/changelog/3-1 (voice input = batch-STT dictation with waveform/timer/cancel/confirm)
56. Windsurf / Devin — *Cascade Overview* · https://docs.windsurf.com/windsurf/cascade/cascade (voice input "can transcribe your speech to text"; Todo list tracks task progress in the conversation)
57. Zed — *Roadmap* · https://zed.dev/roadmap (voice input / voice activation listed as planned)
