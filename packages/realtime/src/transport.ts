/**
 * The audio transport, as the plugin that owns its route reports it.
 *
 * A microphone reaches the session through a route some plugin claims on the web server, and until this
 * existed the only place that route's state was visible was that plugin's own control surface. A diagnostics
 * reader — an agent asked "is the voice working" — could say whether a session was open and nothing about
 * whether anything could reach it, which is the more common fault of the two.
 *
 * So the transport declares its own facts here, beside the steering claims and for the same reason: the seam
 * is the one object every plugin in the bundle holds, and a reader should not have to import the plugin that
 * owns the route to find out whether a client is attached.
 *
 * **What this deliberately does not carry.** The self-test's route check has two halves — an authorised
 * client is accepted, an unauthorised one is refused — and only the first is visible from inside. The
 * refusal half is a property of a handler that is only proven by probing it from outside, so it stays with
 * `scripts/self-test.mjs` rather than being restated here as a field nobody can make fail.
 *
 * @module dsh-realtime/transport
 */

/** One audio transport's state, right now. */
export interface TransportStatus {
  /** The path the route claims, as the browser half has to address it. */
  readonly path: string
  /** Clients attached at this moment. */
  readonly clients: number
}

/**
 * The declared transports, in the order they were declared.
 *
 * A list rather than a single slot, for the reason the seam permits two responders: a second declaration
 * must not silently displace the first, and a reader that found one route where there were two would report
 * on whichever plugin happened to load last.
 */
export class TransportRegistry {
  private readonly reports = new Map<number, () => TransportStatus>()
  private nextToken = 1

  /**
   * Declare a transport.
   * @param report - read whenever the transports are read, never captured: a client count is a fact about
   *   now, and a captured one would describe a connection that has since gone.
   * @returns the disposer. Safe to call twice, because the token is never reused.
   */
  add(report: () => TransportStatus): () => void {
    const token = this.nextToken
    this.nextToken += 1
    this.reports.set(token, report)
    return () => {
      this.reports.delete(token)
    }
  }

  /**
   * What is declared right now.
   * @returns one status per live declaration, oldest first. Empty means nothing carries audio, which for a
   *   voice plugin is a fault rather than a quiet state.
   */
  snapshot(): TransportStatus[] {
    return [...this.reports.values()].map(report => report())
  }
}
