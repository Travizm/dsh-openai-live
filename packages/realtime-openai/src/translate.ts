/**
 * Translation from the provider wire vocabulary to the seam's vocabulary.
 *
 * Deliberately pure: every function takes one parsed frame and returns a seam value or `undefined`.
 * No I/O, no session state. That is what lets the whole translation layer be verified against a
 * **recorded** session with no key and no network — and what keeps provider-specific field names out
 * of the seam, which is the seam's whole point.
 *
 * Each function validates the fields it reads. A provider that omits or retypes a field yields
 * `undefined` (the frame is ignored) rather than propagating a half-built value into a consumer.
 *
 * @module dsh-realtime-openai/translate
 */

import { RealtimeError, type RealtimeDelegation, type RealtimeErrorCode, type RealtimeSessionStarted, type RealtimeTranscript, type RealtimeUsage, MAX_APPEND_CHARS } from 'dsh-realtime'
import type { ParsedServerEvent, WireUsage } from './wire.ts'

/** A finite, non-negative number, or `undefined`. */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A non-empty string, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Translate a transcript delta.
 * @param event - a parsed frame.
 * @returns the transcript fragment, or `undefined` when the frame is not a usable transcript.
 */
export function toTranscript(event: ParsedServerEvent): RealtimeTranscript | undefined {
  if (event.type !== 'session.input_transcript.delta' && event.type !== 'session.output_transcript.delta') {
    return undefined
  }
  const text = typeof event.delta === 'string' ? event.delta : undefined
  if (text === undefined) return undefined
  return {
    kind: event.type === 'session.input_transcript.delta' ? 'input' : 'output',
    text,
    // The wire carries no explicit final flag: a delta is a fragment, and the provider signals the
    // end of an utterance by simply stopping. Marking deltas non-final is the honest reading.
    final: false,
  }
}

/**
 * Translate a delegation notice.
 *
 * The notice carries metadata only — no task text — so this deliberately produces nothing the
 * consumer could mistake for intent.
 * @param event - a parsed frame.
 * @returns the delegation, or `undefined` when the frame is not a usable delegation.
 */
export function toDelegation(event: ParsedServerEvent): RealtimeDelegation | undefined {
  if (event.type !== 'session.delegation.created') return undefined
  const delegation = event.delegation
  if (typeof delegation !== 'object' || delegation === null) return undefined
  const { id, target } = delegation as { id?: unknown; target?: unknown }
  const delegationId = nonEmptyString(id)
  if (delegationId === undefined) return undefined
  if (target !== 'client' && target !== 'responses') return undefined
  return {
    id: delegationId,
    target,
    offsetMs: finiteNonNegative(event.offset_ms) ?? 0,
  }
}

/**
 * Translate a usage report.
 * @param event - a parsed frame carrying `usage`.
 * @returns cumulative audio-seconds, or `undefined` when the frame carries no usable figure.
 */
export function toUsage(event: ParsedServerEvent): RealtimeUsage | undefined {
  const usage = event.usage as WireUsage | undefined
  if (typeof usage !== 'object' || usage === null) return undefined
  const seconds = finiteNonNegative(usage.seconds)
  return seconds === undefined ? undefined : { seconds }
}

/** The audio contract both directions of a GPT-Live-1 session use. */
const LIVE_AUDIO = Object.freeze({ sampleRate: 24_000, channels: 1, encoding: 'pcm16' } as const)

/**
 * Build the seam's session facts from the provider's accepted configuration.
 *
 * The provider's reply is authoritative, not the request: a provider may alias a model or substitute
 * a voice, and reporting the *requested* value would make the log disagree with the wire.
 * @param event - the `session.started` frame.
 * @param requested - what the caller asked for, used only as the fallback when the provider is silent.
 * @returns the established-session facts.
 */
export function toStarted(
  event: ParsedServerEvent,
  requested: { provider: string; model: string; voice?: string },
): RealtimeSessionStarted {
  const session = event.session
  const accepted = typeof session === 'object' && session !== null
    ? session as { model?: unknown; audio?: { output?: { voice?: unknown } } }
    : undefined
  const voice = nonEmptyString(accepted?.audio?.output?.voice) ?? requested.voice
  return {
    provider: requested.provider,
    model: nonEmptyString(accepted?.model) ?? requested.model,
    ...voice === undefined ? {} : { voice },
    inputAudio: { ...LIVE_AUDIO },
    outputAudio: { ...LIVE_AUDIO },
  }
}

/** One provider failure, mapped to the seam's class and what a caller should do about it. */
interface ProviderFailure {
  readonly code: RealtimeErrorCode
  readonly retryable: boolean
  readonly remedy: string
}

/**
 * The provider's error codes, mapped to classes.
 *
 * A data table rather than a chain of conditionals: however many codes are added, this costs one
 * branch to consult. The remedies are written to be relayed verbatim, because the whole point of
 * classifying a failure is that whoever receives it can act without interpreting it.
 *
 * Only codes the provider documents are listed. An unrecognised code is **not** guessed into a class
 * — see the caller.
 */
const PROVIDER_FAILURES: ReadonlyMap<string, ProviderFailure> = new Map([
  ['invalid_api_key', { code: 'CREDENTIAL_REJECTED', retryable: false, remedy: 'replace the configured OpenAI credential — it was refused' }],
  ['authentication_error', { code: 'CREDENTIAL_REJECTED', retryable: false, remedy: 'replace the configured OpenAI credential — it was refused' }],
  ['insufficient_quota', { code: 'INSUFFICIENT_CREDIT', retryable: false, remedy: 'add credit to the OpenAI account — the quota is exhausted' }],
  ['credit_balance_exhausted', { code: 'INSUFFICIENT_CREDIT', retryable: false, remedy: 'add credit to the OpenAI account — the balance is exhausted' }],
  ['model_not_found', { code: 'NOT_ENTITLED', retryable: false, remedy: 'request a model this OpenAI account is entitled to use' }],
  ['permission_denied', { code: 'NOT_ENTITLED', retryable: false, remedy: 'request a model this OpenAI account is entitled to use' }],
  ['rate_limit_exceeded', { code: 'RATE_LIMITED', retryable: true, remedy: 'retry after a short pause — the provider is throttling' }],
  ['too_many_requests', { code: 'RATE_LIMITED', retryable: true, remedy: 'retry after a short pause — the provider is throttling' }],
])

/**
 * Translate a provider error frame into a typed failure.
 *
 * The provider's `message`, `code` and `param` are preserved: they name the offending field, which
 * makes them the fastest available specification. Only the fields are carried — never the frame,
 * which for an audio event could contain conversation content.
 *
 * The code is additionally **classified**, because it is the only thing that separates a credential
 * the provider refused from an account that cannot pay, and a caller that cannot tell those apart
 * cannot tell the user what to do.
 * @param event - a parsed frame.
 * @returns a coded error carrying the provider's own field-naming detail.
 */
export function toProviderError(event: ParsedServerEvent): RealtimeError {
  // Precondition: `event.type === 'error'`, established by the caller's switch over a frame it has
  // already classified. Asserting that here rather than returning `undefined` keeps the caller free
  // of a guard no test could exercise — an unreachable branch is a lie about the contract.
  const body = event.error
  const detail = typeof body === 'object' && body !== null
    ? body as { code?: unknown; message?: unknown; param?: unknown }
    : undefined
  const message = nonEmptyString(detail?.message) ?? 'the provider reported an unspecified error'
  const codeText = nonEmptyString(detail?.code)
  const param = nonEmptyString(detail?.param)
  const summary = [
    message,
    codeText === undefined ? undefined : `code=${codeText}`,
    param === undefined ? undefined : `param=${param}`,
  ].filter(part => part !== undefined).join(' — ')

  // The provider's code is the only thing that distinguishes "add credit" from "replace the key", so
  // it is classified rather than described. An unrecognised code keeps the generic class: guessing a
  // class would be worse than admitting we do not know which one it is.
  const known = codeText === undefined ? undefined : PROVIDER_FAILURES.get(codeText)
  return new RealtimeError(summary, known?.code ?? 'PROVIDER_ERROR', {
    detail: {
      ...codeText === undefined ? {} : { providerCode: codeText },
      retryable: known?.retryable ?? false,
      ...known === undefined ? {} : { remedy: known.remedy },
    },
  })
}

/**
 * The bound this adapter enforces on one context append, before it reaches the wire.
 *
 * Re-exported so a caller can pre-flight without importing the seam directly; the value is the
 * seam's, not this package's, because two adapters must agree on it.
 */
export const APPEND_CHAR_LIMIT = MAX_APPEND_CHARS
