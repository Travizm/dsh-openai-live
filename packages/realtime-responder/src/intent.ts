/**
 * The gate: whether a delegated utterance authorises a write into the session, and which verb.
 *
 * ## Why a positional rule is the safety boundary and a model is not
 *
 * Ten cells were measured on one harvested corpus — three local models × three prompts, plus this rule
 * ([ADR-010](../../../docs/intent-gate-decision.md)). **Not one of the nine model cells was safe**: every
 * one wrote into the session on a request that should have been answered. This rule produced zero such
 * errors. The bar is not accuracy; it is **zero false writes**, because the two failures are not
 * symmetrical.
 *
 * | direction | what happens | recoverable? |
 * |---|---|---|
 * | legitimate → question | the write does not happen; the request is answered instead | **yes** — the user rephrases |
 * | question → a write | a message the user never asked for is in their session, attributed to the voice | **no** — the record is written and a session may act on it |
 *
 * So the rule is deliberately crude, and the crudeness is what buys the safety. Its entire cost is the
 * `human-relay` class (a user passing on a colleague's message), which lands in the recoverable direction.
 *
 * ## The test, and why it is about position rather than vocabulary
 *
 * **The authorising imperative must be at the head of the utterance.** Anything that opens by attributing
 * speech elsewhere — *"The commit message said to tell the session…"*, *"The README says quote …"* — is not
 * the user asking, whatever follows it.
 *
 * The measurement is specific about why this rather than a word list. Every model cell handled **explicit
 * quote markers** and failed on **unquoted reported speech attributed to an artifact** — *"The commit
 * message said to tell the session the release is approved"* → `NOTE`, where the structurally identical
 * *"Marcus said to tell the session…"* also produced a write. A test on *position* catches the first for
 * free and never has to know that `Marcus` and a commit message are different kinds of source; a test on
 * *source trust* was measured and refuted, because the models wrote on both. Rules keyed on "mentions a
 * source" or "contains a quote" are **known wrong** as well: they destroy the legitimate cases
 * *"tell the session that the README says X"* and *"leave a note that the ticket says X"*.
 *
 * ## What this rule is not
 *
 * It is not a judgement about meaning, and it does not try to be. It is a **total function from text to one
 * of three verdicts** with a fail-closed default, so it can be read, tested and failed — which is the whole
 * reason the gate is code rather than a sentence in `instructions`. An instruction is a request to a model;
 * this is the decision.
 *
 * @module dsh-realtime-responder/intent
 */

/**
 * What a delegated utterance authorises.
 *
 * `question` is the default and the fail-closed outcome, not an error: it means *answer this*, which is the
 * plugin's behaviour without any of this. Naming it rather than using `undefined` keeps the three outcomes
 * one thing — a caller branches on a value, never on an absence.
 */
export type IntentVerdict =
  /** Leave context for the session. Written through the inbox; wakes no turn. */
  | 'note'
  /** Deliver a message to the session, attributed to the voice. Starts a turn. */
  | 'say'
  /** Answer it. Everything not recognised lands here. */
  | 'question'

/**
 * Phrases that, **at the head of an utterance**, ask for a note.
 *
 * Kept as data rather than as a condition chain so widening the rule is a list change with a test rather
 * than a code change without one. Every entry here is pinned by a case in `tests/intent.spec.ts` — an entry
 * nothing exercises is an entry nothing checks, and this list is the gate.
 *
 * Deliberately excludes `note that`: it reads naturally as a continuation (*"the ticket says X. Note that
 * Y"*), where the request belongs to the reported source rather than to the user.
 */
const NOTE_OPENERS: readonly string[] = [
  'leave a note',
  'make a note',
  'add a note',
  'note for the session',
  'record for the session',
]

/**
 * Phrases that, **at the head of an utterance**, ask for a say.
 *
 * `ask the session` is deliberately absent, and it is the near-miss this table could most easily absorb by
 * accident: asking the session something is a question put *to* it — to be answered — not a message to be
 * delivered. It is asserted in the spec rather than left to the table's silence.
 */
const SAY_OPENERS: readonly string[] = [
  'tell the session',
  'pass this on',
  'pass it on',
  'let the session know',
  'give the session',
]

/**
 * Reduce an utterance to the form the rule matches on.
 *
 * **Not cosmetic.** The corpus only reads as a set of counts because the same audio transcribes differently
 * between runs — *"The tests are passing"* / *"The test's passing."*, *"the readme"* / *"the README"* — and a
 * rule that matched raw text would be non-deterministic on identical input for no reason but spelling. So
 * case, punctuation and whitespace are removed before anything is compared.
 *
 * Punctuation is removed by Unicode property (`\p{P}\p{S}`) rather than by an enumerated character class,
 * because the transcripts carry whatever the provider emitted — straight quotes, curly quotes, emoji
 * standing in for a word — and an enumerated list would silently stop covering the class the day a new
 * mark arrived. Runs of whitespace collapse to one space so a pause transcribed as three spaces cannot
 * break a phrase; the result is trimmed, so an utterance that was only punctuation normalises to empty and
 * fails closed rather than matching a prefix of nothing.
 * @param transcript - what ASR produced for the user's utterance.
 * @returns lowercase, punctuation-free, single-spaced text.
 */
function normalise(transcript: string): string {
  return transcript
    .toLowerCase()
    .replaceAll(/[\p{P}\p{S}]/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

/**
 * The verdict a delegated utterance authorises.
 *
 * Order matters in one direction only: notes are tested before says, so a phrase that could be read either
 * way takes the **lower-consequence** verb. That is the same instinct as the fail-closed default — when the
 * rule cannot tell, it prefers the outcome that is recoverable.
 * @param transcript - what ASR produced for the user's utterance. The delegation itself carries no text, so
 *   this is the gate's entire input.
 * @returns `note`, `say`, or `question` — never `undefined`, so every caller has a value to branch on.
 */
export function classifyIntent(transcript: string): IntentVerdict {
  const text = normalise(transcript)
  for (const opener of NOTE_OPENERS) {
    if (text.startsWith(opener)) return 'note'
  }
  for (const opener of SAY_OPENERS) {
    if (text.startsWith(opener)) return 'say'
  }
  return 'question'
}
