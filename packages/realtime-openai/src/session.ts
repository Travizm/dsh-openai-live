/**
 * One live GPT-Live-1 session, expressed in the seam's vocabulary.
 *
 * This is where the provider's delegation model is honoured exactly as measured:
 *
 * - the result of delegated work returns through `session.commentary.append` (**spoken**) or
 *   `session.thinking.append` (**silent**) — never the `response.*` family, which requires a
 *   different delegation mode than the one this adapter opens;
 * - an append resolves on the provider's acknowledgement, not on the send, because the seams's
 *   promise must mean "the provider has it", not "we wrote bytes";
 * - a delegation carries no task text, so nothing here infers one.
 *
 * @module dsh-realtime-openai/session
 */

import { MAX_APPEND_CHARS, RealtimeError, RealtimeRuntime } from 'dsh-realtime'
import type { RealtimeSession, RealtimeSessionHandlers, RealtimeSessionStarted } from 'dsh-realtime'
import { contextAppend, inputAudioAppend, inputAudioMute, inputAudioUnmute, isKnownServerEvent, parseServerEvent, sessionClose } from './wire.ts'
import type { AppendKind } from './wire.ts'
import { toDelegation, toProviderError, toTranscript, toUsage } from './translate.ts'
import type { RealtimeTransport } from './types.ts'

/** Everything the session needs to run. */
export interface OpenAiLiveSessionOptions {
  /** The open transport. The session owns closing it. */
  transport: RealtimeTransport
  /** Provider-accepted session facts. */
  started: RealtimeSessionStarted
  /** Correlation id used in diagnostics. */
  id: string
  /** Consumer callbacks. */
  handlers: RealtimeSessionHandlers
  /** Bound on waiting for one append acknowledgement. */
  appendAckTimeoutMs: number
}

/** One context append awaiting its acknowledgement. */
interface PendingAppend {
  readonly kind: AppendKind
  settle(error?: Error): void
}

/** A non-empty string from a loosely-typed frame, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The GPT-Live-1 session. */
export class OpenAiLiveSession implements RealtimeSession {
  /** Correlation id for diagnostics. */
  readonly id: string

  /** Facts the provider accepted at startup. */
  readonly started: RealtimeSessionStarted

  private readonly transport: RealtimeTransport
  private readonly handlers: RealtimeSessionHandlers
  private readonly appendAckTimeoutMs: number
  private readonly pending = new Map<string, PendingAppend>()
  private sequence = 0
  private closed = false

  /**
   * @param options - the open transport, accepted facts, and consumer callbacks.
   */
  constructor(options: OpenAiLiveSessionOptions) {
    this.transport = options.transport
    this.started = options.started
    this.id = options.id
    this.handlers = options.handlers
    this.appendAckTimeoutMs = options.appendAckTimeoutMs
  }

  /** Reject any use of a session that has ended, naming the operation's own failure. */
  private assertOpen(operation: string): void {
    if (this.closed) {
      throw new RealtimeError(`cannot ${operation}: the session has already closed`, 'SESSION_CLOSED')
    }
  }

  /**
   * Append one frame of microphone audio.
   *
   * No end-of-utterance call exists, by design: endpointing belongs to the provider. Frames are the
   * only input, and the provider decides when a turn ends.
   * @param pcm16 - raw samples in the session's declared input format.
   */
  sendAudio(pcm16: Uint8Array): void {
    this.assertOpen('send audio')
    this.transport.send(inputAudioAppend(Buffer.from(pcm16).toString('base64')))
  }

  /** Stop the provider consuming microphone audio, without ending the session. */
  muteInput(): void {
    this.assertOpen('mute input')
    this.transport.send(inputAudioMute())
  }

  /** Resume microphone consumption after {@link muteInput}. */
  unmuteInput(): void {
    this.assertOpen('unmute input')
    this.transport.send(inputAudioUnmute())
  }

  /**
   * Return a delegated result for the model to speak aloud.
   * @param content - plain text, non-empty and within the seam's character bound.
   * @param delegationId - the delegation this answers; omit for session-wide context.
   */
  async appendCommentary(content: string, delegationId?: string): Promise<void> {
    await this.append('commentary', content, delegationId)
  }

  /**
   * Add context the model may use without speaking it — progress, facts, intermediate state.
   * @param content - plain text, non-empty and within the seam's character bound.
   * @param delegationId - the delegation this relates to; omit for session-wide context.
   */
  async appendThinking(content: string, delegationId?: string): Promise<void> {
    await this.append('thinking', content, delegationId)
  }

  /**
   * Steer the live conversation's behaviour without speaking anything.
   * @param content - plain text, non-empty and within the seam's character bound.
   * @param delegationId - omit for session-wide steering.
   */
  async appendInstructions(content: string, delegationId?: string): Promise<void> {
    await this.append('instructions', content, delegationId)
  }

  /**
   * Send one context append and resolve on the provider's acknowledgement.
   *
   * The bound is enforced here, at the operation that emits the whole value, rather than in a
   * wrapper a direct caller could bypass.
   */
  private async append(kind: AppendKind, content: string, delegationId?: string): Promise<void> {
    RealtimeRuntime.assertAppendable(content, MAX_APPEND_CHARS)
    this.assertOpen(`append ${kind}`)

    const eventId = `evt_${++this.sequence}`
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(eventId)
        reject(new RealtimeError(
          `the provider did not acknowledge a ${kind} append within ${this.appendAckTimeoutMs}ms`,
          'PROVIDER_ERROR',
        ))
      }, this.appendAckTimeoutMs)
      this.pending.set(eventId, {
        kind,
        settle: (error?: Error) => {
          clearTimeout(timer)
          this.pending.delete(eventId)
          if (error === undefined) resolve()
          else reject(error)
        },
      })
    })

    this.transport.send(contextAppend(kind, content, delegationId ?? null, eventId))
    await acknowledged
  }

  /**
   * Resolve the append an acknowledgement refers to.
   *
   * Correlation prefers the client id the provider echoes back. It falls back to the oldest
   * outstanding append of the same kind, because the echo is **not documented** for the appended
   * events and a missing correlation must degrade to FIFO rather than to a hung promise. Out-of-order
   * acknowledgements would need the echo; if the provider never supplies it, that is a drift the
   * canary should catch rather than something this adapter can detect on its own.
   * @param kind - which append was acknowledged.
   * @param clientEventId - the echoed client id, when supplied.
   */
  private settleAck(kind: AppendKind, clientEventId?: string): void {
    if (clientEventId !== undefined) {
      const exact = this.pending.get(clientEventId)
      if (exact !== undefined && exact.kind === kind) {
        exact.settle()
        return
      }
    }
    for (const entry of this.pending.values()) {
      if (entry.kind === kind) {
        entry.settle()
        return
      }
    }
  }

  /** Fail every outstanding append, so nothing awaits an acknowledgement that cannot arrive. */
  private failPending(error: Error): void {
    for (const entry of [...this.pending.values()]) entry.settle(error)
  }

  /**
   * Apply one server frame. Wired to the transport by the adapter; public so a recorded session can
   * be replayed through a real session object with no network.
   * @param frame - one complete text frame.
   */
  handleFrame(frame: string): void {
    const event = parseServerEvent(frame)
    if (event === null || !isKnownServerEvent(event)) return

    switch (event.type) {
      case 'session.output_audio.delta': {
        const encoded = (event as { delta?: unknown }).delta
        if (typeof encoded !== 'string' || encoded.length === 0) return
        // Decode to bytes here so consumers never see a transport encoding.
        this.handlers.onAudio?.(Uint8Array.from(Buffer.from(encoded, 'base64')))
        return
      }
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        const transcript = toTranscript(event)
        if (transcript !== undefined) this.handlers.onTranscript?.(transcript)
        return
      }
      case 'session.delegation.created': {
        const delegation = toDelegation(event)
        if (delegation !== undefined) this.handlers.onDelegation?.(delegation)
        return
      }
      case 'session.instructions.appended':
        this.settleAck('instructions', text((event as { client_event_id?: unknown }).client_event_id))
        return
      case 'session.thinking.appended':
        this.settleAck('thinking', text((event as { client_event_id?: unknown }).client_event_id))
        return
      case 'session.commentary.appended':
        this.settleAck('commentary', text((event as { client_event_id?: unknown }).client_event_id))
        return
      case 'session.usage.updated': {
        const usage = toUsage(event)
        if (usage !== undefined) this.handlers.onUsage?.(usage)
        return
      }
      case 'session.closed': {
        const usage = toUsage(event)
        if (usage !== undefined) this.handlers.onUsage?.(usage)
        this.finalise(text((event as { reason?: unknown }).reason))
        return
      }
      case 'error': {
        const failure = toProviderError(event)
        if (failure !== undefined) {
          this.failPending(failure)
          this.handlers.onError?.(failure)
        }
        return
      }
      case 'session.started':
        // Consumed at establishment; a repeat carries nothing new for an open session.
        return
    }
  }

  /**
   * Note that the transport closed. Idempotent, and safe to call after {@link close}.
   * @param reason - transport- or provider-supplied reason, when available.
   */
  handleTransportClose(reason?: string): void {
    this.finalise(reason)
  }

  /**
   * Note a post-establishment transport failure.
   * @param error - the transport error.
   */
  handleTransportError(error: Error): void {
    this.failPending(error)
    this.handlers.onError?.(error)
  }

  /** Mark the session ended exactly once, release resources, and notify the consumer. */
  private finalise(reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.failPending(new RealtimeError('the session closed before this append was acknowledged', 'SESSION_CLOSED'))
    this.transport.close()
    this.handlers.onClosed?.(reason)
  }

  /**
   * End the session and release the transport. Idempotent.
   *
   * The graceful close frame is sent best-effort and the transport is released immediately
   * afterwards: waiting for the provider's `session.closed` would make this promise hostage to a
   * provider that has already stopped answering, and the transport is local state either way.
   * @returns a promise settling once the transport is released.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.transport.send(sessionClose())
    this.finalise()
  }
}
