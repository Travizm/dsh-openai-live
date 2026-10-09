/**
 * Types for the responder.
 *
 * The session event is described **structurally** rather than imported from the harness package that
 * declares it. Two reasons, and both are about what breaks later: this plugin reads exactly five fields
 * and would otherwise take a compile-time dependency on a wide schema it does not use; and a narrowed
 * shape lets a test hand it a hand-written event without reconstructing a whole harness type.
 *
 * @module dsh-realtime-responder/types
 */

/** Validated configuration. */
export interface RealtimeResponderConfig {
  /** The DSH session the voice conversation is attached to. The agent's answer comes from here. */
  readonly sessionId: string
  /** Character budget for the prompt handed to the agent, so a long transcript cannot flood a turn. */
  readonly maxPromptChars: number
  /**
   * How long to wait for the agent before declining. A DSH turn can run for minutes; the delegation
   * asking for an answer is bounded too, and the smaller of the two governs what the voice model
   * actually hears.
   */
  readonly answerTimeoutMs: number
  /**
   * Values that must never be spoken, or carried onto the bus, however they are spelled.
   *
   * Shape redaction catches a key with a vendor prefix. It can *not* catch a value with no structure:
   * the audio route's capability token is 32 random bytes of base64url, which no pattern can find, so
   * a caller that holds such a secret has to name it here. Omitting it leaves the shape arm alone —
   * honest, but not sufficient, and this is the difference between those two words.
   */
  readonly redactSecrets: readonly string[]
}

/**
 * One committed session event, narrowed to what this plugin reads.
 *
 * `surfaceOp: 'append'` matters: a session log can replay the same message on a surface operation other
 * than an append, and answering a delegation with a replayed message would speak history as news.
 */
export interface SessionEventLike {
  readonly type?: unknown
  readonly sessionId?: unknown
  readonly surfaceOp?: unknown
  readonly data?: { readonly message?: { readonly content?: unknown } }
}
