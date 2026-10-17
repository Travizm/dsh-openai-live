/**
 * The session — the seam's `RealtimeSession` over a Deepgram Voice Agent socket.
 *
 * Three of the seam's methods do not map one-to-one onto this provider, and each is mapped deliberately rather
 * than approximated:
 *
 * - `appendThinking` **throws `CAPABILITY_UNSUPPORTED`**, because this provider declares `appendThinking: false`.
 *   The guard is not decoration: a method that silently did something else — speaking the text, say — would put
 *   the application's progress notes into the user's ear.
 * - `appendInstructions` sends `UpdatePrompt` and **resolves on `PromptUpdated`**, not on the write. P1 proved a
 *   turn started before the acknowledgement runs under the old prompt, so resolving on the write would let a
 *   caller believe a rule was in force while the next turn ignored it. Whether the update replaces or appends is
 *   still unresolved (`promptUpdate: 'unknown'`), so callers must budget as if it appends.
 * - `muteInput` is **adapter-local**: this provider has no mute frame, so the session stops sending audio. The
 *   capability declares `inputMute: true` because the seam's method does what it says — the alternative would be
 *   refusing a call that works.
 *
 * One limitation worth stating rather than hiding: Deepgram's `SettingsApplied` carries **no echo** of what it
 * accepted. `started` therefore reports what was *requested*. It is still worth having — the ack proves the
 * settings were parsed — but it is not the provider's own account of them, and nothing here pretends otherwise.
 *
 * @module dsh-realtime-deepgram/session
 */
import { REALTIME_ERROR_CODES, RealtimeError, MAX_APPEND_CHARS } from 'dsh-realtime'
import type { RealtimeSession, RealtimeSessionHandlers, RealtimeSessionStarted, RealtimeAudioFormat } from 'dsh-realtime'
import { toInjectionRefusal, toLatency, toProviderError, toTranscript, toUpdateAck } from './events.ts'
import type { StageLatency } from './events.ts'
import type { ClientFrame, ServerFrame, SettingsMessage } from './wire.ts'
import type { DeepgramTransport } from './transport.ts'

/** What a session is built from. */
export interface SessionOptions {
  /** The route this session was opened under, reported in `started.provider`. */
  readonly provider: string
  /** The settings frame, already validated by `buildSettings`. */
  readonly settings: SettingsMessage
  /** Transport bound to the socket. */
  readonly transport: DeepgramTransport
  /** Where transcripts, audio and errors go. */
  readonly handlers: RealtimeSessionHandlers
  /** Called for provider-reported stage timings, which the seam's handler surface does not carry. */
  readonly onLatency?: (latency: StageLatency) => void
  /** How long a `PromptUpdated` acknowledgement may take before the append fails. Defaults to 5 s. */
  readonly ackTimeoutMs?: number
  /** Injectable timers, so the acknowledgement bound is testable without sleeping. */
  readonly timers?: {
    readonly schedule: (fn: () => void, ms: number) => unknown
    readonly cancel: (handle: unknown) => void
  }
}

/** A live session, plus the two methods the seam keeps off its public surface. */
export interface DeepgramSession extends RealtimeSession {
  /** Feed one received frame. Exposed so a transport can route without the session owning the socket. */
  receive(frame: ServerFrame): void
}

function audioFormat(sampleRate: number): RealtimeAudioFormat {
  return { sampleRate, channels: 1, encoding: 'pcm16' }
}

/**
 * Open a session.
 *
 * Sends `Settings` immediately: on this provider nothing else is legal until the settings are applied, and a
 * session that waited for a caller to act would be one a caller forgets to start.
 */
export function openSession(options: SessionOptions): DeepgramSession {
  const { settings, transport, handlers } = options
  const ackTimeoutMs = options.ackTimeoutMs ?? 5_000
  const schedule = options.timers?.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = options.timers?.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let muted = false
  let closed = false
  let pendingAck: { resolve: () => void; reject: (error: Error) => void; handle: unknown } | undefined

  const started: RealtimeSessionStarted = {
    provider: options.provider,
    model: settings.agent.think.provider.model,
    voice: settings.agent.speak.provider.model,
    inputAudio: audioFormat(settings.audio.input.sample_rate),
    outputAudio: audioFormat(settings.audio.output.sample_rate),
  }

  const openAck = (): Promise<void> => new Promise<void>((resolve, reject) => {
    let settled = false
    const handle = schedule(() => {
      if (settled) return
      settled = true
      pendingAck = undefined
      // A prompt update with no acknowledgement is a rule that may or may not be in force. Failing loudly is the
      // only honest option: the caller can retry, and cannot silently proceed.
      reject(new RealtimeError(
        `no ${'PromptUpdated'} acknowledgement within ${ackTimeoutMs} ms`,
        REALTIME_ERROR_CODES.PROVIDER_TIMEOUT,
      ))
    }, ackTimeoutMs)
    pendingAck = {
      resolve: () => {
        settled = true
        cancel(handle)
        pendingAck = undefined
        resolve()
      },
      reject: (error) => {
        settled = true
        cancel(handle)
        pendingAck = undefined
        reject(error)
      },
      handle,
    }
  })

  const send = (frame: ClientFrame): void => transport.send(frame)

  transport.send(settings)

  return {
    id: `${options.provider}:${settings.agent.think.provider.model}`,
    started,
    receive(frame) {
      const transcript = toTranscript(frame)
      if (transcript !== undefined) { handlers.onTranscript?.(transcript); return }
      const latency = toLatency(frame)
      if (latency !== undefined) { options.onLatency?.(latency); return }
      const ack = toUpdateAck(frame)
      if (ack !== undefined) { pendingAck?.resolve(); return }
      if (frame.type === 'AgentAudioDone') { pendingAck?.resolve(); return }
      const refusal = toInjectionRefusal(frame)
      if (refusal !== undefined) {
        // Not fatal: the provider declined one line. Reported so the plugin can journal it, because a refused
        // narration is the difference between "the agent said nothing" and "the agent was told not to".
        handlers.onError?.(new RealtimeError(refusal, REALTIME_ERROR_CODES.PROVIDER_ERROR))
        return
      }
      const description = toProviderError(frame)
      if (description !== undefined) handlers.onError?.(new RealtimeError(description, REALTIME_ERROR_CODES.PROVIDER_ERROR))
      // Every other frame (Welcome, SettingsApplied, UserStartedSpeaking, History, EndOfTurn) is an observation
      // this session has no seam-level use for.
    },
    sendAudio(pcm16) {
      if (closed) throw new RealtimeError('the session is closed', REALTIME_ERROR_CODES.SESSION_CLOSED)
      if (muted) return
      transport.sendAudio(pcm16)
    },
    muteInput() { muted = true },
    unmuteInput() { muted = false },
    async appendCommentary(content, _delegationId) {
      const text = requireAppend(content)
      // `InjectAgentMessage` is how the application asks the agent to say something. It resolves on the write,
      // not on `AgentAudioDone`: the seam's contract ties acknowledgement to a delegation, and this provider's
      // audio completion is not tied to one.
      send({ type: 'InjectAgentMessage', message: text })
    },
    async appendThinking() {
      throw new RealtimeError(
        `${options.provider} cannot append thinking: it declares appendThinking = false`,
        REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED,
      )
    },
    async appendInstructions(content, _delegationId) {
      const text = requireAppend(content)
      const acknowledged = openAck()
      send({ type: 'UpdatePrompt', prompt: text })
      await acknowledged
    },
    async close() {
      if (closed) return
      closed = true
      pendingAck?.reject(new RealtimeError('the session closed while an update was pending', REALTIME_ERROR_CODES.SESSION_CLOSED))
      await transport.close()
    },
  }
}

/** Validate one append. Local refusal beats a provider rejection halfway through a conversation. */
function requireAppend(content: string): string {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new RealtimeError('an append must be a non-empty string', REALTIME_ERROR_CODES.INVALID_APPEND)
  }
  if (content.length > MAX_APPEND_CHARS) {
    throw new RealtimeError(`an append may not exceed ${MAX_APPEND_CHARS} characters`, REALTIME_ERROR_CODES.INVALID_APPEND)
  }
  return content
}
