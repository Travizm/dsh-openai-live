/**
 * Redaction: the one place provider text becomes text a human or a log may see.
 *
 * The plugin's job is to hold a live session, so credentials flow through every path it has. Three
 * surfaces introduced for diagnostics — a journal, a route and spoken failures — are three new places
 * a provider key or the route's capability token could escape into, and a disclosure outlives the
 * debugging session that introduced it. Review does not scale to that; a primitive that every sink
 * passes through, with a test that fails on a planted string, does.
 *
 * Two arms, because the two kinds of secret cannot be caught the same way:
 *
 * - **Shape.** A key with a distinctive prefix (`sk-…`), a bearer header, a private-key block, a JWT,
 *   a recorded key fingerprint. These are unambiguous by construction and match anywhere.
 * - **Value.** The route's capability token is 32 random bytes in base64url — it has no prefix, no
 *   `=` padding and no structure, so no pattern can ever catch it. A caller that *holds* the secret
 *   must name it. That is why {@link redact} takes a list.
 *
 * There is deliberately **no allow-list and no "safe" mode**: a check with a compliant path relocates
 * the work instead of preventing it. Naming the setting is more useful to a reader than a literal
 * anyway.
 *
 * @module dsh-realtime/redact
 */

/** What replaces a value that must not travel. One marker, so a reader can count the removals. */
export const REDACTED = '[redacted]'

/**
 * Secrets whose *shape* is unambiguous, and the marker that replaces each.
 *
 * Every entry must be unmistakable on its own: a pattern that could match ordinary prose would
 * corrupt the diagnostic it was meant to protect, which is the same failure as leaking — a report
 * nobody can act on.
 */
const SHAPES: readonly (readonly [RegExp, string])[] = Object.freeze([
  // A PEM block, before the generic rules can chew holes in it.
  [/-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?-----END[^\n]*PRIVATE KEY-----/g, '[redacted private key]'],
  // A named API key: `sk-`, `rk-`, `pk-` and the vendor suffix they share.
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // An Authorization header carried in a message.
  [/\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // A JSON Web Token — three base64url segments, which is a credential or contains one.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  // A recorded key fingerprint: stable, org-identifying, and a leak in its own right.
  [/\bfp=[0-9a-f]{16,}/gi, `fp=${REDACTED}`],
] as const)

/**
 * Remove every occurrence of a secret the caller holds.
 *
 * Longest first: one secret can contain another (a fingerprint inside a key), and replacing the
 * shorter one first would leave a recognisable fragment of the longer one behind.
 *
 * @param text - candidate text.
 * @param secrets - values that must not appear, in any form.
 * @returns the text with each secret replaced, and no partial key material left.
 */
function stripKnown(text: string, secrets: readonly string[]): string {
  const ordered = secrets
    .filter(secret => typeof secret === 'string' && secret.length > 0)
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of ordered) out = out.split(secret).join(REDACTED)
  return out
}

/**
 * Make text safe to journal, serve or speak.
 *
 * @param text - candidate text; returned unchanged when it is empty or not a string.
 * @param secrets - values the caller knows must not appear. Omit when the caller holds none — the
 * shape rules still apply.
 * @returns the text with every matched secret replaced.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const [shape, replacement] of SHAPES) out = out.replace(shape, replacement)
  return secrets.length === 0 ? out : stripKnown(out, secrets)
}
