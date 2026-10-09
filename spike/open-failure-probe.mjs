/**
 * Why did the session fail to open — in the provider's own words?
 *
 * The canary proves the endpoint and the credential by handshake alone, and a handshake sends no
 * `session.start`. This drives the **production adapter** with the **production payload** (built from
 * `sessionStart`, not reimplemented) so the provider classifies the same request the app makes, and prints
 * the refusal it returns.
 *
 * The message is redacted against the key before it is printed: a provider error is exactly where a
 * credential turns up, which is why the agent refuses to record the text and leaves it to the plugin that
 * holds the key. This script *is* that plugin, for one run.
 *
 * Usage: OPENAI_LIVE_API_KEY=… node spike/open-failure-probe.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import { redact, RealtimeRuntime } from 'dsh-realtime'
import { Config, OpenAiLiveAdapter, WsTransportFactory } from 'dsh-realtime-openai'

const key = process.env.OPENAI_LIVE_API_KEY ?? ''
if (key.trim().length === 0) {
  console.log('SKIP: no OPENAI_LIVE_API_KEY in the environment (run it through the same route the app uses)')
  process.exit(0)
}

// Exactly the bundle's row, which is what the running app composes.
const config = Config({
  provider: 'openai-live',
  model: 'gpt-live-1',
  voice: 'marin',
  apiKey: key,
})

const ctx = new Context()
new RealtimeRuntime(ctx)
const adapter = new OpenAiLiveAdapter(config, new WsTransportFactory())

const say = (label, value) => { console.log(`  ${label.padEnd(14)} ${value}`) }

try {
  const session = await adapter.session({
    provider: config.provider,
    model: config.model,
    voice: config.voice,
    handlers: {},
  })
  say('RESULT', 'the session OPENED — the payload is accepted by the provider')
  say('session', session.id)
  await session.close()
} catch (error) {
  say('RESULT', 'the session was REFUSED')
  say('code', String(error?.code))
  say('providerCode', String(error?.detail?.providerCode ?? '—'))
  say('retryable', String(error?.detail?.retryable ?? '—'))
  say('remedy', String(error?.detail?.remedy ?? '—'))
  // Redacted, never raw: this is the one string that can carry the key back out.
  say('message', redact(String(error?.message ?? error), [key]))
}
process.exit(0)
