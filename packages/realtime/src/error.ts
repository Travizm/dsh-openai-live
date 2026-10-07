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
})

/** One of {@link REALTIME_ERROR_CODES}. */
export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[keyof typeof REALTIME_ERROR_CODES]

/**
 * A typed seam failure.
 *
 * The constructor validates its own arguments rather than trusting callers: a failure raised while
 * reporting a failure is the worst place to discover a malformed argument.
 */
export class RealtimeError extends Error {
  /** Stable machine code. Branch on this, never on `message`. */
  readonly code: RealtimeErrorCode

  /**
   * @param message - non-empty human-readable summary. Must not contain secret material.
   * @param code - one of {@link REALTIME_ERROR_CODES}.
   * @param options - optional `cause`.
   */
  constructor(message: string, code: RealtimeErrorCode, options?: ErrorOptions) {
    if (typeof message !== 'string' || message.length === 0) {
      throw new TypeError('RealtimeError message must be a non-empty string')
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new TypeError('RealtimeError code must be a non-empty string')
    }
    super(message, options)
    this.name = 'RealtimeError'
    this.code = code
  }
}
