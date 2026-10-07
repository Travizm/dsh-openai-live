/**
 * Types for the replay backend. This module contains **no runtime code**.
 *
 * @module dsh-realtime-replay/types
 */

/**
 * One recorded server frame.
 *
 * The format is deliberately the raw output of a recording run — `{t, event}` per line — rather than
 * a distilled fixture. A distilled format would need its own translator, and the translator would be
 * a second place for the provider's vocabulary to drift. This is what the wire said.
 */
export interface RecordedFrame {
  /**
   * Milliseconds from session start, as observed when the frame was recorded.
   *
   * Retained for fidelity and for future timing-accurate playback. The current transport delivers in
   * recorded order without pacing, because a CI assertion about ordering must not depend on wall-clock
   * timing.
   */
  t: number
  /** The provider's frame, verbatim. */
  event: Record<string, unknown>
}

/** The plugin's validated configuration. */
export interface ReplayConfig {
  /** Provider route to register on the seam. */
  provider: string
  /** Path to the recorded session: a JSONL file of `{t, event}` rows. */
  fixture: string
  /**
   * Endpoint the adapter is told to dial.
   *
   * Defaults to a `.invalid` address, which cannot resolve: the replay transport never opens a
   * connection, and the default makes that impossible to mistake for a real one.
   */
  baseURL: string
  /** Model id reported in the session facts. */
  model: string
  /** Output voice reported in the session facts. */
  voice: string
  /** Bound on waiting for a context-append acknowledgement. */
  appendAckTimeoutMs: number
  /** Bound on waiting for `session.started`. */
  establishTimeoutMs: number
}
