/**
 * Types for the GPT-Live-1 adapter. This module contains **no runtime code**.
 *
 * @module dsh-realtime-openai/types
 */

/** The plugin's validated configuration, as composed from `cordis.yml`. */
export interface OpenAiLiveConfig {
  /**
   * The API key. The composition supplies it (`apiKey: !!js process.env.OPENAI_LIVE_API_KEY`);
   * this package never reads a key file. Absent means the session request fails with a coded error
   * naming the setting, never the value.
   */
  apiKey?: string
  /** Live session endpoint. Overridable for a proxy or a recorded replay server. */
  baseURL: string
  /** Voice model route id registered on the seam. */
  provider: string
  /** Default model when a session request does not name one. */
  model: string
  /** Default output voice when a session request does not name one. */
  voice: string
  /**
   * How long to wait for the provider's acknowledgement of one context append.
   *
   * Deployment-varying rather than a constant: a proxy or a loaded region legitimately needs longer,
   * and an ack that never arrives must fail loudly rather than hang a live conversation.
   */
  appendAckTimeoutMs: number
  /**
   * How long to wait for `session.started` after sending the opening frame.
   *
   * Separate from {@link OpenAiLiveConfig.appendAckTimeoutMs} because it bounds a different
   * operation: measured establishment was ~1.1 s, but a cold route or a proxy adds to that, and a
   * failed handshake must surface as a thrown error rather than an open socket with no session.
   */
  establishTimeoutMs: number
}

/** Handlers a transport invokes. Kept separate from the socket so the adapter owns no callback API. */
export interface RealtimeTransportHandlers {
  /** One complete text frame arrived. */
  onMessage(frame: string): void
  /** The transport closed. `code` and `reason` are transport-supplied when available. */
  onClose(code: number, reason: string): void
  /** A transport-level failure. */
  onError(error: Error): void
}

/** An open transport. The adapter holds no transport-specific type. */
export interface RealtimeTransport {
  /** Send one already-serialized frame. */
  send(frame: string): void
  /** Close the transport. Idempotent. */
  close(): void
}

/**
 * Opens transports.
 *
 * Injected rather than imported so a test can drive the whole adapter with no network and no
 * credential — the property that makes the keyless-replay CI contract possible rather than aspirational.
 */
export interface RealtimeTransportFactory {
  /**
   * Connect and resolve once the transport is open.
   * @param url - absolute endpoint.
   * @param headers - request headers, including authorization.
   * @param handlers - frame and lifecycle callbacks.
   * @returns the open transport.
   */
  connect(
    url: string,
    headers: Readonly<Record<string, string>>,
    handlers: RealtimeTransportHandlers,
  ): Promise<RealtimeTransport>
}

/** The fully-resolved target of one session attempt. */
export interface LiveSessionTarget {
  /** Absolute WebSocket endpoint. */
  url: string
  /** Request headers, including the authorization bearer. */
  headers: Readonly<Record<string, string>>
  /** Exact model id to request. */
  model: string
  /** Output voice; omitted when the caller wants the provider default. */
  voice?: string
  /** Opening instructions; omitted when the caller supplies none. */
  instructions?: string
}
