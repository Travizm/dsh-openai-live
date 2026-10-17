/**
 * P4b, first half — reading an answer out of the harness's follow stream.
 *
 * The frame shapes here are **mirrors** of `@deepseek-ai/dsh-api-session-controller` (v0.1.5-rc.2), declared
 * structurally so the interpretation can be tested without a running DSH or a build dependency on the harness.
 * The parts that matter, and why:
 *
 * - `frame.chunk` on an assistant-stream frame is an opaque `JsonValue` — the *provider's* delta shape. Any
 *   concatenation of chunks is provider-specific and drifts the first time a provider changes its encoding.
 * - The authoritative text is the **durable record** the terminal frame points at:
 *   `{ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq } }`
 * - That record is an event with `type: 'assistant/message'` whose `data.message.content` holds parts, and only
 *   the parts of `type: 'text'` are speech. `reasoning` parts are the model's private thinking: joining them
 *   into a completion would leak a chain of thought into whatever consumes the answer.
 *
 * @module dsh-delegate/frames
 */

/** One durable event, as `follow` delivers it. `data` is opaque JSON on the wire. */
export interface WireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** One durable history record — structurally `SessionEventEntry`. */
export interface HistoryRecord {
  readonly type: 'event'
  readonly event: WireEvent
}

/** The address a follow request needs. Subagent addresses exist; a completion addresses a session. */
export interface SessionAddressMirror {
  readonly kind: 'session'
  readonly sessionId: string
}

/**
 * One follow frame. Only `end` is interpreted: `snapshot`, `event` and `assistant-stream/chunk` are carried so
 * the committed record can be found among them, and so a future caller can log what actually arrived.
 */
export type FollowFrame =
  | { readonly type: 'snapshot'; readonly cursor: number; readonly records: readonly HistoryRecord[] }
  | { readonly type: 'event'; readonly event: WireEvent }
  | { readonly type: 'assistant-stream'; readonly frame: AssistantStreamFrame }

/** The assistant-stream frames. `chunk` is opaque; `end` is the verdict on the attempt. */
export type AssistantStreamFrame =
  | { readonly type: 'end'; readonly outcome: AttemptOutcome }
  | { readonly type: 'start' | 'chunk'; readonly [key: string]: unknown }

/** How an assistant attempt ended. */
export type AttemptOutcome =
  | { readonly kind: 'committed'; readonly eventType: string; readonly seq: number }
  | { readonly kind: 'abandoned' }

/** What the stream says about the answer so far. */
export type Answer =
  /** No terminal frame yet — keep reading. */
  | { readonly kind: 'pending' }
  /** The text a caller should return. */
  | { readonly kind: 'answer'; readonly text: string }
  /** The attempt was abandoned: there is no message, and pretending otherwise would answer with silence. */
  | { readonly kind: 'abandoned' }
  /** Committed, but the record is not among the frames seen, or carries no speech. */
  | { readonly kind: 'unresolved' }

/** Read the spoken text out of an `assistant/message` event's `data`, or `undefined` if it is not one. */
export function assistantText(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = (data as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const { role, content } = message as { role?: unknown; content?: unknown }
  if (role !== 'assistant' || !Array.isArray(content)) return undefined
  const parts = content
    .filter((part): part is { type: string; text: string } =>
      typeof part === 'object' && part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string')
    .map(part => part.text)
  // `reasoning` parts are deliberately excluded above: they are the model's private thinking, and a completion
  // is a public surface.
  return parts.length === 0 ? undefined : parts.join('')
}

/** Find the terminal frame, if the stream has produced one. */
function terminal(frames: readonly FollowFrame[]): AttemptOutcome | undefined {
  for (const frame of frames) {
    if (frame.type === 'assistant-stream' && frame.frame.type === 'end') return frame.frame.outcome
  }
  return undefined
}

/** Find the durable event with a given sequence number, across snapshots and live frames. */
function eventAt(frames: readonly FollowFrame[], seq: number): WireEvent | undefined {
  for (const frame of frames) {
    if (frame.type === 'event' && frame.event.seq === seq) return frame.event
    if (frame.type === 'snapshot') {
      const found = frame.records.find(record => record.event.seq === seq)
      if (found !== undefined) return found.event
    }
  }
  return undefined
}

/**
 * What the frames say about the answer.
 *
 * `pending` is distinct from `unresolved` on purpose: one means "keep reading", the other means "the stream is
 * finished and the answer is not here". Collapsing them turns a slow turn into a failed one, or a failed one
 * into an empty answer.
 */
export function answerFrom(frames: readonly FollowFrame[]): Answer {
  const outcome = terminal(frames)
  if (outcome === undefined) return { kind: 'pending' }
  if (outcome.kind === 'abandoned') return { kind: 'abandoned' }
  if (outcome.eventType !== 'assistant/message') return { kind: 'unresolved' }
  const event = eventAt(frames, outcome.seq)
  if (event === undefined) return { kind: 'unresolved' }
  const text = assistantText(event.data)
  // An assistant message with only reasoning parts is a real outcome, and it must not become an empty
  // completion: a caller reading `content: ""` concludes the model said nothing, which is a different claim.
  if (text === undefined || text.trim().length === 0) return { kind: 'unresolved' }
  return { kind: 'answer', text }
}
