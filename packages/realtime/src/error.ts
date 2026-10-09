/**
 * Typed failures for the realtime seam, carrying stable machine codes.
 *
 * Codes are the seam's API: a consumer branches on `code`, never on message text. Adding a code is a
 * minor release; changing what an existing code means is a breaking one.
 *
 * @module dsh-realtime/error
 */

/** Stable machine codes raised by this seam. */
export const REALTIME_ERROR_CODES = Object.freeze({
  /** A registration named an empty or malformed provider route. */
  INVALID_PROVIDER: 'INVALID_PROVIDER',
  /** A route already has an adapter registered by another registration. */
  DUPLICATE_PROVIDER: 'DUPLICATE_PROVIDER',
  /** Registration was released, so it can no longer replace its routes. */
  REGISTRATION_DISPOSED: 'REGISTRATION_DISPOSED',
  /** No adapter is registered for the requested route. */
  NO_ADAPTER: 'NO_ADAPTER',
  /** An append was empty, not a string, or over the seam's bound. */
  INVALID_APPEND: 'INVALID_APPEND',
  /** The session has already been closed. */
  SESSION_CLOSED: 'SESSION_CLOSED',
  /** The credential an adapter needs is absent or unusable. Names the setting, never the value. */
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  /** The provider reported a failure, or an operation it was expected to acknowledge never was. */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  /** A recorded session could not be read as a recording. */
  INVALID_RECORDING: 'INVALID_RECORDING',
  /** A setting's declaration is malformed: a bad field name, kind, scope, or a kind that does not match what it returns. */
  INVALID_SETTING: 'INVALID_SETTING',
  /** A setting is already registered under that key by another registration. */
  DUPLICATE_SETTING: 'DUPLICATE_SETTING',

  // ---------------------------------------------------------------------------------------------
  // Failure taxonomy. These exist so a consumer can branch on the *class* of a failure rather than
  // parse prose: a setup state, a rejected credential, an account that cannot pay, and a throttle
  // need four different responses, and collapsing them is what makes onboarding feel unfinished.
  // ---------------------------------------------------------------------------------------------

  /**
   * The capability is not configured yet — an expected state on a fresh install, not a fault.
   *
   * Distinct from {@link REALTIME_ERROR_CODES.CREDENTIAL_REJECTED}: absent is fixed by supplying a
   * value, unusable by replacing one.
   */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** A credential is present and the provider refused it. Replace it; retrying cannot help. */
  CREDENTIAL_REJECTED: 'CREDENTIAL_REJECTED',
  /** The credential is valid but the account cannot use what was requested (model, region, scope). */
  NOT_ENTITLED: 'NOT_ENTITLED',
  /** The account cannot pay for the request — an exhausted balance or a hard billing limit. */
  INSUFFICIENT_CREDIT: 'INSUFFICIENT_CREDIT',
  /** The provider throttled the request. Repeating later may succeed. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** The provider was asked something and did not answer within the bound. */
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  /** The transport failed — a socket error, not a decision the provider made. */
  NETWORK: 'NETWORK',
})

/** One of {@link REALTIME_ERROR_CODES}. */
export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[keyof typeof REALTIME_ERROR_CODES]

/**
 * What a caller can act on, carried as structure rather than prose.
 *
 * A failure a user cannot act on is a failure report that wasted their time. Every field here exists
 * so the *class* of a failure survives translation: an agent can relay `remedy` verbatim, a settings
 * surface can highlight `setting`, a retry loop can consult `retryable`, and a human reading a log
 * can see the provider's own `providerCode` instead of a paraphrase of it.
 *
 * Never carries secret material. `providerCode` is the provider's own error code, never a credential.
 */
export interface RealtimeFailureDetail {
  /**
   * What to do about it, written to be relayed **verbatim** to whoever is trying to use the feature.
   * One sentence, imperative, no jargon.
   */
  remedy?: string
  /** The configuration key that must be supplied, when the failure is a configuration state. */
  setting?: string
  /** Whether repeating the identical call could succeed without any change. */
  retryable?: boolean
  /** The provider's own error code, verbatim. Never a translated or inferred value. */
  providerCode?: string
  /**
   * Where the remedy is carried out, when there is a page for it.
   *
   * An absolute `https` URL, and the only detail field a user is invited to *visit* — so it names a page the
   * provider publishes rather than one composed here. A remedy that says "add credit" without saying where is
   * half an instruction, and the half nobody can guess: the URL is in the provider's own message, and the
   * message is the thing this design refuses to carry.
   */
  link?: string
}

/** Expected `typeof` for each optional detail field. Data, so the check costs one loop and not a branch each. */
const DETAIL_FIELD_TYPES = Object.freeze({
  remedy: 'string',
  setting: 'string',
  providerCode: 'string',
  retryable: 'boolean',
  link: 'string',
})

/**
 * Reject a malformed detail before it is attached to a failure.
 * @param detail - candidate detail.
 * @throws TypeError naming the offending field.
 */
function assertDetail(detail: RealtimeFailureDetail): void {
  for (const [field, expected] of Object.entries(DETAIL_FIELD_TYPES)) {
    const value = (detail as Record<string, unknown>)[field]
    if (value === undefined) continue
    if (typeof value !== expected) {
      throw new TypeError(`RealtimeError detail.${field} must be a ${expected}`)
    }
    if (expected === 'string' && value === '') {
      throw new TypeError(`RealtimeError detail.${field} must be non-empty when supplied`)
    }
  }
}

/**
 * A typed seam failure.
 *
 * The constructor validates its own arguments rather than trusting callers: a failure raised while
 * reporting a failure is the worst place to discover a malformed argument.
 */
export class RealtimeError extends Error {
  /** Stable machine code. Branch on this, never on `message`. */
  readonly code: RealtimeErrorCode

  /** What a caller can act on, when the failure is one they can act on. */
  readonly detail: RealtimeFailureDetail | undefined

  /**
   * @param message - non-empty human-readable summary. Must not contain secret material.
   * @param code - one of {@link REALTIME_ERROR_CODES}.
   * @param options - optional `cause`, and an optional structured `detail`.
   */
  constructor(message: string, code: RealtimeErrorCode, options?: ErrorOptions & { detail?: RealtimeFailureDetail }) {
    if (typeof message !== 'string' || message.length === 0) {
      throw new TypeError('RealtimeError message must be a non-empty string')
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new TypeError('RealtimeError code must be a non-empty string')
    }
    if (options?.detail !== undefined) {
      assertDetail(options.detail)
    }
    super(message, options)
    this.name = 'RealtimeError'
    this.code = code
    this.detail = options?.detail
  }
}
