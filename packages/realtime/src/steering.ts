/**
 * Who is steering which session.
 *
 * A delegation is answered by *some* plugin into *some* DSH session, and until this existed that pairing was
 * visible only as a settings key inside one plugin's own namespace — `realtime-responder.sessionId` — so any
 * surface that wanted to show it had to know that plugin by name and read a string it did not own. The
 * pairing belongs on the seam, which every plugin in the bundle already holds: declared once by the plugin
 * that steers, readable by anybody, and nobody naming anybody else.
 *
 * It is a registry rather than a field on the runtime because more than one plugin may steer a session —
 * two responders pointed at two conversations is a composition the seam permits — and because a claim has a
 * lifetime: it exists while the plugin that made it is mounted, and is withdrawn with that plugin's fiber.
 *
 * @module dsh-realtime/steering
 */

/** One plugin's claim to be answering delegations into a session. */
export interface SteeringClaim {
  /** The declaring plugin, as it appears in the composition. */
  readonly owner: string
  /**
   * The session its answers are injected into.
   *
   * Read at snapshot time rather than captured, because the session is a **live** setting: a responder
   * pointed at another conversation must read differently here from the moment that change lands, and a
   * copy taken at declaration would describe where it used to point.
   */
  readonly sessionId: string
}

/** A claim as the plugin that steers declares it. */
export interface SteeringDeclaration {
  /** The declaring plugin, as it appears in the composition. */
  readonly owner: string
  /** Read whenever the claims are read. See {@link SteeringClaim.sessionId}. */
  readonly sessionId: () => string
}

/**
 * The claims in force, in the order they were declared.
 *
 * Ordered rather than keyed because a reader rendering this wants a stable list — declaration order is the
 * only order that is stable without an owner having to be meaningful, and an owner is a name, not a rank.
 */
export class SteeringRegistry {
  private readonly claims = new Map<number, SteeringDeclaration>()
  private nextToken = 1

  /**
   * Declare a claim.
   * @param declaration - who is steering, and an accessor for the session.
   * @returns the disposer. Idempotent by construction: the token is never reused, so releasing twice
   *   cannot remove somebody else's claim.
   */
  add(declaration: SteeringDeclaration): () => void {
    const token = this.nextToken
    this.nextToken += 1
    this.claims.set(token, declaration)
    return () => {
      this.claims.delete(token)
    }
  }

  /**
   * What is in force right now.
   * @returns one claim per live declaration, oldest first. Empty means nothing is steering, which is itself
   *   an answer: a delegation raised now would be answered by nobody, and the model is told so out loud.
   */
  snapshot(): SteeringClaim[] {
    return [...this.claims.values()].map(declaration => ({
      owner: declaration.owner,
      sessionId: declaration.sessionId(),
    }))
  }
}
