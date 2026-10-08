import { MAX_APPEND_CHARS, type RealtimeDelegation, type RealtimeSession } from 'dsh-realtime'
import type { AgentTranscriptLine, DelegationAnswer, DelegationRequest } from './types.ts'

/**
 * Spoken when a delegation could not be answered.
 *
 * Never silent, and never a fabricated answer. The seam's first invariant is that an unresolvable or
 * erroring delegation never auto-approves; the honest complement is that the model is told so out
 * loud, because the person in the conversation is the one waiting.
 */
export const UNANSWERED_NOTICE = "Sorry — I can't take care of that right now."

/** Appended to an answer cut to fit the seam's append bound, so a reader knows it is partial. */
const TRUNCATION_MARKER = ' [truncated]'

/**
 * Ask the application for an answer.
 *
 * Synchronous and asynchronous responders are both acceptable, and a decline is `undefined`.
 */
export interface DelegationAsker {
  (request: DelegationRequest): DelegationAnswer | undefined | Promise<DelegationAnswer | undefined>
}

/**
 * Cut an answer to the seam's append bound.
 *
 * A bound applied here rather than at the append is deliberate: the append would *throw*, and losing a
 * long answer entirely is worse than delivering a marked prefix of it.
 * @param text - the answer.
 * @param maxChars - ceiling, defaulting to the seam's own bound.
 * @returns the text, or a marked prefix of it no longer than `maxChars`.
 */
export function boundAppend(text: string, maxChars: number = MAX_APPEND_CHARS): string {
  if (text.length <= maxChars) return text
  // A ceiling shorter than the marker itself can only carry the marker's own prefix.
  if (maxChars <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxChars)
  return text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
}

/**
 * Run the asker, turning any failure into a decline.
 *
 * A responder that throws must not become an exception the adapter's handler sees, and must not be
 * mistaken for an answer: failing to answer and choosing not to answer lead to the same honest notice.
 * @param ask - the asker.
 * @param request - what to ask.
 * @returns the answer, or `undefined` when the asker failed.
 */
function settled(ask: DelegationAsker, request: DelegationRequest): Promise<DelegationAnswer | undefined> {
  try {
    return Promise.resolve(ask(request)).catch(() => undefined)
  } catch {
    return Promise.resolve(undefined)
  }
}

/**
 * Answer one delegation, or tell the model plainly that it could not be answered.
 *
 * Dispatched rather than returned: the caller is a session handler, which cannot await.
 * @param session - the live session the delegation arrived on.
 * @param delegation - the delegation, whose `id` is carried back on the answer.
 * @param transcript - the conversation so far, as the responder will see it.
 * @param ask - how to reach a responder.
 * @param timeoutMs - bound on waiting for one.
 * @returns a promise settling once the session has been answered.
 */
export async function answerDelegation(
  session: Pick<RealtimeSession, 'id' | 'appendCommentary' | 'appendThinking'>,
  delegation: RealtimeDelegation,
  transcript: readonly AgentTranscriptLine[],
  ask: DelegationAsker,
  timeoutMs: number,
): Promise<void> {
  const request: DelegationRequest = {
    id: delegation.id,
    offsetMs: delegation.offsetMs,
    transcript,
    sessionId: session.id,
  }

  // An unref'd bound, so a timer that loses the race cannot hold the process open — and so there is
  // no id to clear, which means no failure path can leak one.
  const expired = new Promise<undefined>((resolve) => {
    setTimeout(() => { resolve(undefined) }, timeoutMs).unref()
  })

  const answer = await Promise.race([settled(ask, request), expired])
  const text = typeof answer?.text === 'string' ? answer.text.trim() : ''

  if (text.length === 0) {
    await session.appendCommentary(UNANSWERED_NOTICE, delegation.id)
    return
  }
  if (answer?.mode === 'spoken') {
    await session.appendCommentary(boundAppend(text), delegation.id)
    return
  }
  await session.appendThinking(boundAppend(text), delegation.id)
}
