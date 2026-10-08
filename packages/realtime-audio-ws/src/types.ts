/**
 * The audio route's public vocabulary.
 *
 * This package is the **host end** of the client half's transport: it claims a WebSocket upgrade route on
 * the harness web server and bridges that socket to the two bus events `dsh-realtime-agent` already
 * publishes and consumes — `realtime-agent/mic` inbound, `realtime-agent/audio` outbound. It owns no audio
 * logic and no session; it is transport and nothing else.
 *
 * Why an upgrade route rather than something tidier: a third-party plugin cannot add a Remote method. The
 * Remote assembly mounts a fixed, build-time set of capabilities inside a DeepSeek-owned package, so the
 * web server's route registry — explicitly "a plain route registry with no harness vocabulary", built for
 * other plugins to claim routes on — is the door that is actually open to us.
 */

/** Default pathname the route claims. Absolute, no trailing slash, matching the web server's contract. */
export const DEFAULT_PATH = '/dsh-realtime/audio'

/** Largest inbound frame accepted, in bytes. One second of 24 kHz mono PCM16 is 48 000 B. */
export const DEFAULT_MAX_FRAME_BYTES = 480_000

/** How many sockets may be attached at once. One microphone is the honest default. */
export const DEFAULT_MAX_CONNECTIONS = 1

export interface RealtimeAudioWsConfig {
  /**
   * Absolute pathname to claim. Registered exactly, so it must be distinct from every other route in the
   * composition — a duplicate throws at registration rather than shadowing silently.
   */
  readonly path: string
  /**
   * Longest inbound frame accepted, in bytes. A frame above this closes the connection: this route carries
   * audio, and an unbounded frame is a memory hole wearing an audio-shaped hat.
   */
  readonly maxFrameBytes: number
  /**
   * Most sockets attached at once. Above this a new connection is closed with 1013 rather than queued —
   * two microphones on one session is a fault, not a feature.
   */
  readonly maxConnections: number
}

/**
 * The slice of a WebSocket this package uses, described structurally.
 *
 * Structural rather than `import type { WebSocket } from 'ws'` for the same reason the responder describes
 * the session controller structurally: tests then need no socket at all, and `ws` stays a runtime-only
 * dependency of this package.
 *
 * The message payload is `unknown` because `ws` hands back `RawData` — a Buffer, an ArrayBuffer **or a
 * Buffer[]** — so the bridge normalises it through {@link toBytes} instead of pretending it is already a
 * `Uint8Array`.
 */
export interface AudioSocket {
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): unknown
}
