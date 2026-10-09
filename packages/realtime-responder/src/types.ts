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
  /**
   * Preamble put in front of a relayed request, so the session knows what it is answering.
   *
   * Configuration rather than a constant for the same reason the milestone phrases are: it is this
   * plugin's own prose, and prose a user may want to change is prose a user can edit in `cordis.yml`
   * beside `instructions`. Deliberately **not** registered as a live setting — a paragraph of framing is
   * not a value to poke at during a call, which is the same judgement that keeps the phrase table out of
   * the panel.
   */
  readonly promptFrame: string
  /**
   * Spoken phrase for each tool, keyed by the tool name the session reports.
   *
   * The only source of a spoken step. A tool's `arguments` are the model's own text and are never read
   * here, however tempting the detail in them: the one path this bundle lets model-authored words take to
   * a user's ear is the answer, and that is redacted on the way out.
   */
  readonly milestonePhrases: readonly string[]
  /** Spoken phrase for a tool the phrase table does not name. */
  readonly milestoneFallback: string
  /** Shortest gap between two spoken milestones, in milliseconds. */
  readonly milestoneIntervalMs: number
  /** Most milestones spoken aloud in one turn. */
  readonly maxSpokenMilestones: number
  /** When false every step is silent — an off switch, which is not the same as a cap of zero. */
  readonly speakMilestones: boolean
}

/**
 * One committed session event, narrowed to what this plugin reads.
 *
 * **There is deliberately no `sessionId` here.** The harness delivers a session event to a
 * `session/event` listener as `(session, event)`, and the event object itself carries only
 * `{ type, seq, time, data }` — so a reader that looked for the owning session *on the event* would match
 * nothing, silently, for ever, and every delegated turn would end in `timeout`. The session arrives as the
 * listener's first argument; `TurnDeps.subscribe` forwards its id beside the event for exactly that reason.
 *
 * `surfaceOp: 'append'` matters for a *message*: a session log can replay the same message on a surface
 * operation other than an append, and answering a delegation with a replayed message would speak history as
 * news. It is deliberately **not** required for `tool/call`, which is not a surface event at all and
 * therefore carries no `surfaceOp` — requiring one there would drop every step, silently.
 */
export interface SessionEventLike {
  readonly type?: unknown
  readonly surfaceOp?: unknown
  readonly data?: {
    readonly message?: { readonly content?: unknown }
    /** `tool/call` carries the tool's own name and its raw, unparsed arguments. */
    readonly name?: unknown
  }
}
