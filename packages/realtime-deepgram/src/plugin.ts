/**
 * The Cordis plugin — Deepgram Voice Agent on the `dsh-realtime` seam.
 *
 * A **function plugin** with named exports and **no default export**: per the harness convention, adding a
 * default makes the Loader discard this plugin's namespace, so the plugin loads and contributes nothing — a
 * failure with no error and no log line, which is why it is stated here rather than discovered.
 *
 * Two things `apply` does beyond registering the route:
 *
 * 1. **The credential becomes a journal secret.** This plugin is the one that holds the key, so it is the one
 *    that can name it for redaction. Registered *before* the adapter, so no journal record can be written ahead
 *    of the redaction that knows about this value.
 * 2. **The route is registered with its capabilities attached**, so a caller can read what this provider cannot
 *    do before it opens a session.
 *
 * @module dsh-realtime-deepgram/plugin
 */
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { DeepgramAdapter } from './adapter.ts'
import { openWebSocket } from './ws.ts'

/** Plugin name, as it appears in Loader diagnostics. */
export const name = 'realtime-deepgram'

/** This plugin registers onto the realtime seam, so it waits for it. */
export const inject = ['realtime']

/** The name of the environment variable the composition should read the key from. */
export const API_KEY_SETTING = 'DEEPGRAM_API_KEY'

/**
 * Validated configuration.
 *
 * `apiKey` is optional so a profile without a credential still composes: the failure then lands at the session
 * request as `MISSING_CREDENTIAL` naming the setting, rather than at boot with an opaque error — the same
 * arrangement the OpenAI route uses, for the same reason.
 */
export const Config = Schema.object({
  apiKey: Schema.string().description(`Deepgram API key; supply it from ${API_KEY_SETTING}`),
  provider: Schema.string().default('deepgram').description('Provider route to register on the seam'),
  thinkModel: Schema.string().default('gpt-4o-mini').description('LLM the provider calls'),
  thinkPrompt: Schema.string().default('You are a helpful voice assistant.').description('System prompt'),
  thinkEndpoint: Schema.string().description('Bring-your-own OpenAI-compatible endpoint; omit to use Deepgram\'s'),
  listenModel: Schema.string().default('flux-general-en').description('Speech-to-text model'),
  speakModel: Schema.string().default('aura-2-thalia-en').description('Voice model'),
  establishTimeoutMs: Schema.number().default(20_000).description('Bound on waiting for SettingsApplied'),
})

/** The configuration `apply` receives, after validation. */
export interface DeepgramPluginConfig {
  readonly apiKey?: string
  readonly provider?: string
  readonly thinkModel?: string
  readonly thinkPrompt?: string
  readonly thinkEndpoint?: string
  readonly listenModel?: string
  readonly speakModel?: string
  readonly establishTimeoutMs?: number
}

/**
 * Register the adapter for the configured route.
 * @param ctx - the Cordis context, which must already provide the `realtime` service.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: DeepgramPluginConfig = {}): void {
  ctx.realtime.journal.addSecrets(config.apiKey === undefined ? [] : [config.apiKey])
  ctx.realtime.registerAdapter(
    [config.provider ?? 'deepgram'],
    new DeepgramAdapter(
      {
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        think: {
          model: config.thinkModel ?? 'gpt-4o-mini',
          prompt: config.thinkPrompt ?? 'You are a helpful voice assistant.',
          ...(config.thinkEndpoint === undefined ? {} : { endpoint: config.thinkEndpoint }),
        },
        listen: { model: config.listenModel ?? 'flux-general-en' },
        speak: { model: config.speakModel ?? 'aura-2-thalia-en' },
        ...(config.establishTimeoutMs === undefined ? {} : { establishTimeoutMs: config.establishTimeoutMs }),
      },
      openWebSocket,
    ),
  )
}
