/**
 * The GPT-Live-1 adapter: one provider route on the realtime seam.
 *
 * @module dsh-realtime-openai/adapter
 */

import { RealtimeAdapter, RealtimeError } from 'dsh-realtime'
import type { Journal, RealtimeModelInfo, RealtimeProviderInfo, RealtimeSession } from 'dsh-realtime'
import { OpenAiLiveSession } from './session.ts'
import { API_KEYS_URL, toStarted, toProviderError } from './translate.ts'
import { isKnownServerEvent, parseServerEvent, sessionStart } from './wire.ts'
import type { OpenAiLiveConfig, LiveSessionTarget, RealtimeTransportFactory } from './types.ts'

/** The setting named when no credential is configured. Names the setting, never a value. */
export const API_KEY_SETTING = 'apiKey'

/** Display name this adapter reports for its route. */
const PROVIDER_NAME = 'OpenAI Live'

/**
 * Resolve the credential, or refuse the request.
 *
 * The value is never echoed — not in the error, not in a log line. A credential failure names the
 * *setting*, because that is what a user can act on and what cannot leak.
 * @param config - the resolved plugin configuration.
 * @returns the trimmed key.
 * @throws RealtimeError `NOT_CONFIGURED` when the setting is absent or blank.
 */
export function resolveApiKey(config: OpenAiLiveConfig): string {
  const key = (config.apiKey ?? '').trim()
  if (key.length === 0) {
    // A missing credential is a *state*, not a fault: it is what a fresh install looks like, and it
    // is fixed by supplying a value rather than by retrying. The detail says so in words the caller
    // can relay, and names the setting without ever approaching a value.
    throw new RealtimeError(
      `no API key configured: set "${API_KEY_SETTING}" to the raw key`
      + ` (the composition supplies it from the environment)`,
      'NOT_CONFIGURED',
      {
        detail: {
          setting: API_KEY_SETTING,
          retryable: false,
          remedy: `set "${API_KEY_SETTING}" (or the OPENAI_LIVE_API_KEY environment variable) to an`
            + ' OpenAI key, then start the voice session again',
          // The same page the provider's own refusal points at: one is "you have no key" and the other is
          // "that key is wrong", and both are answered by the same URL.
          link: API_KEYS_URL,
        },
      },
    )
  }
  return key
}

/** Serves GPT-Live-1 sessions for one registered provider route. */
export class OpenAiLiveAdapter extends RealtimeAdapter {
  private readonly config: OpenAiLiveConfig
  private readonly transports: RealtimeTransportFactory
  private readonly journal: Pick<Journal, 'record'> | undefined

  /**
   * @param config - resolved plugin configuration.
   * @param transports - transport factory; injected so tests drive the adapter with no network.
   * @param journal - where a session records what it accepted, when the composition supplies one.
   */
  constructor(config: OpenAiLiveConfig, transports: RealtimeTransportFactory, journal?: Pick<Journal, 'record'>) {
    super()
    this.config = config
    this.transports = transports
    this.journal = journal
  }

  /** @returns this adapter's display metadata for `provider`. */
  override providerInfo(provider: string): RealtimeProviderInfo {
    return {
      id: provider,
      name: PROVIDER_NAME,
      description: 'GPT-Live-1 full-duplex voice with client delegation',
    }
  }

  /**
   * Advertise the configured model.
   *
   * Advisory only, and deliberately not a discovery call: listing models would cost a session or a
   * separate request, and absence here must never gate a session anyhow.
   * @returns the configured model.
   */
  override async listModels(): Promise<readonly RealtimeModelInfo[]> {
    return [{
      id: this.config.model,
      name: this.config.model,
      inputModalities: ['audio', 'text'],
      outputModalities: ['audio', 'text'],
    }]
  }

  /**
   * Open a live session.
   *
   * The handshake is bounded and its failures are thrown, not swallowed: a socket that opens and
   * then never establishes is exactly the failure that looks healthy from the outside.
   * @param options - the session request.
   * @returns the live session.
   * @throws RealtimeError `MISSING_CREDENTIAL`, or `PROVIDER_ERROR` when the handshake fails.
   */
  override async session(options: Parameters<RealtimeAdapter['session']>[0]): Promise<RealtimeSession> {
    const target: LiveSessionTarget = {
      url: this.config.baseURL,
      headers: { Authorization: `Bearer ${resolveApiKey(this.config)}` },
      model: options.model.length > 0 ? options.model : this.config.model,
      ...options.voice === undefined ? {} : { voice: options.voice },
      ...options.instructions === undefined ? {} : { instructions: options.instructions },
    }
    if (target.voice === undefined && this.config.voice.length > 0) {
      (target as { voice?: string }).voice = this.config.voice
    }

    // Frames that arrive between the socket opening and the session object existing. Nothing is
    // dropped: establishment and the first deltas can share one tick.
    const buffered: string[] = []
    let established: OpenAiLiveSession | undefined

    const settleEstablish = Promise.withResolvers<RealtimeSession>()
    // A transport that fails to open may report to these handlers before `connect` rejects, which
    // would settle this promise with nobody awaiting it. Mark it handled: the rejection that reaches
    // the caller is `connect`'s, and an unhandled-rejection warning would misreport a clean failure.
    settleEstablish.promise.catch(() => undefined)
    const timer = setTimeout(() => {
      settleEstablish.reject(new RealtimeError(
        `the provider did not confirm the session within ${this.config.establishTimeoutMs}ms`,
        'PROVIDER_TIMEOUT',
        { detail: { retryable: true, remedy: 'retry voice_start — the provider did not answer in time' } },
      ))
    }, this.config.establishTimeoutMs)

    const transport = await this.transports.connect(target.url, target.headers, {
      onMessage: (frame: string) => {
        if (established !== undefined) {
          established.handleFrame(frame)
          return
        }
        const event = parseServerEvent(frame)
        if (event !== null && isKnownServerEvent(event)) {
          if (event.type === 'session.started') {
            clearTimeout(timer)
            const session = new OpenAiLiveSession({
              transport,
              started: toStarted(event, {
                provider: options.provider,
                model: target.model,
                ...target.voice === undefined ? {} : { voice: target.voice },
              }),
              id: `${target.model}:${String((event as { session?: { id?: unknown } }).session?.id ?? 'session')}`,
              handlers: options.handlers ?? {},
              appendAckTimeoutMs: this.config.appendAckTimeoutMs,
              ...this.journal === undefined ? {} : { journal: this.journal },
            })
            established = session
            settleEstablish.resolve(session)
            for (const queued of buffered.splice(0)) session.handleFrame(queued)
            return
          }
          if (event.type === 'error') {
            clearTimeout(timer)
            // Classified rather than generic: a session opening refused because the key was refused
            // and one refused because the account is out of credit are the same event here and must
            // not be the same error — this is the path a user with a *present but wrong* key hits.
            settleEstablish.reject(toProviderError(event))
            return
          }
        }
        buffered.push(frame)
      },
      onClose: (code: number, reason: string) => {
        if (established !== undefined) {
          established.handleTransportClose(reason.length > 0 ? reason : `transport closed (${code})`)
          return
        }
        clearTimeout(timer)
        settleEstablish.reject(new RealtimeError(
          `the transport closed before the session was established (${code}${reason.length > 0 ? `: ${reason}` : ''})`,
          'PROVIDER_ERROR',
        ))
      },
      onError: (error: Error) => {
        if (established !== undefined) {
          established.handleTransportError(error)
          return
        }
        clearTimeout(timer)
        settleEstablish.reject(new RealtimeError(
          'the transport failed before the session was established',
          'PROVIDER_ERROR',
          { cause: error },
        ))
      },
    })
    // A failed open must not leave the establishment bound armed: the handshake never started, and a
    // timer that outlives its operation is precisely the resource the harness requires be owned
    // through teardown.
    .catch((error: unknown) => {
      clearTimeout(timer)
      throw error
    })

    transport.send(sessionStart(target.model, target.instructions, target.voice))
    try {
      return await settleEstablish.promise
    } catch (error: unknown) {
      // A rejected handshake must not leave a socket behind.
      transport.close()
      throw error
    }
  }
}
