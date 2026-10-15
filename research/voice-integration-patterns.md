# Voice interfaces in coding agents: integration architecture, UI surface, and authorship/provenance

**Date:** 2026-10-15 (AEST)
**Method:** Delegated multi-track primary-source research (5 tracks) + direct re-verification of the load-bearing claims by reading vendor docs, SDK changelogs and harness source code. Every claim carries a URL. Claims I read myself are marked **[V]** (verified by me, primary source); claims a research track quoted from a primary source that I did not re-read myself are marked **[R]** (reported from primary source, not independently re-checked); **[U]** marks UNVERIFIED.
**Scope:** *integration architecture and UI surface*, not the audio stack. Central question: **does the voice layer participate in the session as a distinct AUTHOR, or does it merely proxy/produce the user's input?**
**Confidence:** High on (a) the headline answer — no mainstream coding agent gives voice a distinct author identity in its session model — and (b) the editor UI-surface pattern. Medium on Codex's experimental app-server realtime surface (source-verified but undocumented) and on Anthropic's exact transcript rendering. Low/UNVERIFIED where noted.

**TL;DR / headline answer for DSH**

1. **No shipping coding agent gives a voice-originated message a distinct author identity.** In every case studied the voice transcript becomes a plain **user-role message**. Where these products *do* mark provenance, they mark it at the **turn** level (a trigger/attribution string), as an **in-band text marker**, or as a **UI colour** — never as a per-item author field on the message.
2. **The one product family that does have first-class provenance is not a coding harness**: ticketing/support (Zendesk, Intercom, Freshdesk), chat platforms (Slack, Teams, Google Chat, Discord) and OpenHands. They converge on a clean two-axis model — **attribution (who produced it) is independent of role (how it is formatted for the model)** — and they implement your two verbs (silent note / visible say) as either one boolean or a type split.
3. **The UI surface is settled and unanimous against overlays.** Every mainstream editor ships voice as an **inline microphone / Voice Mode control inside the existing chat panel's input**, or as a TTS reader of the panel's replies. No studied product mounts voice as a `position:fixed` overlay. This is independent corroboration of DSH's own "a drawer is not a column" verdict.

---

## 0. Vocabulary used below

| Term | Meaning |
|---|---|
| **Attribution / provenance** | who produced a message (human, agent, bot, tool, environment, voice) |
| **Role** | how the message is formatted for the model (`system`/`user`/`assistant`/`tool`) |
| **Silent note** | content injected into context that does **not** start a turn (DSH verb 1) |
| **Visible say** | a sourced message that **does** start a turn (DSH verb 2) |
| **Thread item** | the renderable/storable unit of a session (message, tool call, …) |
| **Turn** | one request/response cycle of the agent loop |

The industry's clearest statement of the taxonomy is OpenHands, quoted verbatim from its SDK docs **[V]**:

> "`Event.source`: where the event originated (`user`, `agent`, or `environment`). This is about attribution. / LLM `role` … how the event should be represented to the LLM … This is about LLM formatting. **These fields are intentionally independent.** … the SDK may inject feedback or control messages (e.g. from hooks) as `source="environment"` while still using an LLM `role="user"` so the agent reads it as a user-facing instruction."
> — https://docs.openhands.dev/sdk/arch/events

---

## 1. OpenAI Codex

### 1.1 What ships

| Surface | Status | Evidence |
|---|---|---|
| ChatGPT Voice (GPT-Live-1 full-duplex) inside **Codex tasks** in the ChatGPT desktop app (macOS/Windows), with paired-iOS control | Shipped; "voice in an existing text task" explicitly **rolling out** | learn.chatgpt.com/docs/features/voice; help.openai.com ChatGPT release notes (July 2026 entries) **[R]** |
| **Codex CLI/TUI** voice | Shipped but **experimental**: enabled via `/experimental` + restart, then `/voice`; platform-restricted (macOS / MSVC Windows / glibc Linux); disabled in side conversations | codex-rs/tui/src/slash_command.rs, …/tooltips.rs, …/chatwidget/realtime.rs **[R]** |
| **App-server** `thread/realtime/*` API | Experimental, **undocumented** (`#[experimental]`, requires `capabilities.experimentalApi`) | codex-rs/app-server-protocol/src/protocol/common.rs **[R]** |
| **dots** (always-on cloud agents, voice-callable) | Shipped, but *not* a Codex thread author — a dot owns the voice conversation and drives Codex by creating/continuing tasks | learn.chatgpt.com/docs/dots **[R]** |

### 1.2 Architecture: how voice attaches

- **Voice is a thread-scoped client of app-server and does not create its own thread.** `thread/realtime/start` is keyed by a required `thread_id`; app-server loads that existing thread and subscribes the calling connection. Methods: `thread/realtime/{start, appendAudio, appendText, appendSpeech, stop, listVoices}`; notifications: `…/{started, itemAdded, item/started, item/transcript/delta, item/completed, transcript/delta, transcript/done, outputAudio/delta, sdp, error, closed}`. **[R]** (realtime.rs fetched by me at HEAD returns 16 KB and contains no `turn_trigger` etc.; I did not enumerate its members myself — treat the member list as reported.)
- **Transport is signalled, not proxied**: server returns remote SDP via `thread/realtime/sdp` and the client owns the WebRTC session; socket clients stream audio through `appendAudio` and receive `outputAudio/delta`. **[R]**

### 1.3 Does voice-produced content become a distinct author? **No.**

This is the strongest, most directly relevant finding of the whole study, and I verified the core of it myself in source:

- **`ThreadItem` has no author/role field** — authorship is *implied by the variant* (userMessage / hookPrompt / agentMessage / commandExecution / …). I read `item.rs` at HEAD: `UserMessage { id: String, client_id: Option<String>, content: Vec<UserInput> }` — **no `source`, `origin`, `author` or modality field**. **[V]** https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs
- **Voice-originated input lands as an ordinary `userMessage`.** The only marker is **in-band XML in the text**. I read `realtime_delegation.rs` at HEAD: `enum RealtimeDelegationSource { Handoff, TranscriptTailFlush }`, `type_markers() -> ("<realtime_delegation>", "</realtime_delegation>")`, `role() -> "user"`, and a 4 KiB field truncation cap. **[V]** https://github.com/openai/codex/blob/main/codex-rs/core/src/context/realtime_delegation.rs
  - Second path: transcript-tail flush at session end wraps remaining transcript with an extra `<source>transcript_tail_flush</source>` marker, still as a `UserMessage` item. **[R]**
- **OpenAI's own TUI recovers provenance by string-matching the wrapper** and by keeping local client-side state (`latest_input_was_voice`, `latest_voice_input_fingerprint`, `RealtimeTurnOrigin::{Typed, Delegated}`) — i.e. **the protocol provides no structured seam, so the client reconstructs one**. **[R]** https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/realtime.rs
- **The only visible authorship affordance in the TUI transcript is a colour.** I read `messages.rs` at HEAD: `UserHistoryCell { message, text_elements, …, pub(crate) spoken: bool }` and the render `if self.spoken { "› ".red().bold() } else { "› ".bold().dim() }` — **rendered raw text is identical**, so copy/export/logs cannot tell spoken from typed. **[V]** https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/messages.rs
- **Voice items are deliberately excluded from stored thread history**: realtime items are persisted to the rollout as `RolloutItem::RealtimeItem`, but the app-server thread-history builder explicitly ignores them, so they are **not** returned by `thread/read`, `thread/resume` or `thread/fork`; only ephemeral notifications carry them. **[R]** (thread_history.rs, protocol/src/realtime.rs, commit 94709228 README wording) — *the ephemerality sentence itself I could not find at HEAD; main README now mentions realtime only in a routing note. Treat "ephemeral, not ThreadItems" as REPORTED-from-commit.*

### 1.4 The structured provenance seam that *does* exist — turn-level, and write-only

I verified these in source at HEAD:

- `TurnStartParams { thread_id, client_user_message_id, input, turn_trigger, tool_output, … }` where `turn_trigger` is documented **"Optional source classification for the caller that starts this turn. Ignored when this request steers an already-active turn."** **[V]** https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs
- `TurnStartOptions { turn_trigger, final_output_json_schema, service_tier, parent_turn_id, root_turn_id, … }` — `turn_trigger` = "Source classification for the caller that starts a new turn. **Ignored when the submitted input steers an active turn.**"; `parent_turn_id` / `root_turn_id` = "Parent/Causal root turn lineage recorded **if this request starts a new turn**". **[V]** https://github.com/openai/codex/blob/main/codex-rs/protocol/src/turn_input.rs
- Reported values in code/tests include `'realtime'`, `'user'`, `'goal'`, `'queue'`, `'automation'`, `'daemon_recovery'`, `'memory_consolidation'` — a **free-form string, not an enum**. **[R]**
- **It is write-only from the client's perspective**: it is persisted in the rollout and sent to the model in Responses metadata (`x-codex-turn-metadata`, reserved keys), but the read model (`Turn { id, rootTurnId, items, status, … }`) and the `turn/started` notification drop the attribution, so **after the fact nothing tells a client that a turn was voice-originated**. **[R]**
- **Precedent that Codex *does* model non-user actors**: `commandExecution.source: CommandExecutionSource` (`agent | userShell | unifiedExecStartup | unifiedExecInteraction`); distinct item types `collabAgentToolCall`, `subAgentActivity`; `hookPrompt { id, fragments }`. I confirmed the `source: CommandExecutionSource` field exists on the command item at HEAD **[V]**. So **distinct authorship is modelled for agents/tools/hooks, but user-shaped input from a non-typing source (voice) has no equivalent.** **[V/R]**
- **Closest thing to a "silent note" write path**: `thread/inject_items` — "Raw Responses API items to append to the thread's model-visible history… without starting a user turn"; persisted and model-visible, but the thread-history builder materialises only user-role hook prompts, so injected items are invisible in the rendered thread. **[R]**

> **Direct answer for Codex:** voice does **not** participate as an author. It attaches to the existing thread, writes ordinary `userMessage` items, and its only provenance is (i) an in-band XML wrapper, (ii) a TUI colour, (iii) an optional turn-level trigger string that is ignored on steer and never surfaced on read. **DSH's `SessionController.prompt()` hard-coding USER provenance matches the leading implementation rather than diverging from it.**

---

## 2. Claude Code / Anthropic, and the published protocols

### 2.1 Voice in Claude Code: dictation only, input only

- `/voice` **dictation** ships in the CLI and the VS Code extension: push-to-talk (hold Space) or tap; **speech is transcribed into the prompt input at the cursor** and mixed with typing. Not a voice mode with spoken replies. **[R]** https://code.claude.com/docs/en/voice-dictation
- Anthropic's own FAQ, quoted: *"In Claude Cowork and Claude Code, dictation is available but voice mode isn't."* Full-duplex voice exists only in the Claude chatbot apps. **[R]** https://support.claude.com/en/articles/11101966-use-voice-mode
- Constraints: requires a claude.ai sign-in (unavailable with API-key/Bedrock/Vertex auth), requires a local mic (fails in cloud/SSH sessions), audio streamed to Anthropic servers, does not consume tokens. **[R]**
- **Consequence:** because dictation writes into the human's own prompt buffer, **every voice-originated message in Claude Code is user-authored by construction.** No first-party TTS/read-aloud for Claude Code. **[R]**

### 2.2 Published ingress protocols for writing into a session

| Mechanism | Status | Attribution of injected content |
|---|---|---|
| **MCP "channels"** via the `claude/channel` capability + `notifications/claude/channel`, opt-in per session (`--channels`), research preview, Anthropic-auth and org-gated | shipped (preview) | **user-role with `origin.kind = "channel"`**; rendered as an attributed inbound line, not a user bubble **[R]** |
| **Cross-session messaging** — `ListAgents`/`SendMessage` + a per-session **Unix-domain-socket inbox** exported as `CLAUDE_CODE_MESSAGING_SOCKET` + `CLAUDE_CODE_MESSAGING_TOKEN`; documented "when you want a script or hook to post into a session" | shipped (v2.1.224+) | **user-role with `origin.kind = "peer"`**; rendered as a dim one-line preview `› Message from @api-worker: …` **[R]** |
| **Hooks** `hookSpecificOutput.additionalContext` (SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop …) | shipped | wrapped in a **`<system-reminder>`**; **"it doesn't appear as a chat message in the interface"** — the silent-note analogue **[R]** |
| **Agent SDK** `SDKUserMessage` (`shouldQuery`, `origin`, `priority`, `client_composed`, `isSynthetic`) | shipped | **user-role + first-class `origin` tag** **[V — see §2.3]** |
| **Headless/print** `claude -p`, `--cloud <session-id> -p` ("queues a message into that cloud session and exits") | shipped | no provenance concept **[R]** |
| **VS Code extension's local `ide` MCP server** | shipped | internal RPC only; **no documented message-submit API** **[R]** |
| **Remote Control** from claude.ai / mobile | shipped | steers an in-progress session **[R]** |
| **Native ACP support in Claude Code** | **not shipped** (issue #6686 closed) | n/a |
| **A first-class "inject a prompt into a running session" API** | **not shipped** — #24947, #27441, #27545, #27873 all closed; issue bodies state "there is no API, socket, or pipe to inject a prompt into an active session" | n/a |

### 2.3 The one place a coding agent has real message provenance: the Claude Agent SDK

This is the single most transferable finding for DSH, and **I verified it myself in two primary sources**.

**From the SDK type reference (platform.claude.com — the host the SDK CHANGELOG itself points to as the complete reference) [V]:**

```ts
type SDKUserMessage = {
  type: "user"; uuid?: UUID; session_id?: string;
  message: MessageParam; parent_tool_use_id: string | null;
  isSynthetic?: boolean; shouldQuery?: boolean;
  tool_use_result?: unknown; origin?: SDKMessageOrigin;
};
```
> "Set `shouldQuery` to `false` to append the message to the transcript **without triggering an assistant turn**. The message is held and merged into the next user message that does trigger a turn. Use this to inject context … **without spending a model call on it.**"
> — https://platform.claude.com/docs/en/agent-sdk/typescript

**From the primary SDK CHANGELOG (anthropics/claude-agent-sdk-typescript, main) [V]:**
- v0.2.110 — *"Added optional `shouldQuery` field to `SDKUserMessage` — set to `false` to append a user message without triggering an assistant turn"* ← **exactly DSH's "silent note" verb, shipped**
- v0.2.126 — *"Added `origin` to result messages … forwards the triggering message's `SDKMessageOrigin` so consumers can distinguish user-prompted results from `task-notification` followups"*
- `SDKMessageOrigin` members observed in changelog entries: `task-notification` with `subkind: 'scheduled-trigger'` and `subkind: 'peer-send-message'`; the reference additionally lists `{kind:"human"}`, `{kind:"channel", server}`, `{kind:"peer", …}`, `{kind:"coordinator"}`, `{kind:"auto-continuation"}`, `{kind:"unclassified"}` **[R for the full list]**
- *"Fixed `SDKUserMessage.isSynthetic` not being mapped to `isMeta` on ingestion, **which could cause synthetic messages to be treated as real user messages**"* — i.e. `isSynthetic` is the "not typed by the user" flag **[V]**
- `origin: { kind: "human" }` is used in the shipped reference for "queued turns the user sent" **[V]**

> **So: Claude Code's model is "everything is a user-role message, but a user-role message can carry an `origin` tag", and `shouldQuery:false` is a true non-turn-starting injection.** Anthropic's own docs frame the field as *"Provenance of a user-role message"*. This is the closest thing in the market to a designed answer to the DSH question — and it is in an **SDK**, not in the CLI's own message model.

**Documentation divergence worth flagging [V]:** the same doc path exists on two hosts and their contents differ — `platform.claude.com/docs/en/agent-sdk/typescript` contains the `SDKMessageOrigin`/`shouldQuery`/`isSynthetic` reference; `code.claude.com/docs/en/agent-sdk/typescript` (119 KB, fetched by me) does **not** contain `SDKMessageOrigin`, `shouldQuery` or `isSynthetic` at all (its only "provenance" is settings-resolution `provenance` and `McpServerProvenance`). Do not cite the `code.claude.com` copy for provenance claims.

### 2.4 ACP is third-party, and has no provenance concept

- **ACP (Agent Client Protocol)** is **Zed Industries'** protocol, not Anthropic's: published at agentclientprotocol.com, owned by the `agentclientprotocol` GitHub org, launched as *"our new Agent Client Protocol (ACP) … our new open standard that lets any agent connect to Zed"*. **[R]** https://zed.dev/blog/claude-code-via-acp
- Claude Code's ACP support is an **adapter around the Anthropic SDK** (`agentclientprotocol/claude-agent-acp`, formerly `zed-industries/claude-code-acp`); Anthropic's request for native support was closed. **[R]**
- ACP's write verb is **user-only**: a turn begins with `session/prompt` carrying a **User Message**; the Agent reports output via `session/update` (`agent_message_chunk`, `tool_call`, `plan`, `usage_update`). **There is no ACP method for injecting assistant- or system-authored content, and no `origin`-style attribution field.** **[R]** https://agentclientprotocol.com/protocol/v1/prompt-turn.md
- **MCP** is a tool/resource protocol; it is not a session-message protocol with authorship semantics. (Anthropic's *channels* capability, built on MCP, is the closest thing — see §2.2.)

---

## 3. Editors and IDEs: the UI-surface verdict

### 3.1 The pattern

> **Voice is an affordance *of the existing chat/agent panel*, delivered as an inline microphone button (and/or a Voice Mode button) **inside that panel's input box** — never a floating overlay or drawer.**

**[V]** VS Code: *"Dictation inserts text in the input but does not submit the request."* and Voice Mode *"lets you have a hands-free conversation…"* — https://code.visualstudio.com/docs/configure/accessibility/voice

| Product | Voice in | Voice out | How the spoken result enters the session | UI surface |
|---|---|---|---|---|
| **VS Code / Copilot Chat** | ✅ built-in dictation (on-device ASR) + experimental **Voice Mode** | ✅ Voice Mode reads agent replies aloud (`agents.voice.speakResponses`, `handsFree`) | Dictation **inserts text, does not submit** — user presses Enter. Voice Mode **sends the spoken request to the active chat/agent session** and "announces when it routes a request to an existing session or starts a new one" | **Inline mic + Voice Mode button in the chat input**; also Agents-window input, editor (mic at cursor) and terminal **[V/R]** |
| **Cursor** | ✅ voice input (Cursor 2.0, 29 Oct 2025; reworked 3.1) | ❌ for the coding agent (separate spoken "Bot" chat exists) | Transcription **lands in the chat input for review**; user-defined **submit keywords** can auto-run | **Inline mic icon in the chat input**; 3.1 adds waveform/timer/cancel chrome at the same input and hold-Ctrl+M. **[R]** |
| **Windsurf / Devin Desktop (Cascade)** | ✅ voice input | ❌ | "Use Voice input to … interact with Cascade. In its current form it can **transcribe your speech to text**" | **Cascade agent panel** (Opened with Cmd/Ctrl+L) **[R]** |
| **Zed** | ❌ **not shipped** — roadmap lists "Hands-Free Coding" under *Currently Working On*; issue #16410 open since Aug 2024 | ❌ | n/a (requests ask for an editable, reviewable text insert in the Agent Panel composer) | Agent Panel composer (proposed) **[R]** |
| **JetBrains** | ❌ AI Assistant / Junie: no first-party voice (docs show typed prompts only). ✅ separate product **Air**: local Whisper | ❌ | "click the microphone button in the task input and dictate the task" | **Mic button in the task input** **[R]** |
| **Replit Agent** | ✅ Voice Mode | ❌ explicitly: *"It does not read Agent's responses aloud."* | "inserts the result into the chat box for you to review before sending… **nothing is sent automatically**"; "the transcript appears as regular text in the chat box, so you can mix voice and typing freely" | **Mic in the Agent chat box** **[R]** |
| **GitHub Copilot** | via VS Code (above) | via VS Code | as VS Code | as VS Code |

**Conclusion for the overlay question:** of the editors examined, **none** mounts voice in a `position:fixed` overlay. The sanctioned surfaces are (a) the chat panel/agent panel dock, (b) the chat input box (inline mic), and (c) a writable editor/terminal input for pure dictation. **This is independent market evidence supporting DSH's rejection of overlays/drawers, and it identifies the corrective for the current plugin GUI defect: the voice control belongs inside the session's own panel/composer, not floating over the conversation.**

### 3.2 Can an extension write into the transcript as a non-user author? (VS Code API)

| API | What it can do | Attribution |
|---|---|---|
| **Chat Participants** (`vscode.chat.createChatParticipant` + `contributes.chatParticipants`) | write into the chat panel via `ChatResponseStream.markdown/button/progress/…` | response turns are attributed to the **producing participant**; history exposes `ChatRequestTurn` (documented as "a user request") and `ChatResponseTurn` ("a chat participant's response") **[R]** |
| **Language Model API** (`vscode.lm.selectChatModels` → `model.sendRequest`) | generate content, returned **to the extension**, not into the built-in transcript | only `LanguageModelChatMessage.User`/`.Assistant` exist; **no system role, no "voice" role** **[R]** |
| **Chat Sessions API** (`chatSessions` contribution point, `provideChatSessionContent` → `ChatSession`) | **proposed API** — an extension can own and stream a whole session transcript into the native chat UI | deepest available seam; still request/response shaped (`ChatRequestTurn2 | ChatResponseTurn2`) **[R]** |
| **`workbench.action.chat.open`** with `{ query, isPartialQuery }` | `isPartialQuery:true` prefills the input and waits; `false` calls `acceptInput()` and submits | **submits as the user** — the documented "write as if typed" path **[R]** |
| `ChatRequestTurn2.isSystemInitiated?: boolean` (proposed) | flags "this request was initiated by the system rather than the user" | the **only** non-user marker found; **there is no general author/provenance label** and no supported way to persist a message in the built-in transcript attributed to a distinct non-participant author **[R/U — absence is inferred from the API surfaces reviewed]** |

---

## 4. Voice-agent building-block platforms: what to reuse vs reimplement

### 4.1 Comparison

| | **ElevenLabs Agents** | **Vapi** | **Retell AI** | **LiveKit Agents** | **Pipecat** |
|---|---|---|---|---|---|
| **Transports** | WebSocket (`wss://…/v1/convai/conversation`), signed-URL brokers, SIP + telephony connectors (Twilio/Vonage/Telnyx/Plivo/Bandwidth/Sinch), iOS/Android/RN SDKs, React widget; WebRTC brokered via LiveKit | SIP trunking; dedicated **WebSocket** transport (`transport.provider='vapi.websocket'`, PCM16/mu-law + JSON control frames); WebRTC "via LiveKit/Daily"; client/server SDKs; Call Listen monitor socket | SIP trunking; browser **Web SDK** (server-minted `access_token`, 30 s TTL); **deprecated** raw audio WebSocket; provider media-stream integrations; outbound LLM WebSocket | **WebRTC SFU is the core** — every client/agent/phone joins a room as a participant; SIP via trunks + dispatch rules; server is open-source and self-hostable | **Modular, swappable** transports: Daily, SmallWebRTC, LiveKit, FastAPI/WebSocket, MoQ, Vonage, WhatsApp; client SDKs incl. **direct OpenAI Realtime WebRTC**; telephony over WebSocket serializers |
| **Turn detection / VAD** | Proprietary turn-taking model + `turn_timeout`, `turn_eagerness`, `soft_timeout`; `vad_score` event; **not replaceable** | `StartSpeakingPlan`/`StopSpeakingPlan`: waitSeconds, smart endpointing (Krisp, Deepgram Flux, LiveKit, Vapi model), `numWords`, `voiceSeconds`, `backoffSeconds`; server-side custom endpointing hook. **Orchestration layer is proprietary and non-customisable** | Platform-managed turn-taking; tuning via denoising modes, interruption sensitivity, transcription speed/accuracy trade-off. Also supports realtime models | Four modes: LiveKit turn-detector model (audio+text), **`realtime_llm`** (the realtime model decides barge-in), VAD-only, STT endpointing; Silero VAD bundled; adaptive interruption | VAD (Silero) **or** transcription-based start; end-of-turn via Smart Turn / SpeechTimeout / STT endpointing / Krisp VIVA; `VADParams`; `InterruptionFrame` broadcast |
| **Tools / function calling** | Client tools, webhook tools, code tools, **MCP tools**, system tools (`end_call`, `transfer_to_number`, **`transfer_to_agent`**, `skip_turn`, `update_state`, `language_detection`, …); post-call webhooks | OpenAI-style tool calls; API-request tools, server webhook tools, built-ins (transfer/end/SMS/DTMF), **MCP**, client-side Web SDK tools, query/knowledge-base tool; tool rejection plan, static params, `variableExtractionPlan` | Function calling, custom functions, integration tools (HubSpot/Salesforce/Zendesk/…), code tool, **MCP**, conversation-flow nodes; built-ins: end call, transfer call, **agent transfer**, SMS, DTMF, extract variable; webhooks (`call_started/ended/analyzed`, `transcript_updated`) | Function tools, toolsets, async tools, **MCP**, forward tool calls to frontend via RPC; prebuilt tools/tasks; LangChain/LangGraph | Handler-registered functions (`FunctionCallParams`), per-tool `cancel_on_interruption`/`cancellable_by_llm`, **MCPClient**, observer/filter pipeline |
| **Session state** | Conversation history stored **server-side** (Conversations API: list/get/summaries/search); dynamic variables + overrides; `contextual_update` / `user_message` client→server context injection | Call object + artifacts (recording/transcript/messages); `conversation-update` server event carries messages; `previousChatId`/`sessionId` for chat context | **Call object is source of truth** (same `call_id` across agent swaps); metadata, dynamic variables, contact memory; retention controls | `AgentSession` state machine (`initializing→starting→running→closing`), `session.userdata`, room/participant as identity substrate, `user_away_timeout` | `LLMContext` + `LLMContextAggregatorPair`; per-worker context; `LLMContextSummarizer`; transcript-saving mechanism |
| **Transcript events** | JSON over the socket: `user_transcript` (final only), `agent_response`, `agent_response_correction` (truncation on interruption), `agent_chat_response_part {start|delta|stop}`, `vad_score`, `agent_tool_response`, `mcp_tool_call`, char-level audio `alignment` | `{message:{type,...}}`: `transcript {role: user|assistant, transcriptType: partial|final}`, `speech-update`, `assistant.speechStarted` (accumulating, opt-in word timing), `user-interrupted {turnId}`, `conversation-update`, `end-of-call-report{messages[]}` | Monitor WebSocket: `transcript_snapshot`, `transcript_updated`, `call_ended`; **stable item ids keyed by role+counter, replaced by id**; item roles incl. `user`, `agent`, `tool_call_invocation`, `tool_call_result`, `node_transition`, `dtmf`, `sms`, **`injected`**; `time_sec` only (no per-word) | Text streams on `lk.transcription` with `lk.transcribed_track_id`, shared `segment_id`, `lk.transcription_final`; **sender identity = the transcribed participant**; optional TTS-aligned per-word JSON | RTVI `onUserTranscript`/`onBotTranscript` with `{text, final}`; server-side observers + `on_assistant_turn_stopped` |
| **Handoff / multi-agent** | `transfer_to_agent` system tool; nested transfers; **full transcript preserved**; transfer tool call **stripped from the child's visible history** — and **individual messages carry no `agent_id`, so the transfer call is the authorship boundary marker** | Assistants + **Squads** with context-preserving transfers; handoff tool with static/dynamic destinations; `contextEngineeringPlan` (`lastNMessages` / full history); silent handoffs; handoff hooks | **Agent Transfer** (`agent_swap`) on the **same call_id**; inherits full history, metadata, dynamic variables; chains and can transfer back; can't target a custom-LLM or chat agent | Change agent via `session.update_agent(…)` **or by returning a different Agent from a tool call**; supervisor pattern | Workers with a bus: `activate_worker(target, deactivate_self=True)`; job coordination, distributed/proxy agents |
| **Open source / self-host** | ❌ closed SaaS (open client SDKs). Only BYO hook is **Custom LLM** (OpenAI-compatible SSE endpoint) | ❌ closed; BYO transport/transcriber/LLM/voice; **orchestration layer never customisable**; "on-premise for large Enterprises" claimed, no docs **[U]** | ❌ closed hosted SaaS; open client SDK; no self-host docs | ✅ **Apache-2.0** framework + server; Cloud-only extras (managed agent hosting, observability) | ✅ **BSD-2-Clause**; self-host or Pipecat Cloud |
| **Pricing (list)** | per call-minute; Pro $99/mo ≈ 1,238 min; hosting $0.080/min included calls | $0.05/min + provider costs at cost; 10 concurrent lines; enterprise add-ons | $0 to start; ~$0.07–$0.31/min all-in | Free framework; Cloud $0/$50/$500/mo + ~$0.0100/agent-min | Free framework; Cloud agent profiles $0.01–$0.03/min |

*All rows in this table are **[R]** (reported from primary vendor docs by the research track; URLs in the evidence trail) unless noted. Pricing is list price captured at research time.*

### 4.2 Directly relevant: Pipecat already ships a GPT-Live-1 service

**[V]** I read this page myself:

> `OpenAILiveLLMService` connects Pipecat to OpenAI's GPT-Live API using the **`gpt-live-1`** model for full-duplex speech-to-speech — the model decides when to answer, stops when talked over, and delegates search/reasoning/tool work to a backend text model while the conversation continues; there is explicitly **"no client-side turn detection or response triggering"**.
> Two delegation modes: **`ResponsesDelegation`** (OpenAI hosts the backend; uses the tools from your pipeline's `LLMContext`) and **`ClientDelegation`** (any Pipecat LLM service in a `BackendLLMWorker` you provide).
> **"No local VAD: the model detects the user's turns itself, so the pipeline needs no VAD analyzer."**
> What the backend returns is appended to the live session according to each output's **`prefers_spoken`** flag: *"text the backend wants heard is appended as commentary, which the model relays in its own words, and the rest as **silent context** the model can draw on."*
> — https://docs.pipecat.ai/api-reference/server/services/s2s/openai-live.md

This is **the closest existing implementation to dsh-openai-live**, and its `prefers_spoken` distinction is essentially the machine representation of DSH's "silent note vs visible say" split — one flag deciding whether backend output is *spoken* or *silent context*.

Pipecat also ships an **`OpenClawGatewayService`** that drives an OpenClaw coding agent from a pipeline (start, steer, …) and a **UIWorker** that lets a voice agent read/act on a client GUI. **[R]**

### 4.3 Reuse vs reimplement — verdict

**Reuse (do not rebuild):**
- **Media transport**: WebRTC via LiveKit/SmallWebRTC, or a plain WebSocket audio transport (Pipecat's / Vapi's pattern). Nothing domain-specific to a coding harness.
- **Barge-in *local effects***, not the decision: copy Pipecat's `InterruptionFrame` contract — cancel in-flight generation, drop queued TTS, flush unplayed audio, **commit only the words actually spoken**. With GPT-Live the **decision** is the provider's ("no local VAD"), so adding a second barge-in detector would double-interrupt.
- **Silero VAD** only for UI affordances (speaking indicator, caption timing), never as the turn decision.
- **Tool-call envelope + per-tool cancellation metadata** (`cancel_on_interruption` / `cancellable_by_llm`), while the **harness keeps ownership of the tool registry**.
- **Handoff-as-a-tool-call + an explicit context-carry policy** (Vapi `contextEngineeringPlan: lastNMessages`, Retell "full history + metadata + dynamic variables").
- **Transcript schema *shape***: interim/final flag + stable item ids replaced by id (Retell) and shared `segment_id` (LiveKit) — idempotent, reconnect-safe.
- **Author-identity emitted with transcript items** (LiveKit's "sender identity = the transcribed participant"), because **ElevenLabs does *not* tag messages with `agent_id`** and instead uses the transfer call as a boundary marker — if you integrate such a platform you must synthesise authorship yourself. **[V partial: ElevenLabs transcript-preservation + tool-call-stripping verified by me at the agent-transfer doc]**
- **Observability shapes**: Pipecat's observer pattern (Transcription/Speaking/TurnTracking/FunctionCall/LLM) + OpenTelemetry export.

**Reimplement (do not delegate):**
- **The agent loop / orchestration.** Vapi's orchestration layer is explicitly proprietary and non-customisable; ElevenLabs' turn-taking model always decides turn end; Retell manages turn-taking and only polls your server. **The harness must own the loop.**
- **Session/context ownership.** These platforms own conversation history server-side; for a coding session **the harness's session log must remain authoritative** — mirror only a lightweight voice transcript.
- **Identity/tenancy/auth.** Bind voice sessions to the harness's session id; treat a platform participant id as an alias. Signed URLs / server-minted tokens are the reusable *pattern*, not the provider.
- **Avoid closed metered platforms in the voice path** if the turn model must stay yours.

**Single pick if only one building block is reused: Pipecat** — BSD-2-Clause, self-hostable, first-class `gpt-live-1` service with a delegation model that already matches "voice is I/O, the harness is the reasoner", plus RTVI transcript events and an interruption contract, **without forcing its own agent loop**. LiveKit is the runner-up where a first-class distinct participant identity and room-native media/SIP are wanted.

---

## 5. Provenance patterns: what products actually do when a second actor writes into a human's session

Four dispositions were found in the wild. **The two most directly analogous products (OpenHands, Zendesk) chose (iii) + (iv), not (i) or (ii).**

### (i) Fold the automated actor into the **user** role
Named exemplars: Slack `chat:write.customize` scope and `xoxp-` user tokens render the app's message **as the human**; GitHub OAuth user access token "identifies the app as the user who signed into the app"; Google Chat user authentication (still shows the app name); Intercom "Bots and campaigns send messages **on behalf of** Admins or Teams"; Anthropic `tool_result` delivered inside a user message; Continue serialising `<context name=…>` into the user body; **Claude Code `<system-reminder>` as an `isMeta: true` user message.** **[R]**
> Slack treats this as a **permissioned capability**, not a default: posting "messages that appear to have been created by a user … requires the extra `chat:write.customize` scope … 'must only be used when the user themselves gives permission.'" **[R]** — i.e. **distinct provenance is the default; folding into the human is opt-in and scope-gated.**

### (ii) Give it the **assistant** role
OpenHands `MessageEvent(agent) → assistant`, `ActionEvent → assistant + tool_calls`; OpenTelemetry `gen_ai.output.messages` with `role: assistant`. **[R]**

### (iii) Give it its **own distinct role / source label** ← the pattern DSH wants
| Product | Mechanism | Rendering |
|---|---|---|
| **Slack** | `subtype: bot_message` + `bot_id`/`bot_profile` ("like a normal user message, except it has no associated user") | bot/APP presentation; `username`/`icon_url` overrides are display-only **[R]** |
| **Zendesk (messaging)** | author type `user` vs **`business`**; *"Business messages may also be sent by AI agents, third-party bots, directly using the API, or produced automatically by the platform. Each message has a `source` property that identifies where it came from."* Plus `via` type enum (`rule`, `web_service`, `chat`, `answer_bot`, …) and comment **flags 4** ("automatically generated") and **2** ("author was not part of the conversation") | AI-agent tickets get a **bot icon in the tab, an "AI agent" badge in the header**, greyed fields, hidden composer, and a distinct `Support type = Agent` so they can be filtered out of human views **[R]** |
| **Intercom** | conversation part `author.type ∈ {user, admin, bot}` — *"the type of individual that sent the message"* | bot is a first-class author; note-vs-reply is a **separate axis** (`part_type: comment | note`) **[R]** |
| **GitHub** | automated actors get **their own account**: installation token "identifies the app as a GitHub App bot account, such as `@jenkins[bot]`", vs a user token which "identifies the app as the user" | PR comment renders "dependabot bot commented on behalf of github"; commits carry `Signed-off-by: dependabot[bot]` **[R]** |
| **Discord** | `webhook_id`/`application_id` + `APP` badge; *"Discord has no API for acting as your own account… an application's messages carry an `APP` badge… No setting, permission, or endpoint removes it."* | structurally enforced **[R/U — badge wording from third-party docs]** |
| **Teams** | bots cannot control bubble alignment (*"Teams client always renders bot messages on the left and user messages on the right"*) plus `addAiGenerated()` badge + non-customisable disclaimer | author provenance is **structurally rendered and not actor-controllable** **[R]** |
| **Google Chat** | `User.type ∈ {HUMAN, BOT}` — a **typed field**; app auth → "Chat displays the Chat app as the message sender"; user auth → "displays the user … and attributes the Chat app to the message by displaying its name". API-enforced: updating a message is "only permitted on a `CARD_CLICKED` event where the message sender type is `BOT`" | typed + attributed **[R]** |
| **Cline** | per-row `ClineMessage {type: ask|say, ask?, say?}` over kinds (`task`, `text`, `reasoning`, `tool`, `command`, `completion_result`, `hook_status`, `subagent`, `compaction`); only the first row is the user's prompt | every kind gets its own row component **[R]** |
| **Aider** | three provenance classes in one transcript: `>` blockquote = tool output, `####` heading = "chat messages written by the user", blue = the LLM; tool lines are **inert** (not turns) | distinct channel **[R]** |
| **OpenHands** | `Event.source ∈ {user, agent, environment}` (**attribution**) independent of LLM `role` (**formatting**) | *"Do not infer event origin from LLM role… rely on `Event.source`"* **[V]** |
| **Devin** | names speakers on export; labels Slack origin (`@Devin` instead of the bot user id); separates voice handling from internal notes | **[R]** |

### (iv) A **system / system-reminder channel that renders as inert context**
Named exemplars: Claude Code `<system-reminder>` with `isMeta: true` ("doesn't appear as a chat message in the interface"); OpenHands `ConversationErrorEvent` ("Not sent to the model"); Slack ephemeral messages (`chat.postEphemeral`); Zendesk internal note; Intercom `note` part type; Freshdesk private note; Aider's `>` tool channel. **[R/V]**

### 5.1 Cross-cutting rules the evidence supports

1. **Separate attribution from formatting.** OpenHands states it as a rule ("intentionally independent"; "Do not infer event origin from LLM role"). Zendesk does the same with author type vs per-message `source` vs `via`; OpenTelemetry does it with `gen_ai.input.messages` vs `gen_ai.system_instructions`. **[V/R]**
2. **Implement the two verbs as one field or a type split — the cheapest mappings are:** Zendesk comment **`public: true|false`** ("true if a public comment; false if an internal note" — *verified verbatim by me* **[V]**); Freshdesk reply-vs-note (`_private`, `incoming`); Intercom `part_type` comment-vs-note; Slack posted-vs-ephemeral. **Claude's SDK uses `shouldQuery: false` for the silent verb and `origin` for the visible verb — two independent fields, which is the more expressive design.**
3. **Turn-starting is a property of the state machine, not of message authorship.** Cline keeps a separate `TurnState` ("the single authoritative UI mode for the current turn… the webview renders … NOT from the tail of clineMessages"); OpenHands' send-message has an explicit `run: false`; Slack ephemeral messages are structurally non-turn-starting. **[R/V]**
4. **Badges layer on top of authorship** (Teams `addAiGenerated()`; Zendesk "AI agent" badge): authorship answers *who*, the badge answers *of what kind*.
5. **Publish machine-detectable discriminators so downstream code can branch** (Zendesk flags 2/4; GitHub `__typename: Bot` — because REST appends `[bot]` to the login but GraphQL returns the bare name and the reliable signal is `__typename`; Discord `webhook_id`; Slack `is_bot`). **[R]**
6. **Inert-context channels are a hazard surface, and the failures are documented:**
   - **Misattribution of automation as a human.** Zendesk trigger internal notes "are attributed to the system user" but trigger **public comments are attributed to the ticket's current assignee** — customers reported notes that "appeared to come from me. I hadn't touched the ticket, but to anyone reviewing it, it looked like I had." Zendesk's reply: *"if it's coming from the system via a trigger, we want to make this clear in the reply itself and in the audit and event log."* **[R]**
   - **Devin's changelog shows the same failure being fixed**: rows that read "User answered: (no answer)" now render as "the question as skipped, with what was asked, instead of 'User answered: (no answer)'". **[R]**
   - **Claude Code**, the reference (iv) implementation, documents the harm case: a background notification "delivered as a user turn" was read as approval and the model fabricated the user's consent; the user caught it only because "the text rendering was visually different from actual user input" while the JSONL showed the message as `type: assistant`, not `type: user`. Separately, fabricated `<system-reminder>` blocks "formatted identically to genuine harness reminders" were injected via a tool result to instruct the model to conceal information from the user — **meaning any channel that renders as trusted system context becomes an injection target if it is not structurally authenticated.** **[R]** https://github.com/anthropics/claude-code/issues/62056 , https://github.com/anthropics/claude-code/issues/75758
7. **A replay/monitoring transcript is kept separate from the LLM-facing message list** (OpenHands log events that never reach the model; Zendesk read-only AI tickets; Devin's worklog timeline). **[R]**
8. **The emerging telemetry standard is role-tagged and part-typed, with system instructions recorded *separately* from messages** (OpenTelemetry GenAI semconv: `{role, parts[]}`, plus `gen_ai.system_instructions`). The **Vercel AI SDK** shows the pragmatic alternative: `UIMessage.role` stays `system|user|assistant` and provenance rides in the `parts` array — **a voice producer identity can be expressed either as a new role or as a discriminator layered on the existing role.** **[R]**

---

## 6. Comparison: integration architecture and UI surface

| Product | How the voice layer attaches | Storage / thread model | Voice author identity? | UI surface |
|---|---|---|---|---|
| **Codex (desktop)** | voice as a **mode of an existing Codex task**; task's conversation + model reused | voice items excluded from thread history | ❌ plain `userMessage` | "Start voice chat" control strip on the task; spoken replies alongside streamed text |
| **Codex (CLI/TUI)** | client of app-server `thread/realtime/*`, keyed by `thread_id`; client owns WebRTC media | `RealtimeItem` in rollout, ignored by thread-history builder | ❌ plain `userMessage`; only a **red chevron** in the TUI and in-band XML | **bottom-pane VoiceStrip** + **inline history cells** in the existing TUI transcript |
| **Codex (app-server clients)** | `thread/realtime/*` API | ephemeral notifications only | ❌; turn-level `turn_trigger` ignored on steer and not returned on read | no retrieval surface |
| **Claude Code** | dictation writes into the human's prompt buffer; external writes via MCP channels / cross-session socket / hooks / SDK | normal user-role messages | ❌ in the CLI; ✅ **`origin` + `shouldQuery` in the Agent SDK** | inline `/voice` in the composer; channels appear as `← source · …` lines; peer messages as dim `› Message from @x:` lines; hooks invisible |
| **VS Code / Copilot** | voice is a front-end to the chat session ("routes a request to an existing session or starts a new one") | `ChatRequestTurn`/`ChatResponseTurn` (request-vs-response axis) | ❌; only proposed `isSystemInitiated` | **inline mic + Voice Mode button in the chat input** |
| **Cursor / Windsurf / Replit / JetBrains Air** | transcription inserted into the composer | normal user prompt | ❌ | **inline mic in the agent chat box** |
| **ElevenLabs / Vapi / Retell** | agent owns the conversation; harness would be a *backend LLM* | history owned **server-side** by the platform | partial: `transfer_to_agent` call is the boundary marker; **no per-message agent id** | n/a (platform-hosted voice) |
| **LiveKit** | agent = room participant; model change via `update_agent` or returning an Agent from a tool | session state machine + room identity | ✅ **transcript sender identity = the transcribed participant** | n/a |
| **Pipecat** | `OpenAILiveLLMService` on `gpt-live-1`; delegation to a `BackendLLMWorker`; `prefers_spoken` separates spoken vs **silent context** | `LLMContext` per worker | ✅ **each LLM agent is its own worker with its own context**; handoff = `activate_worker` | n/a (RTVI events for any client) |
| **Zendesk / Intercom / Freshdesk** | a distinct actor writes into a human's queue | append-only log + public/private axis | ✅ distinct author type + `source`/`via` | **badge + icon + read-only affordances on the ticket** |
| **Slack / Teams / Discord / Google Chat** | app/bot via its own token | channel history | ✅ bot identity; folding into a human is a scope-gated opt-in | **left/right alignment, APP badge, AI-generated badge** |
| **OpenHands** | SDK/API ingestion of events | append-only event log | ✅ `Event.source` independent of LLM `role` | event-kind-specific rows |

---

## 7. Ships / documented-but-not-shipped / inferred

**Ships this:**
- **Codex**: voice inside Codex tasks (desktop, rolling out); experimental CLI `/voice`; `thread/realtime/*` (experimental, undocumented); turn-level `turn_trigger`/`client_user_message_id`/`parent_turn_id`/`root_turn_id`.
- **Claude Code**: `/voice` dictation (CLI + VS Code); MCP channels (preview); cross-session messaging + inbox socket; hook `additionalContext`; **Agent SDK `origin` / `shouldQuery` / `isSynthetic`**.
- **Editors**: VS Code dictation + Voice Mode (in **and** out); Cursor voice input; Windsurf/Cascade voice input; Replit Agent Voice Mode; JetBrains Air voice input.
- **Provenance in non-coding products**: Zendesk `public`/author type/`via`/flags; Intercom `author.type` + `part_type`; Freshdesk note-vs-reply; GitHub bot accounts + `[bot]` + `__typename: Bot`; Slack `bot_message`; Discord `webhook_id`; Teams left/right + AI badge; Google Chat `User.type`; Cline row kinds; Aider channels; **OpenHands `Event.source` vs `role`**.
- **Pipecat `OpenAILiveLLMService`** on `gpt-live-1` with delegation and `prefers_spoken` silent/commentary split.

**Documented but not shipped:**
- Zed "Hands-Free Coding" (roadmap, *Currently Working On*); Zed dictation/voice-input requests still in Triage (#16410 since Aug 2024).
- Codex "voice in an existing text task" is described as rolling out; issue openai/codex#35500 documents the older dictation-only behaviour. **[U which cohort]**
- Vapi "on-premise deployments for large Enterprises" (FAQ claim, no technical docs). **[U]**
- Zendesk per-*message* visual differentiation between AI-agent and human-agent inside one thread — the documented differentiation is at **ticket** level. **[U]**

**Inferred / not documented:**
- That the closed ChatGPT desktop app is implemented on Codex's `thread/realtime/*` API (shape matches; source is closed). **[U]**
- Whether any editor lets an extension persist a message in the built-in transcript attributed to a non-user, non-participant author — **absence inferred from the API surfaces reviewed**, not stated. **[U]**
- Exact injection semantics for Windsurf voice and Cursor submit-keywords. **[U]**
- Whether Codex TUI voice is enabled by default in any channel, and the flag key behind `/experimental`. **[U]**
- The Codex README wording that realtime notifications are "ephemeral transport events, not ThreadItems" — cited from commit 94709228; at HEAD the README mentions realtime only in a routing note. **[U at HEAD]**
- Claude Code `<system-reminder>` persistence to the session JSONL (contradictory user reports; no official documentation of the channel exists at all). **[U]**
- No standardised `provenance` field name exists across products; no canonical "signed message" field in any chat/transcript API (the signing analogues found are git-level `Signed-off-by` / commit signature verification). **[U]**

---

## 8. What this means for dsh-openai-live (short)

1. **DSH's `SessionController.prompt()` hard-coding USER provenance is not a regression against the market — it is the market.** No leading tool authorises a voice message in its session model today.
2. **The differentiator is safe to build, and the precedent to copy is Anthropic's SDK, not any CLI**: a **user-role message carrying an independent provenance tag**, plus a **non-turn-starting injection flag**. That pair maps 1:1 onto the two verbs.
3. **Codex's turn-level `turn_trigger` is the better model for the *visible say*** (it survives compaction and reaches the model as metadata), **but note its documented blind spot: it is ignored when the input steers an active turn** — which is exactly the live-voice case. DSH should handle the steer case explicitly rather than inherit that gap.
4. **Do not imitate the `<system-reminder>` channel** without authenticating it; two separate incident classes (fabricated reminders; automation read as user approval) are documented in Claude Code.
5. **UI: the market is unanimous.** Voice lives *inside* the session's own panel/composer as an inline control, and its output is an inline transcript row with a provenance affordance. The current `position:fixed` bottom-right overlay is the outlier; the corrective is to move the control and its transcript rows into the docking sidebar's session panel.
6. **On the voice plumbing, reuse from Pipecat** (`gpt-live-1` service, delegation, `prefers_spoken`, interruption contract, transcript event shape) and **own the loop, session log and identity**. Do not put Vapi/ElevenLabs/Retell orchestration between the harness and the model.

---

## Evidence trail

**PERSONALLY RE-VERIFIED (read by me, primary source)**
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs — `TurnStartParams.turn_trigger` + "Ignored when this request steers an already-active turn"; `client_user_message_id`
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/turn_input.rs — `TurnStartOptions.turn_trigger` / `parent_turn_id` / `root_turn_id`, each "if this request starts a new turn"
- https://github.com/openai/codex/blob/main/codex-rs/core/src/context/realtime_delegation.rs — `<realtime_delegation>` markers, `RealtimeDelegationSource{Handoff, TranscriptTailFlush}`, `role() -> "user"`, 4 KiB truncation
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs — `ThreadItem::UserMessage{id, client_id, content}` (no provenance field); `CommandExecutionSource` on the command item
- https://github.com/openai/codex/blob/main/codex-rs/tui/src/history_cell/messages.rs — `UserHistoryCell{… spoken: bool}`; `if self.spoken { "› ".red().bold() } else { "› ".bold().dim() }`
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md — realtime mentioned only in a routing note at HEAD
- https://platform.claude.com/docs/en/agent-sdk/typescript — `SDKUserMessage{isSynthetic?, shouldQuery?, origin?: SDKMessageOrigin}`; "Set `shouldQuery` to `false` to append the message … without triggering an assistant turn"; `origin: { kind: "human" }`
- **Absence verified:** https://code.claude.com/docs/en/agent-sdk/typescript contains no `SDKMessageOrigin`/`shouldQuery`/`isSynthetic`
- https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md — v0.2.110 `shouldQuery`; v0.2.126 `origin` forwarded to results; `task-notification` subkinds `scheduled-trigger` / `peer-send-message`; `isSynthetic` → `isMeta` mapping fix
- https://docs.openhands.dev/sdk/arch/events — `Event.source ∈ {user, agent, environment}`; "These fields are intentionally independent"; "Do not infer event origin from LLM role"
- https://docs.pipecat.ai/api-reference/server/services/s2s/openai-live.md — `gpt-live-1`, "No local VAD", `prefers_spoken` commentary-vs-silent-context, `ResponsesDelegation`/`ClientDelegation`
- https://code.visualstudio.com/docs/configure/accessibility/voice — "Dictation inserts text in the input but does not submit the request"; Voice Mode
- https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/ — `public` boolean "true if a public comment; false if an internal note"
- https://developers.intercom.com/docs/references/2.1/rest-api/conversations/conversation-model — `author` object with `type`
- https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/agent-transfer.md — "The full transcript is preserved…"; `transfer_to_agent` tool calls "stripped from the history visible to the child agent's LLM"

**REPORTED FROM PRIMARY SOURCES (URLs as cited by the research tracks; not re-read by me)**
- Codex: learn.chatgpt.com/docs/features/voice · learn.chatgpt.com/docs/dots · openai.com/index/introducing-dots/ · help.openai.com/en/articles/6825453-chatgpt-release-notes · developers.openai.com/codex/app-server.md · codex-rs/app-server-protocol/src/protocol/v2/realtime.rs · …/thread.rs · …/thread_data.rs · …/thread_history.rs · …/common.rs · codex-rs/app-server/src/request_processors/turn_processor.rs · …/bespoke_event_handling.rs · codex-rs/core/src/realtime_conversation.rs · …/realtime_conversation/transcript_tail.rs · …/session/turn_input.rs · …/turn_metadata.rs · …/responses_metadata.rs · codex-rs/protocol/src/realtime.rs · codex-rs/tui/src/chatwidget/realtime.rs · …/bottom_pane/voice_strip.rs · …/slash_command.rs · …/tooltips.rs · codex-rs/app-server/tests/suite/v2/{realtime_conversation,turn_start}.rs · commits 94709228, 1d8ff89a, 97dbd01a · github.com/openai/codex/issues/35500
- Claude Code: code.claude.com/docs/en/{voice-dictation, channels, channels-reference, cross-session-messaging, hooks, mcp, headless, ide-integrations, remote-control, interactive-mode} · code.claude.com/docs/en/agent-sdk{,/python,/sessions,/streaming-vs-single-mode,/overview} · support.claude.com/en/articles/11101966-use-voice-mode · raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/CHANGELOG.md · raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md · github.com/anthropics/claude-code/issues/{24947,27441,27545,27873,6686,79542,90576,62056,43410,11251,75758} · techcrunch.com/2026/03/03/claude-code-rolls-out-a-voice-mode-capability/
- ACP: agentclientprotocol.com{,/llms.txt,/get-started/agents.md,/protocol/v1/prompt-turn.md} · github.com/agentclientprotocol · zed.dev/blog/claude-code-via-acp · zed.dev/acp
- Editors: code.visualstudio.com/docs/configure/accessibility/voice · code.visualstudio.com/docs/chat/chat-overview · code.visualstudio.com/docs/copilot/chat/chat-sessions · code.visualstudio.com/docs/agents/reference/copilot-vscode-features · code.visualstudio.com/api/extension-guides/{chat,ai/chat,language-model} · code.visualstudio.com/api/references/{contribution-points,vscode-api} · marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-speech · github.com/microsoft/vscode/wiki/VS-Code-Speech · docs.github.com/en/copilot/how-tos/chat-with-copilot/chat-in-ide · github.com/microsoft/vscode-discussions/discussions/2480 · github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/vscode.proposed.chatSessionsProvider.d.ts · github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/{browser/chatSessions/chatSessions.contribution.ts, common/languageModels.ts} · raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts · cursor.com/{changelog/2-0, changelog/3-1, docs/agent/prompting, docs/reference/keyboard-shortcuts, docs/release-notes/ide, help/grok-bot/voice-chat} · forum.cursor.com/t/{cursor-voice-input/152878, cursor-3-1-tiled-layout-and-upgraded-voice-input/157293} · docs.windsurf.com/windsurf/cascade/cascade · docs.devin.ai/{desktop/cascade/cascade, windsurf/plugins/cascade/cascade-overview} · zed.dev/{roadmap, docs/collaboration/channels} · github.com/zed-industries/zed/issues/16410 · jetbrains.com/help/{ai-assistant/ai-chat.html, air/define-tasks.html} · docs.replit.com/features/agent/voice-mode
- Voice platforms: elevenlabs.io/docs/{eleven-agents/overview, quickstart, customization/conversation-flow, customization/tools, customization/tools/webhook-tools.md, customization/events/client-events.md, customization/events/client-to-server-events.md, customization/llm/custom-llm.md, libraries/web-sockets, llms.txt} · elevenlabs.io/{pricing/agents, blog/practical-guide-open-source-agent-frameworks-and-elevenagents} · github.com/elevenlabs/elevenlabs-python · docs.vapi.ai/{quickstart/introduction, llms.txt, calls/websocket-transport.mdx, advanced/sip/sip-trunk.mdx, customization/speech-configuration.md, customization/voice-pipeline-configuration.md, server-url/events.md, squads/handoff.md, quickstart/web.md, security-and-privacy/data-flow.md, faq.md, enterprise/plans.md, tools/client-side-websdk.md} · vapi.ai/pricing · github.com/VapiAI/server-sdk-python · docs.retellai.com/{llms.txt, general/introduction.md, api-references/{audio-websocket, monitor-call-websocket.md}, integrate-llm/overview.md, build/single-multi-prompt/transfer-agent.md, build/{handle-background-noise.md, transcription-mode.md}, features/webhook-overview.md, deploy/{web-call.md, custom-telephony}} · retellai.com/pricing · github.com/RetellAI/retell-client-js-sdk · docs.livekit.io/{llms.txt, agents.md, agents/llms.txt, agents/logic/{turns.md, agents-handoffs.md, sessions.md, tools.md, workflows.md, patterns/supervisor.md}, agents/multimodality/text.md, transport.md, transport/self-hosting/, telephony.md} · livekit.io/pricing · github.com/livekit/agents · docs.pipecat.ai/{llms.txt, overview/pipecat.md, pipecat/learn/{transports.md, speech-input.md, agent-handoff.md, context-management.md}, pipecat/fundamentals/interruptions.md, api-reference/server/rtvi/rtvi-processor.md, api-reference/server/utilities/turn-management/transcriptions.md, api-reference/server/services/agents/openclaw.md, client/concepts/events-and-callbacks.md} · daily.co/pricing/pipecat-cloud/ · github.com/pipecat-ai/pipecat
- Provenance: docs.slack.dev/reference/events/message/bot_message/ · docs.slack.dev/reference/methods/chat.postMessage · docs.slack.dev/messaging/sending-and-scheduling-messages/ · slack.dev/two-keys-to-one-platform-understanding-bot-and-user-tokens/ · developer.zendesk.com/documentation/conversations/getting-started/key-concepts/ · developer.zendesk.com/documentation/ticketing/reference-guides/via-types/ · support.zendesk.com/hc/en-us/articles/{6191477770906, 9204149016346} · community.zendesk.com/ideas/select-comment-author-for-trigger-actions-internal-note-autoreply-5628 · developers.freshdesk.com/api/ · partnerimplementationsupport.freshdesk.com/support/solutions/articles/50000000488- · docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps · github.com/changesets/action/pull/448 · learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/{conversation-messages, bot-messages-ai-generated-content, teams-conversational-ai/agents-best-practices-features-checklist} · developers.google.com/workspace/chat/identify-reference-users · docs.discord.com/developers/resources/{message,webhook} · aider.chat/examples/README.html · github.com/cline/cline (ExtensionMessage.ts, webview-ui/.../UserMessage.tsx) · deepwiki.com/cline/cline/6.2-chat-interface · github.com/continuedev/continue (messageConversion.ts, openaiTypeConverters.ts) · docs.openhands.dev/sdk/guides/agent-server/api-reference/events/send-message · github.com/All-Hands-AI/OpenHands/pull/4584 · docs.devin.ai/release-notes/overview · developers.openai.com/api/reference/resources/chat · platform.claude.com/docs/en/api/messages · github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md · ai-sdk.dev/docs/reference/ai-sdk-core/ui-message

**Raw research artifacts** (full JSON responses from the five research tracks): `research/raw/task0.json` … `research/raw/task4.json`, and long-form subagent summaries under `~/.hermes/cache/delegation/subagent-summary-{0,1,3,4}-20261015_092410_*.txt`.
