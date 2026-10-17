/**
 * P4b, second half — admit a turn, follow it to its answer, one at a time per session.
 *
 * Two facts drive the design:
 *
 * 1. `prompt()` returns an acknowledgement, not an answer, so the answer is read from `follow()` (see
 *    `frames.ts` for why it comes from the committed record rather than the streamed chunks).
 * 2. **Two completions admitted to one session interleave.** The harness queues them into the same
 *    trajectory, so "the next assistant message" is not necessarily *this* request's, and a shim that assumed
 *    otherwise would hand one caller another caller's answer. So requests are serialised per session, and the
 *    queue is the price of a correct answer.
 *
 * @module dsh-delegate/settle
 */
import type { PromptRequestMirror } from './protocol.ts'
import { answerFrom } from './frames.ts'
import type { FollowFrame, SessionAddressMirror } from './frames.ts'

/**
 * The slice of `SessionController` this shim uses — structurally the harness service, so a test can supply a
 * generator and a plugin can pass the real one.
 */
export interface SessionControllerLike {
  /** Admit one prompt. Resolves when the harness accepted it, not when the agent answered it. */
  prompt(request: PromptRequestMirror, signal: AbortSignal): Promise<unknown>
  /** Follow a session's durable events, optionally including assistant-stream frames. */
  follow(
    request: { readonly address: SessionAddressMirror; readonly assistantStream?: true },
    signal: AbortSignal,
  ): AsyncIterable<FollowFrame>
}

/** Why a completion could not be produced. Coded, so a caller branches on the code and not on prose. */
export type SettleFailureCode =
  /** The attempt was abandoned: the provider or the harness gave up on it. */
  | 'ATTEMPT_ABANDONED'
  /** The stream ended without a committed assistant message this shim could read. */
  | 'ANSWER_UNRESOLVED'
  /** The turn did not finish inside the caller's budget. */
  | 'TURN_TIMEOUT'

/** What {@link ask} returns. */
export type SettleResult =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'failure'; readonly code: SettleFailureCode; readonly message: string }

/** Options for one {@link ask}. */
export interface AskOptions {
  /** How long one turn may take. Defaults to 120 s — a completion that never returns is worse than a failure. */
  readonly timeoutMs?: number
  /** Injected clock for the timeout, so a test does not sleep. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown
  readonly clearTimeoutFn?: (handle: unknown) => void
}

/** One in-flight turn per session. Keyed by session id; the value is the tail of that session's chain. */
const queues = new Map<string, Promise<unknown>>()

/**
 * Ask one question of one session and wait for its answer.
 *
 * Serialised per session, so a second caller waits rather than interleaving. The chain is replaced on every
 * call and never grows: a session with no work in flight holds one settled promise, not a history.
 */
export function ask(controller: SessionControllerLike, request: PromptRequestMirror, options: AskOptions = {}): Promise<SettleResult> {
  const previous = queues.get(request.sessionId) ?? Promise.resolve()
  // No rejection handler here, deliberately: what goes into the queue is already swallowed below, so `previous`
  // cannot reject. A second handler would be dead code that reads as defensive — and the real protection is the
  // `then(noop, noop)` on the stored tail, which keeps one failed turn from poisoning the next.
  const run = previous.then(() => runOne(controller, request, options))
  queues.set(request.sessionId, run.then(() => undefined, () => undefined))
  return run
}

/** Clear the per-session queue. Exported for tests and for a plugin that is being unloaded. */
export function resetQueues(): void {
  queues.clear()
}

async function runOne(
  controller: SessionControllerLike,
  request: PromptRequestMirror,
  options: AskOptions,
): Promise<SettleResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  // Wrapped rather than referenced: `clearTimeout` takes a narrower handle type than the injectable form, and
  // assigning it directly is a variance error rather than a working default.
  const schedule = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const abort = new AbortController()
  let timedOut = false
  const handle = schedule(() => { timedOut = true; abort.abort() }, timeoutMs)

  try {
    // Start the subscription FIRST, and let it run. An async generator does not execute until its first
    // `next()`, so merely calling `follow()` subscribes to nothing — a harness that emits between admission and
    // the first read would hand us a stream already past the record we need. The pump starts before the prompt.
    const frames: FollowFrame[] = []
    const pump = (async () => {
      for await (const frame of controller.follow({ address: { kind: 'session', sessionId: request.sessionId }, assistantStream: true }, abort.signal)) {
        frames.push(frame)
        // Stop reading as soon as the outcome is decided: the stream is long-lived, and a follower that reads
        // to the end would hold the turn open after the answer has arrived.
        if (answerFrom(frames).kind !== 'pending') return
      }
    })()
    await Promise.all([controller.prompt(request, abort.signal), pump])
    const answer = answerFrom(frames)
    if (answer.kind === 'answer') return { kind: 'answer', text: answer.text }
    if (answer.kind === 'abandoned') {
      return { kind: 'failure', code: 'ATTEMPT_ABANDONED', message: 'the attempt was abandoned before it committed a message' }
    }
    if (answer.kind === 'unresolved') {
      return { kind: 'failure', code: 'ANSWER_UNRESOLVED', message: 'the stream committed without an assistant message this shim can read' }
    }
    // Still pending after the stream ended: no terminal frame ever arrived.
    return { kind: 'failure', code: 'ANSWER_UNRESOLVED', message: 'the follow stream ended without a terminal frame' }
  } catch (error) {
    if (timedOut) {
      return { kind: 'failure', code: 'TURN_TIMEOUT', message: `the turn did not finish within ${timeoutMs} ms` }
    }
    throw error
  } finally {
    cancel(handle)
  }
}
