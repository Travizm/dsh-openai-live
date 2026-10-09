/**
 * The redaction sweep: one planted key of each kind, every sink, zero leakage.
 *
 * S1 story 5, and Q3's whole mandate. Three surfaces were introduced for diagnostics — a journal, an
 * HTTP route and spoken failures — and each is a new place a provider key or the route's capability
 * token could escape into. A disclosure outlives the debugging session that introduced it, so review
 * does not scale to this; a test that fails on a planted string does.
 *
 * This is a **composition** test and it lives with the bundle rather than with any one package, because
 * no single package owns every sink. The responder knows the reason, the seam keeps the journal, the
 * audio package serves it, and the failure only exists in the space between them.
 *
 * Two keys are planted, because the two kinds of secret cannot be caught the same way:
 *
 * - **Shape.** A vendor-prefixed key matches a pattern anywhere, with no configuration at all.
 * - **Value.** The route's capability token is 32 random bytes of base64url — no prefix, no padding, no
 *   structure — so no rule can find it and only a caller that holds it can name it. That is the arm a
 *   profile supplies through `redactSecrets`.
 *
 * Both are derived at runtime, never written. A credential-shaped literal in source is what the repo's
 * own leak scan denies by construction and what gitleaks fails on by entropy — and that is the fourth
 * arm of this story: the packaged artefact. `pnpm leakscan` and `scripts/inspect-package-tarballs.sh`
 * are the gate for it, and they hold only because nothing in this file is a literal to find.
 *
 * @module dsh-openai-live/tests/redaction-sweep
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { DelegationRequest } from 'dsh-realtime-agent'
import RealtimeRuntime, { REDACTED } from 'dsh-realtime'
import { Config as ResponderConfig, apply as applyResponder } from 'dsh-realtime-responder'
import { diagnosticsRoute } from 'dsh-realtime-audio-ws'
import type { RealtimeResponderConfig } from 'dsh-realtime-responder'

/** A vendor-shaped key: caught by pattern, wherever it appears and whatever names it. Assembled. */
const SHAPED = ['sk', 'sweep', 'shaped'.padEnd(24, '0')].join('-')

/** A secret with no structure at all. Derived, so no scanner has a literal to find. */
const UNSHAPED = Buffer.from(Uint8Array.from({ length: 32 }, (_unused, index) => (index * 13 + 7) % 256)).toString('base64url')

/** What a profile would name in `redactSecrets`, and the reason the value arm can work at all. */
const PLANTED = [SHAPED, UNSHAPED]

/** The controller's own words, carrying both keys the way a provider error realistically would. */
const REASON = `invalid api key ${SHAPED} (${UNSHAPED}) for model gpt-live-1`

const request = {
  id: 'item_sweep',
  offsetMs: 0,
  sessionId: 'sess-sweep',
  transcript: [{ kind: 'input', text: 'is staging ok?' }],
} as unknown as DelegationRequest

/** A controller that refuses every admission with an error carrying the planted keys. */
class RefusingController extends Service {
  constructor(context: Context) { super(context, 'sessionController') }
  prompt(): Promise<{ accepted: true }> {
    return Promise.reject(new Error(REASON))
  }
}

/**
 * Drive one delegation through every sink and return what each of them ended up holding.
 *
 * The sinks are read exactly as a consumer would read them: the spoken text as the responder returns it
 * to the agent, the journal as its own snapshot, and the route by invoking the very handler the web
 * server invokes — including the response body, because a status-only assertion would pass while the
 * record leaked.
 */
async function driveThroughEverySink(): Promise<{
  spoken: string
  journalled: string
  served: string
}> {
  const context = new Context()
  // Both constructed for their side effect: each service registers itself on the context, which is how
  // the responder finds the two it injects.
  new RefusingController(context)
  const seam = new RealtimeRuntime(context)

  applyResponder(context, ResponderConfig({
    sessionId: 'sess-sweep',
    answerTimeoutMs: 1_000,
    redactSecrets: PLANTED,
  }) as RealtimeResponderConfig)

  const answer = await context.serial('realtime-agent/delegation', request) as { readonly text: string }

  const route = diagnosticsRoute({
    path: '/dsh-realtime/diagnostics',
    token: 'token-that-is-never-presented-here',
    rejectionFor: () => undefined,
    journal: seam.journal,
  })
  const written: { body?: string } = {}
  route.handler(
    { url: '/dsh-realtime/diagnostics', headers: {} } as never,
    { writeHead: () => undefined, end: (body?: string) => { written.body = body ?? '' } } as never,
  )

  await context.fiber.dispose()
  return {
    spoken: answer.text,
    journalled: JSON.stringify(seam.journal.snapshot()),
    served: String(written.body),
  }
}

describe('the redaction sweep', () => {
  it('leaks neither planted key through any of the three sinks', async () => {
    const sinks = await driveThroughEverySink()

    for (const [name, contents] of Object.entries(sinks)) {
      for (const planted of PLANTED) {
        // Named, so a failure says which sink leaked rather than only that one did.
        expect(contents, `sink "${name}" leaked a planted key`).not.toContain(planted)
      }
      expect(contents, `sink "${name}" did not record that it redacted`).toContain(REDACTED)
    }
  })

  it('keeps the diagnosis, because redaction that costs the reason is a second failure', async () => {
    const { spoken, journalled, served } = await driveThroughEverySink()

    // Every sink carries the useful part. A sweep that only proved absence would pass on a sink that
    // had simply swallowed the whole message — which is the failure this layer was built to end.
    for (const contents of [spoken, journalled, served]) {
      expect(contents).toContain('invalid api key')
      expect(contents).toContain('gpt-live-1')
    }
  })

  it('redacts the shaped key with no configuration at all, and the unshaped one only when named', async () => {
    // The two arms are not equally strong, and the sweep says so rather than implying otherwise. This
    // is the honest statement of the boundary: a prefixed key is caught by the primitive, a prefixless
    // one is caught only because a profile named it.
    const context = new Context()
    new RefusingController(context)
    // Constructed, not held: the service registers itself on the context, and this test reads no journal.
    new RealtimeRuntime(context)
    applyResponder(context, ResponderConfig({
      sessionId: 'sess-sweep',
      answerTimeoutMs: 1_000,
      // Deliberately empty: the profile named nothing, so the value arm cannot apply.
      redactSecrets: [],
    }) as RealtimeResponderConfig)

    const answer = await context.serial('realtime-agent/delegation', request) as { readonly text: string }
    await context.fiber.dispose()

    expect(answer.text).not.toContain(SHAPED)
    expect(answer.text).toContain(REDACTED)
    // Unnamed and unstructured: nothing can find it, which is why the profile has to say it.
    expect(answer.text).toContain(UNSHAPED)
  })
})
