/**
 * GPT-Live-1 full-duplex voice for DeepSeek Harness.
 *
 * A **function plugin** on the `dsh-realtime` seam: it registers one adapter for one provider route.
 * Per the harness convention it named-exports `name` / `inject` / `Config` / `apply` and has **no
 * default export** — adding one makes the Loader discard this plugin's namespace, so the plugin would
 * load and contribute nothing.
 *
 * The credential is supplied by the composition, never read from a file:
 *
 * ```yaml
 * - name: dsh-realtime-openai
 *   config:
 *     apiKey: !!js process.env.OPENAI_LIVE_API_KEY
 *     voice: marin
 * ```
 *
 * @module dsh-realtime-openai
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { OpenAiLiveAdapter } from './adapter.ts'
import { WsTransportFactory } from './transport.ts'
import type { OpenAiLiveConfig } from './types.ts'

export * from './types.ts'
export * from './wire.ts'
export * from './translate.ts'
export { OpenAiLiveAdapter, API_KEY_SETTING, resolveApiKey } from './adapter.ts'
export { OpenAiLiveSession } from './session.ts'
export { WsTransportFactory } from './transport.ts'

/** Plugin name, as it appears in Loader diagnostics. */
export const name = 'realtime-openai-live'

/** This plugin registers onto the realtime seam, so it waits for it. */
export const inject = ['realtime']

/**
 * Validated configuration.
 *
 * `apiKey` is optional here and supplied by the composition, so a profile that mounts this plugin
 * without a credential — a replay or an offline profile — still composes, and the failure lands at
 * the session request as a coded error naming the setting rather than at boot with an opaque one.
 */
export const Config = Schema.object({
  apiKey: Schema.string().required(false).description('OpenAI API key; supply it from the environment'),
  baseURL: Schema.string().default('wss://api.openai.com/v1/live/sessions').description('Live session endpoint'),
  provider: Schema.string().default('openai-live').description('Provider route to register on the seam'),
  model: Schema.string().default('gpt-live-1').description('Default voice model'),
  voice: Schema.string().default('marin').description('Default output voice'),
  appendAckTimeoutMs: Schema.number().default(10_000).description('Bound on waiting for an append acknowledgement'),
  establishTimeoutMs: Schema.number().default(20_000).description('Bound on waiting for session.started'),
})

/**
 * Register the adapter for the configured provider route.
 * @param ctx - the Cordis context, which must already provide the `realtime` service.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: OpenAiLiveConfig): void {
  ctx.realtime.registerAdapter([config.provider], new OpenAiLiveAdapter(config, new WsTransportFactory()))
}
