/**
 * The adapter — the route the seam registers, and the place a session is proved live before it is handed out.
 *
 * The seam's contract is explicit that `session()` must **throw rather than resolve with a dead session**, and
 * this provider makes that rule earn its keep: its socket accepts a connection and then rejects the Settings
 * (the P1 probe did exactly that on its first run, with `listen.provider.type: 'flux'`). A session that resolved
 * on `open` would therefore be a session that looks alive, produces no audio, and reports nothing. So `session()`
 * waits for `SettingsApplied` — the provider's own statement that it parsed the configuration — and fails
 * otherwise.
 *
 * The socket is injected for the same reason the transport takes one: the whole adapter can be exercised against
 * a fake, with no key and no network.
 *
 * @module dsh-realtime-deepgram/adapter
 */
import { DEEPGRAM_CAPABILITIES, REALTIME_ERROR_CODES, RealtimeAdapter, RealtimeError } from 'dsh-realtime'
import type {
  RealtimeModelInfo,
  RealtimeProviderInfo,
  RealtimeSession,
  RealtimeSessionOptions,
} from 'dsh-realtime'
import { buildSettings } from './settings.ts'
import type { SettingsConfig } from './settings.ts'
import { openSession } from './session.ts'
import type { DeepgramSession } from './session.ts'
import { openTransport } from './transport.ts'
import type { SocketLike } from './transport.ts'
import type { ServerFrame } from './wire.ts'

/** The production endpoint. */
export const AGENT_ENDPOINT = 'wss://agent.deepgram.com/v1/agent/converse'

/** Builds a socket for a URL and headers. Injected so tests never open one. */
export type SocketFactory = (url: string, headers: Readonly<Record<string, string>>) => SocketLike

/** Adapter configuration. `apiKey` is optional so a profile without a credential still composes. */
export interface DeepgramAdapterConfig {
  /** Deepgram API key. Never logged, never named in a message beyond the setting it belongs to. */
  readonly apiKey?: string
  /** Override the endpoint (a fixture, a proxy). */
  readonly endpoint?: string
  /** The brain. */
  readonly think: SettingsConfig['think']
  readonly listen?: SettingsConfig['listen']
  readonly speak?: SettingsConfig['speak']
  /** How long `session()` may wait for `SettingsApplied`. Defaults to 20 s. */
  readonly establishTimeoutMs?: number
}

/** The models this adapter advertises. Advisory: an unlisted id is still attempted. */
const MODELS: readonly RealtimeModelInfo[] = [
  { id: 'flux-general-en', name: 'Deepgram Flux (English)', inputModalities: ['audio'], outputModalities: ['text'] },
  { id: 'nova-3', name: 'Deepgram Nova-3', inputModalities: ['audio'], outputModalities: ['text'] },
]

/** Reject with a coded timeout if `promise` has not settled within `ms`. */
async function withBudget(promise: Promise<void>, ms: number): Promise<void> {
  let expire!: (error: Error) => void
  const budget = new Promise<never>((_, reject) => { expire = reject })
  // Created outside the promise so the handle is always defined: a `handle !== undefined` guard here would be a
  // branch no test can reach, which is the same as an untested claim.
  const handle = setTimeout(() => {
    expire(new RealtimeError(
      `the provider did not apply its settings within ${ms} ms`,
      REALTIME_ERROR_CODES.PROVIDER_TIMEOUT,
    ))
  }, ms)
  try {
    await Promise.race([promise, budget])
  } finally {
    clearTimeout(handle)
  }
}

/** A live session, or a coded refusal. */
export class DeepgramAdapter extends RealtimeAdapter {
  private readonly config: DeepgramAdapterConfig
  private readonly openSocket: SocketFactory

  /**
   * @param config - validated configuration.
   * @param openSocket - socket constructor; the plugin passes `ws`, tests pass a fake.
   */
  constructor(config: DeepgramAdapterConfig, openSocket: SocketFactory) {
    super()
    this.config = config
    this.openSocket = openSocket
  }

  /** Describe the route, including what this provider can and cannot do. */
  override providerInfo(provider: string): RealtimeProviderInfo {
    return {
      id: provider,
      name: 'Deepgram Voice Agent',
      description: 'Deepgram Voice Agent (A′): DSH is the only brain; the provider is a device driver.',
      capabilities: DEEPGRAM_CAPABILITIES,
    }
  }

  /** Advertise the listening models. */
  override listModels(): Promise<readonly RealtimeModelInfo[]> {
    return Promise.resolve(MODELS)
  }

  /**
   * Open one session, and do not return one that is not live.
   *
   * Waits for `SettingsApplied`. Fails on: no credential, an aborted signal, a provider `Error` frame, a close
   * before the ack, or the establish budget expiring — each with its own code.
   */
  override async session(options: RealtimeSessionOptions): Promise<RealtimeSession> {
    const key = this.config.apiKey
    if (key === undefined || key.trim().length === 0) {
      throw new RealtimeError(
        'no Deepgram API key: set the credential this plugin reads (DEEPGRAM_API_KEY)',
        REALTIME_ERROR_CODES.MISSING_CREDENTIAL,
      )
    }
    if ((options as { signal?: AbortSignal }).signal?.aborted === true) {
      throw new RealtimeError('the session was abandoned before it opened', REALTIME_ERROR_CODES.NETWORK)
    }
    // `handlers` is optional on the request; an absent one means a caller that only wants the session handle.
    const handlers = options.handlers ?? {}
    const settings = buildSettings({
      think: this.config.think,
      ...(this.config.listen === undefined ? {} : { listen: this.config.listen }),
      ...(this.config.speak === undefined ? {} : { speak: this.config.speak }),
    })
    const socket = this.openSocket(this.config.endpoint ?? AGENT_ENDPOINT, { Authorization: `Token ${key}` })

    // One-shot settlement: the first of (SettingsApplied | close | error | budget) decides the outcome, and a
    // later one must not overwrite it.
    let settle: ((error?: Error) => void) | undefined
    const established = new Promise<void>((resolve, reject) => {
      settle = (error?: Error) => { if (error === undefined) resolve(); else reject(error) }
    })
    const once = (error?: Error): void => { const fn = settle; settle = undefined; fn?.(error) }

    let session: DeepgramSession | undefined
    const transport = openTransport(socket, {
      onFrame: (frame: ServerFrame) => {
        // `SettingsApplied` is the provider saying it parsed the configuration; `Welcome` alone is not enough —
        // the probe was welcomed, then had its settings refused.
        if (frame.type === 'SettingsApplied') once()
        if (frame.type === 'Error') {
          // A refused Settings arrives as an Error frame, and this is the exact shape P1 hit: the socket is
          // open, nothing is playing, and the only evidence is this frame. It has to fail the establishment,
          // or `session()` hands out a session that is alive and inert.
          const description = typeof frame['description'] === 'string' && frame['description'].length > 0
            ? frame['description']
            : 'the provider rejected the session settings'
          once(new RealtimeError(description, REALTIME_ERROR_CODES.PROVIDER_ERROR))
        }
        // A frame can only arrive after `openSession` has sent Settings, which happens before it returns; the
        // optional chain covers the single synchronous tick in between.
        session?.receive(frame)
      },
      onAudio: (pcm16) => { handlers.onAudio?.(pcm16) },
      onClose: (reason) => {
        once(new RealtimeError(
          `the provider closed the session before it was established${reason === undefined ? '' : `: ${reason}`}`,
          REALTIME_ERROR_CODES.NETWORK,
        ))
      },
      onError: (error) => {
        // A transport failure is a transport fact, so it leaves here coded rather than as a bare Error: a caller
        // branching on `code` must not have to guess which layer refused it.
        const coded = error instanceof RealtimeError ? error : new RealtimeError(error.message, REALTIME_ERROR_CODES.NETWORK)
        once(coded)
        handlers.onError?.(coded)
      },
    })
    session = openSession({ provider: options.provider, settings, transport, handlers })

    await withBudget(established, this.config.establishTimeoutMs ?? 20_000)
    return session
  }
}
