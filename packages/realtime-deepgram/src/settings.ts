/**
 * Building the `Settings` message — the one frame that decides whether a session exists at all.
 *
 * Three of the fields here were wrong in the first version of the probe, and each failure looked identical from
 * the outside (the socket connected, then nothing worked):
 *
 * - `agent.listen.provider.type` is the **vendor** (`deepgram`), not the model family. `flux` is rejected with
 *   "Check the agent.listen.provider.type field against the API spec" and applies nothing.
 * - Flux models need `version: 'v2'`; everything else is `v1`.
 * - `agent.think.provider.endpoint` must be **absent** when the caller has no endpoint. An empty
 *   `endpoint.url` is not the same as no endpoint, and is rejected — so this builder omits the field rather
 *   than blanking it, and refuses a blank url rather than passing one through.
 *
 * The defaults are the configuration the probe ran and Deepgram accepted, so a caller that supplies only a
 * model and a prompt gets a session that works.
 *
 * @module dsh-realtime-deepgram/settings
 */
import type { SettingsMessage } from './wire.ts'

/** Refusal reasons, coded so a caller can branch rather than parse prose. */
export type SettingsErrorCode =
  /** A required field was missing or empty. */
  | 'MISSING_FIELD'
  /** A field carried a value the provider rejects or the spec forbids. */
  | 'INVALID_FIELD'
  /** An endpoint was given but is not an absolute http(s) URL. */
  | 'INVALID_ENDPOINT'

/** A refused configuration. */
export class SettingsError extends Error {
  /** Stable machine code. */
  readonly code: SettingsErrorCode
  /** The field that was refused, so a caller can highlight it rather than re-reading the whole config. */
  readonly field: string

  /**
   * @param message - what was refused, in the caller's terms. Must not contain prompt text.
   * @param code - one of {@link SettingsErrorCode}.
   * @param field - dotted path of the offending field.
   */
  constructor(message: string, code: SettingsErrorCode, field: string) {
    super(message, undefined)
    this.name = 'SettingsError'
    this.code = code
    this.field = field
  }
}

/** What a caller configures. Everything but `think` has a working default. */
export interface SettingsConfig {
  /** The brain. `model` and `prompt` are required; `endpoint` means bring-your-own LLM. */
  readonly think: { readonly model: string; readonly prompt: string; readonly endpoint?: string }
  /** Ears. Defaults to Flux — the model the probe ran. */
  readonly listen?: {
    readonly model?: string
    /** Flux only, `0.5`–`1.0`. Higher means fewer false end-of-turns. */
    readonly eotThreshold?: number
    readonly keyterms?: readonly string[]
  }
  /** Mouth. Defaults to Aura-2 Thalia. */
  readonly speak?: { readonly model?: string }
  /** Wire audio. Defaults match the probe: 16 kHz in, 24 kHz out, both `linear16`. */
  readonly audio?: { readonly inputSampleRate?: number; readonly outputSampleRate?: number }
}

/** The listen model the probe ran, and the only one this builder calls a default. */
export const DEFAULT_LISTEN_MODEL = 'flux-general-en'
/** The voice the probe ran. */
export const DEFAULT_SPEAK_MODEL = 'aura-2-thalia-en'
/** Flux models are `v2`; Nova and Aura are `v1`. */
export function listenVersion(model: string): 'v1' | 'v2' {
  return model.startsWith('flux-') ? 'v2' : 'v1'
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SettingsError(`${field} is required and must not be empty`, 'MISSING_FIELD', field)
  }
  return value
}

/**
 * Build the `Settings` frame.
 *
 * Refuses rather than repairs. A builder that silently substitutes a model, or blanks a bad endpoint into a
 * working one, produces a session that behaves differently from what the caller asked for and gives no signal
 * that it did.
 */
export function buildSettings(config: SettingsConfig): SettingsMessage {
  const model = requireNonEmpty(config.think?.model, 'think.model')
  const prompt = requireNonEmpty(config.think?.prompt, 'think.prompt')
  const listenModel = config.listen?.model ?? DEFAULT_LISTEN_MODEL
  const speakModel = config.speak?.model ?? DEFAULT_SPEAK_MODEL
  const threshold = config.listen?.eotThreshold
  if (threshold !== undefined && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0.5 || threshold > 1)) {
    // The provider accepts 0.5–1.0. A caller passing 0.2 would get silence about the rejection and a session
    // that never ends a turn.
    throw new SettingsError('listen.eotThreshold must be between 0.5 and 1', 'INVALID_FIELD', 'listen.eotThreshold')
  }
  return {
    type: 'Settings',
    audio: {
      input: { encoding: 'linear16', sample_rate: config.audio?.inputSampleRate ?? 16_000 },
      output: { encoding: 'linear16', sample_rate: config.audio?.outputSampleRate ?? 24_000 },
    },
    agent: {
      listen: {
        provider: {
          type: 'deepgram',
          model: listenModel,
          version: listenVersion(listenModel),
          ...(config.listen?.keyterms === undefined ? {} : { keyterms: config.listen.keyterms }),
          ...(threshold === undefined ? {} : { eot_threshold: threshold }),
        },
      },
      think: {
        provider: { type: 'open_ai', model },
        // Absent, never blank — and on `think`, not on `provider`: the live provider rejected the nested form with
        // "Check the agent.think field against the API spec". An empty url is rejected too, which is why the
        // builder omits the field rather than blanking it.
        ...(config.think.endpoint === undefined ? {} : { endpoint: { url: absoluteHttpUrl(config.think.endpoint) } }),
        prompt,
      },
      speak: { provider: { type: 'deepgram', model: speakModel } },
    },
  }
}

/** Validate a bring-your-own endpoint. Deepgram's cloud must be able to reach it, so a bare path is refused. */
function absoluteHttpUrl(value: string): string {
  if (value.trim().length === 0) {
    throw new SettingsError('think.endpoint is empty — omit it to use Deepgram\'s managed LLM', 'INVALID_ENDPOINT', 'think.endpoint')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new SettingsError('think.endpoint must be an absolute URL', 'INVALID_ENDPOINT', 'think.endpoint')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SettingsError(`think.endpoint must be http or https, not ${parsed.protocol}`, 'INVALID_ENDPOINT', 'think.endpoint')
  }
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
    // Not a style rule: Deepgram's cloud cannot resolve the caller's loopback, so this configuration is a
    // session that will fail at the first turn with nothing in the log to say why.
    throw new SettingsError('think.endpoint must be reachable from Deepgram\'s cloud, not a loopback address', 'INVALID_ENDPOINT', 'think.endpoint')
  }
  return parsed.toString()
}
