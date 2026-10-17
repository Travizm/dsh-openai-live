/**
 * Capability declaration — what a provider can do, stated once, so a call into what it cannot do is a **coded
 * refusal** rather than a hang, a silent no-op, or prose discovered in production.
 *
 * This is the chamber's §6.2 shape (D-PS-003): one seam, honest about its edges. The alternative — splitting the
 * seam into duplex and cascade interfaces so that each provider only sees methods it supports — was rejected
 * because it pushes the same knowledge into the type system in a way that multiplies with every provider and
 * every shared caller, while a declared capability stays readable at a glance.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **A `false` must throw.** A capability declared unavailable and then called is the exact failure this
 *    declaration prevents, so the check runs at the call site, not in a test nobody runs.
 * 2. **An unknown must be sayable.** `promptUpdate` is tri-state because P1 left replace-vs-append genuinely
 *    unresolved after four confounded tests (`docs/p1-wire-probe-results.md`). Forcing it into a boolean would
 *    have required guessing, and a guess inside a capability declaration is worse than an admitted unknown —
 *    it is a guess that downstream code will trust.
 */
import { REALTIME_ERROR_CODES, RealtimeError } from './error.ts'
import type { RealtimeProviderInfo } from './types.ts'

/** What a provider can do about a mid-session system-prompt change. */
export type PromptUpdateMode = 'replace' | 'append' | 'unknown'

/** Every boolean capability. Named so an audit can enumerate them and a test can prove none is unchecked. */
export const BOOLEAN_CAPABILITIES = [
  'appendThinking',
  'appAuthoredSpeech',
  'functionCalls',
  'usageReporting',
  'transcriptDeltas',
  'inputMute',
] as const

/** One boolean capability name. */
export type BooleanCapability = (typeof BOOLEAN_CAPABILITIES)[number]

/** What a provider can and cannot do. Every field is required: a declaration is a statement, not a default. */
export interface RealtimeCapabilities {
  /** The provider acknowledges an append of thinking with a receipt. */
  readonly appendThinking: boolean
  /** The application can write the words the assistant speaks, rather than steering it. */
  readonly appAuthoredSpeech: boolean
  /** The provider executes function calls in-band, so a tool result can enter its own loop. */
  readonly functionCalls: boolean
  /** The provider reports token or second usage during the session. */
  readonly usageReporting: boolean
  /** Transcript text arrives as deltas. `false` means whole utterances. */
  readonly transcriptDeltas: boolean
  /** The adapter can stop consuming the microphone without closing the session. */
  readonly inputMute: boolean
  /** Whether a mid-session prompt change replaces the prompt, appends to it, or is not established. */
  readonly promptUpdate: PromptUpdateMode
}

/**
 * Deepgram Voice Agent, as declared from evidence rather than from documentation.
 *
 * Every value below is traceable: the P1 probe (`docs/p1-wire-probe-results.md`, run 2026-10-17) and the
 * `.claude.deepgram` configuration notes in `docs/voice-seam-chamber.md` §6.1–6.2.
 *
 * - `appendThinking: false` — the seam's append is file-context; Deepgram's mid-session lever is
 *   `InjectAgentMessage`, which speaks rather than thinks, and aborts the in-flight response when it does.
 * - `appAuthoredSpeech: false` — `InjectAgentMessage` makes the agent say a line, but the *agent* says it; the
 *   application does not author speech and cannot guarantee the wording survives the model.
 * - `functionCalls: false` — A′ by design (D-PS-001): DSH is the only brain, so there is no `functions` array
 *   for the provider to call into.
 * - `usageReporting: false` — **probed, not assumed**: no usage-like event in 160–181 frames across runs.
 *   This closes the ❓ that stood in the chamber's §6.2 table.
 * - `transcriptDeltas: false` — **probed**: `ConversationText` carries `role` and a complete utterance.
 * - `inputMute: true` — **corrected during P5b.** The provider has no mute frame, but the adapter implements one by
 *   stopping its own audio writes, so the seam's `muteInput()` does exactly what it says. It was declared `false`
 *   here first, which would have made `requireCapability(..., 'inputMute')` refuse a call that works — the
 *   capability matrix has to describe the seam's method, not the provider's vocabulary.
 * - `promptUpdate: 'append'` — **resolved by P1c.** Reading the provider's own outbound request to a BYO LLM shows
 *   a mid-session update leaves the original instruction in place: the prompt after an update carries both, joined
 *   by a newline. Budget as if appending, because it does.
 */
export const DEEPGRAM_CAPABILITIES: RealtimeCapabilities = Object.freeze({
  appendThinking: false,
  appAuthoredSpeech: false,
  functionCalls: false,
  usageReporting: false,
  transcriptDeltas: false,
  inputMute: true,
  promptUpdate: 'append',
})

/**
 * Throw `CAPABILITY_UNSUPPORTED` when a provider declares it cannot do this.
 *
 * `what` is the caller's own words for the operation ("append thinking", "mute the input"), because the message
 * is read by whoever is wiring a provider — and "cannot append thinking" is actionable where "capability check
 * failed" is not. A route that declares nothing is not refused: an undeclared provider has made no claim, and
 * inventing a refusal on its behalf would break every adapter that predates this declaration.
 */
export function requireCapability(info: RealtimeProviderInfo, capability: BooleanCapability, what: string): void {
  const declared = info.capabilities
  if (declared === undefined) return
  if (declared[capability]) return
  throw new RealtimeError(
    `${info.id} cannot ${what}: it declares ${capability} = false`,
    REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED,
  )
}

/**
 * Throw `CAPABILITY_UNSUPPORTED` unless the provider's prompt updates do what the caller needs.
 *
 * A caller that *needs replacement* must not proceed against `'append'` (the old rules survive and the prompt
 * grows) or `'unknown'` (nobody knows). A caller that needs appending is satisfied by either, because a replace
 * still installs the new rule — it merely also discards what came before.
 */
export function assertPromptUpdate(info: RealtimeProviderInfo, needed: Exclude<PromptUpdateMode, 'unknown'>): void {
  const declared = info.capabilities?.promptUpdate
  if (declared === undefined) return
  if (needed === 'append' && (declared === 'append' || declared === 'replace')) return
  if (needed === 'replace' && declared === 'replace') return
  throw new RealtimeError(
    `${info.id} cannot guarantee a ${needed} of the prompt: it declares promptUpdate = ${declared}`,
    REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED,
  )
}

/** One thing an adapter actually did, as observed by the conformance suite. */
export interface CapabilityExercise {
  readonly capability: BooleanCapability
  /** `used` = the adapter performed it; `refused` = it threw `CAPABILITY_UNSUPPORTED`. */
  readonly outcome: 'used' | 'refused'
}

/** The result of holding a declaration against what the adapter did. */
export interface CapabilityAudit {
  /** True when no declaration was contradicted. `unknown` prompt updates are not contradictions. */
  readonly honoured: boolean
  /** One line per contradiction, in the order exercised. */
  readonly divergences: readonly string[]
  /** Capabilities the provider declined to establish. Reported always, failed never. */
  readonly unknowns: readonly string[]
}

/**
 * Hold a declaration against what the adapter was observed to do.
 *
 * This is the chamber's "capability honesty: declared vs exercised, exact" check in skeleton form. Both
 * directions are divergences, and they fail differently: a capability declared `false` but exercised means the
 * declaration under-sold the provider and a caller may be relying on a refusal that never comes; declared
 * `true` but refused means the provider promised something it does not deliver, which is the failure a user
 * experiences as "it just doesn't work sometimes".
 */
export function auditCapabilities(
  declared: RealtimeCapabilities,
  exercises: readonly CapabilityExercise[],
): CapabilityAudit {
  const divergences: string[] = []
  for (const exercise of exercises) {
    const can = declared[exercise.capability]
    if (!can && exercise.outcome === 'used') {
      divergences.push(`${exercise.capability}: declared false, but the adapter used it`)
    }
    if (can && exercise.outcome === 'refused') {
      divergences.push(`${exercise.capability}: declared true, but the adapter refused it`)
    }
  }
  const unknowns: string[] = []
  if (declared.promptUpdate === 'unknown') unknowns.push('promptUpdate: not established (docs contradict; P1 unresolved)')
  return { honoured: divergences.length === 0, divergences, unknowns }
}
