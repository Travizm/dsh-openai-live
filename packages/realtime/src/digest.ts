/**
 * Fingerprints: a stable name for text a record deliberately does not hold.
 *
 * The journal exists to be read without the profile beside it, and two of the questions that cost a
 * session of archaeology were *what was asked* and *what was answered* — neither of which the journal
 * may retain, because it is the one artefact built to be read, quoted and pasted. A digest resolves
 * that squarely: it is comparable across two records that were written by different code at different
 * times, and it is not the text.
 *
 * **It is taken after redaction, never before.** A fingerprint of a secret is a leak in its own right —
 * stable, identifiable, and permanent — which is the same reasoning the leak scan in this repo applies
 * to a recorded key fingerprint. So the digest of a value is the digest of the form a journal would
 * retain, and a correlator reproduces it with two public calls: `digestOf(redact(text, secrets))`.
 * One path for both, so the two cannot drift.
 *
 * Not a cryptographic commitment and not claimed to be one: truncation to {@link DIGEST_CHARS} is
 * chosen so an entry stays a predictable size. It identifies text, it does not authenticate it.
 *
 * @module dsh-realtime/digest
 */

import { createHash } from 'node:crypto'

/**
 * Hexadecimal characters kept from the digest.
 *
 * 64 bits — enough that two different questions, two different answers, and two different boots do not
 * collide in any number of runs anybody will produce, and short enough that a fingerprint costs an
 * entry about twenty bytes rather than ninety.
 */
export const DIGEST_CHARS = 16

/**
 * The fingerprint of one text.
 *
 * Total by construction: there is no input it cannot represent and no branch to leave uncovered, and
 * the empty string is a fingerprint like any other rather than a marker. A sentinel for "nothing was
 * said" would collapse two different facts — an empty text and an uncomputed digest — into one value,
 * which is exactly the ambiguity this layer exists to remove.
 * @param text - the text to name.
 * @returns {@link DIGEST_CHARS} lowercase hexadecimal characters.
 */
export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, DIGEST_CHARS)
}
