/**
 * Keyless replay for the realtime seam.
 *
 * A **function plugin** that registers a provider route backed by a recorded session instead of a
 * live one. It named-exports `name` / `inject` / `Config` / `apply` and has **no default export** —
 * adding one makes the Loader discard this plugin's namespace, so it would load and contribute nothing.
 *
 * ```yaml
 * - name: dsh-realtime-replay
 *   config:
 *     fixture: ./recordings/staging-session.jsonl
 * ```
 *
 * No credential is accepted, by design: the transport never transmits, so a real key here would be a
 * secret with no purpose and one more place to leak from.
 *
 * @module dsh-realtime-replay
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { OpenAiLiveAdapter } from 'dsh-realtime-openai'
import { loadRecording } from './recording.ts'
import { ReplayTransportFactory } from './transport.ts'
import type { ReplayConfig } from './types.ts'

export * from './types.ts'
export { loadRecording, parseRecording } from './recording.ts'
export { ReplayTransportFactory } from './transport.ts'

/**
 * The credential handed to the adapter.
 *
 * The adapter requires one before it will build a session. The replay transport discards it, so this
 * is not a secret and grants nothing — but it must exist, and naming it plainly is better than
 * inventing something that looks like a key.
 */
export const REPLAY_CREDENTIAL = 'replay-no-credential'

/** Plugin name, as it appears in Loader diagnostics. */
export const name = 'realtime-replay'

/** This plugin registers onto the realtime seam, so it waits for it. */
export const inject = ['realtime']

/**
 * Validated configuration.
 *
 * `fixture` is required and read at compose time, so a missing or malformed recording fails at boot
 * with the file and line named — not later, as an unexplained quiet session.
 */
export const Config = Schema.object({
  provider: Schema.string().default('replay').description('Provider route to register on the seam'),
  fixture: Schema.string().description('Path to a recorded session: JSONL of {t, event} rows'),
  baseURL: Schema.string().default('wss://replay.invalid/v1/live/sessions')
    .description('Endpoint recorded but never dialled; the default cannot resolve'),
  model: Schema.string().default('gpt-live-1').description('Model id reported in the session facts'),
  voice: Schema.string().default('marin').description('Output voice reported in the session facts'),
  appendAckTimeoutMs: Schema.number().default(5000).description('Bound on waiting for an append acknowledgement'),
  establishTimeoutMs: Schema.number().default(5000).description('Bound on waiting for session.started'),
})

/**
 * Register the replay route.
 * @param ctx - the Cordis context, which must already provide the `realtime` service.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: ReplayConfig): void {
  const recording = loadRecording(config.fixture)
  ctx.realtime.registerAdapter([config.provider], new OpenAiLiveAdapter({
    apiKey: REPLAY_CREDENTIAL,
    baseURL: config.baseURL,
    provider: config.provider,
    model: config.model,
    voice: config.voice,
    appendAckTimeoutMs: config.appendAckTimeoutMs,
    establishTimeoutMs: config.establishTimeoutMs,
  }, new ReplayTransportFactory(recording)))
}
