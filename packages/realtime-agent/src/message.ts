/**
 * Minting the message a delivery writes into a session.
 *
 * Deliberately **here** and not in the responder, and that is a layout decision with a measured cause: the
 * published `dsh-llm` line does not carry the `plugin` source kind the runtime honours (see `./source.ts`),
 * so the construction has to sit somewhere that declares the shape it needs. Putting it in the package that
 * already speaks the agent protocol keeps the responder free of a `dsh-llm` **value** import entirely —
 * which is also what keeps its seam testable with plain fakes.
 *
 * The method is the harness's own `createUserMessage`, never a hand-built object: the measurement that made
 * the source-kind decision also established that `createMessage` mints and freezes **without validating**
 * `source.kind`, so a literal would be accepted here and be indistinguishable from a real message — right up
 * until something reads a field this function would have set.
 *
 * @module dsh-realtime-agent/message
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { VOICE_SOURCE } from './source.ts'

/**
 * Build the user message for one delivery.
 *
 * The text is expected to be **already framed** by the caller: the framing is the responder's own prose and
 * states what the message is and what it is not, so minting it here would put the words in one package and
 * the decision about them in another. This function does one thing — it stamps the producer's identity onto
 * the text it is given.
 * @param text - the framed text to deliver, as the caller authored it.
 * @returns a frozen user message carrying the voice's source.
 */
export function mintVoiceMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: VOICE_SOURCE,
  })
}
