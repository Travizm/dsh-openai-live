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
 * Reshape an agent's reply into words a speaker can say.
 *
 * The `commentary` channel is **spoken**: the provider reads what it is given out loud, character for
 * character. What an agent writes is prose for a screen — and measured on the live relay, that is
 * exactly what came back: `**0.6.6.**`, a link whose *target* is a file path, and a fenced json block,
 * all of it read out verbatim, URL and fence and all. The frame the responder puts on the relayed
 * request is what should stop that being written; this is the floor under it, because a shape the model
 * ignores must not become noise in somebody's ear.
 *
 * **It reshapes formatting; it never invents or deletes meaning.** Fence lines, heading and list
 * markers, thematic breaks and the markers of emphasis go; the words stay, including the contents of a
 * code block. Two deliberate omissions, both because guessing wrong is worse than leaving the character:
 * **underscore emphasis** is not unscrambled, because one underscore is far more often part of an
 * identifier (`dsh_openai_live`) than an emphasis marker, and **a bare URL** is left alone, because it is
 * the author's own text and the instruction is what should have kept it out.
 *
 * The **silent** channel is untouched on purpose: `thinking` is context for the model, not words for an
 * ear, and markdown is a perfectly good way to hand a model a snippet.
 * @param text - the agent's reply, as written.
 * @returns the same words, with the formatting a speaker would have read out removed.
 */
export function toSpeech(text: string): string {
  return text
    // A fence line is markup; what it encloses is content. The line goes with its own newline, so the
    // removal does not leave a blank line behind where the fence was.
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*\n?/gm, '')
    // Leading block markers: headings, block quotes, bullets, ordered items.
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    // Thematic breaks, which are three or more of one marker and nothing else.
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
    // A link or image becomes its text: the target is not sayable.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // The whitespace the removals leave behind, collapsed rather than left as a stutter.
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\s+$/g, '')
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

/** Which channel an append went out on. What an acknowledgement names, and what it does not. */
export type DelegationAppend = 'commentary' | 'thinking'

/**
 * Answer one delegation, or tell the model plainly that it could not be answered.
 *
 * Dispatched rather than returned: the caller is a session handler, which cannot await.
 * @param session - the live session the delegation arrived on.
 * @param delegation - the delegation, whose `id` is carried back on the answer.
 * @param transcript - the conversation so far, as the responder will see it.
 * @param ask - how to reach a responder.
 * @param timeoutMs - bound on waiting for one.
 * @param onAcknowledged - called once per accepted append, which is not once per thing heard.
 * @returns a promise settling once the session has been answered.
 */
export async function answerDelegation(
  session: Pick<RealtimeSession, 'id' | 'appendCommentary' | 'appendThinking'>,
  delegation: RealtimeDelegation,
  transcript: readonly AgentTranscriptLine[],
  ask: DelegationAsker,
  timeoutMs: number,
  onAcknowledged: (append: DelegationAppend, delegationId: string) => void,
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

  // Every append below awaits the provider's acknowledgement rather than the send — that is the seam's
  // session contract, written that way for a measured reason. So a resolved await **is** the
  // acknowledgement, and this is the only honest place to record one. What it is not is delivery:
  // nothing here says a speaker rendered anything, and keeping those two apart is the whole of
  // invariant 6 — and the reason the fault-injection matrix has a row for exactly this pair.
  if (text.length === 0) {
    await session.appendCommentary(boundAppend(toSpeech(UNANSWERED_NOTICE)), delegation.id)
    onAcknowledged('commentary', delegation.id)
    return
  }
  if (answer?.mode === 'spoken') {
    // Spoken, so it is shaped — see `toSpeech`. Applied before the bound so the bound is what the ear
    // finally gets, and so the truncation marker is never reshaped away.
    await session.appendCommentary(boundAppend(toSpeech(text)), delegation.id)
    onAcknowledged('commentary', delegation.id)
    return
  }
  await session.appendThinking(boundAppend(text), delegation.id)
  onAcknowledged('thinking', delegation.id)
}
