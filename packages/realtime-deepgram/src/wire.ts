/**
 * The Deepgram Voice Agent wire vocabulary — **as observed**, not as documented.
 *
 * Every type here was written from the frames a live session actually produced (`docs/p1-wire-probe-results.md`,
 * 2026-10-17) rather than from the API reference, because on the one question that mattered most the reference
 * contradicts itself and the wire did not. The observed server vocabulary was:
 *
 *   Welcome, SettingsApplied, UserStartedSpeaking, ConversationText, History, EndOfTurn, LatencyReport,
 *   AgentAudioDone, PromptUpdated, ThinkUpdated, InjectionRefused, Error — plus binary audio frames.
 *
 * Frames are typed loosely on purpose: `Record<string, unknown>` with the fields the translation reads declared
 * where they are known. A provider that adds a field is not a breaking change; a provider that *drops* one is
 * caught by the translating function, which returns `undefined` rather than a half-built value.
 *
 * @module dsh-realtime-deepgram/wire
 */

/** A parsed server frame. `type` is the only field every frame carries. */
export interface ServerFrame {
  readonly type: string
  readonly [field: string]: unknown
}

/** `Settings` — the client's opening configuration. Declared as the shape this package emits. */
export interface SettingsMessage {
  readonly type: 'Settings'
  readonly audio: {
    readonly input: { readonly encoding: 'linear16'; readonly sample_rate: number }
    readonly output: { readonly encoding: 'linear16'; readonly sample_rate: number }
  }
  readonly agent: {
    readonly listen: {
      readonly provider: {
        /** Always `deepgram`: the *vendor*, not the model. Sending `flux` here is rejected (proven). */
        readonly type: 'deepgram'
        readonly model: string
        /** `v2` for Flux models, `v1` for everything else. */
        readonly version: 'v1' | 'v2'
        readonly keyterms?: readonly string[]
        readonly eot_threshold?: number
        readonly eot_timeout_ms?: number
      }
    }
    readonly think: {
      readonly provider: {
        readonly type: 'open_ai'
        readonly model: string
        /** Present only when the caller brings its own endpoint — absent means Deepgram's managed proxy. */
        readonly endpoint?: { readonly url: string }
      }
      readonly prompt: string
    }
    readonly speak: {
      readonly provider: { readonly type: 'deepgram'; readonly model: string }
    }
  }
}

/** The client frames this package can send. */
export type ClientFrame =
  | SettingsMessage
  | { readonly type: 'UpdatePrompt'; readonly prompt: string }
  | {
    readonly type: 'UpdateThink'
    readonly think: { readonly provider: { readonly type: 'open_ai'; readonly model: string }; readonly prompt: string }
  }
  | { readonly type: 'InjectUserMessage'; readonly content: string }
  | { readonly type: 'InjectAgentMessage'; readonly message: string }
  | { readonly type: 'KeepAlive' }

/** The acknowledgement that a prompt update is **in force** — the boundary a turn must wait for. */
export const PROMPT_ACK = 'PromptUpdated'

/** The acknowledgement that a think-config replacement is in force. */
export const THINK_ACK = 'ThinkUpdated'

/** `ConversationText` — one whole utterance. `role` says whose. */
export interface ConversationTextFrame extends ServerFrame {
  readonly type: 'ConversationText'
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** `LatencyReport` — provider-reported stage timings. Any subset may be present. */
export interface LatencyReportFrame extends ServerFrame {
  readonly type: 'LatencyReport'
  readonly total_latency?: number
  readonly ttt_token_latency?: number
  readonly ttt_text_latency?: number
  readonly tts_latency?: number
}

/** `InjectionRefused` — the provider declined an `InjectAgentMessage`. */
export interface InjectionRefusedFrame extends ServerFrame {
  readonly type: 'InjectionRefused'
  readonly message?: string
}

/** `Error` — the provider rejected a client frame. */
export interface ErrorFrame extends ServerFrame {
  readonly type: 'Error'
  readonly description?: string
}
