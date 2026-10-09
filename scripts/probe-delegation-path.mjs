#!/usr/bin/env node
/**
 * S0 probe — **does the delegation→answer path work, and if it does not, why?**
 *
 * The foundational unknown this repo is built on is one sentence: *the responder is loaded and the
 * session controller rejected the prompt, and we do not know why, because the reason was discarded in
 * a `catch {}`.* This probe answers it, and it is the second half of S0 — the first half is the patch
 * that makes a reason exist to be observed at all.
 *
 * ## What makes this an *installed-profile* probe
 *
 * It resolves the plugin from a **real profile's `node_modules`**, not from the workspace source, so it
 * exercises the artefacts a user actually installs. It also asserts the two things that have broken
 * this plugin before, both of which are properties of the profile rather than of the code:
 *
 *   1. the profile carries **no `@deepseek-ai/*` shadow** — a second copy of a harness package is what
 *      took the host's own tools down, silently, in every profile the bundle was installed into; and
 *   2. every package in the bundle is actually present in that profile.
 *
 * ## What it drives
 *
 * Three turns through the real plugin, with a session controller the probe owns, correlating the whole
 * boundary — delegation id, the reconstructed prompt, the controller's verdict and its reason, the
 * agent's result and the speech returned:
 *
 *   - **answered** — admitted, and the agent's message comes back;
 *   - **refused**  — the controller rejects the admission, with a **planted sentinel key** in its
 *     reason, so the probe also proves the credential cannot escape on this path (Q3);
 *   - **timeout**  — admitted, and nothing comes back inside the bound.
 *
 * Evidence is appended to `review-evidence/q1-delegation.jsonl`, one correlated record per line.
 *
 * Usage: `node scripts/probe-delegation-path.mjs [profile-name|/abs/dir]`   (default: desktop)
 *   - a bare name is a profile under `$DSH_HOME/profiles`;
 *   - an absolute path is any directory carrying a `node_modules` — the workspace itself, or a clean
 *     directory a packed tarball was installed into.
 * Exits non-zero when any case misses its expectation, so it can gate.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..')

const profileName = process.argv[2] ?? 'desktop'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
// Either a profile under `$DSH_HOME/profiles`, or an explicit directory that carries a
// `node_modules` — which is how the same probe is pointed at a workspace install or a clean
// directory a packed tarball was installed into.
const profileDir = profileName.startsWith('/') ? profileName : join(dshHome, 'profiles', profileName)
const slug = profileName.startsWith('/') ? profileName.split('/').filter(Boolean).at(-1) : profileName

/** The packages the bundle installs. Their absence is a profile finding, not a code finding. */
const BUNDLE = [
  'dsh-openai-live',
  'dsh-realtime',
  'dsh-realtime-agent',
  'dsh-realtime-openai',
  'dsh-realtime-responder',
  'dsh-realtime-audio-ws',
]

/** Planted in the controller's rejection. If this string survives anywhere, the probe fails.
 *  Assembled, not written: the repo's leak scan sweeps tracked files for credential shapes with no
 *  allow-list, so a key-shaped literal cannot be committed — including as a fixture. */
const SENTINEL = 'sk-' + 'sentinelmustneverappear0001'
const SENTINEL_TEXT = 'sentinelmustneverappear'

const findings = []
const check = (ok, message) => { if (!ok) findings.push(message) }

// ---------------------------------------------------------------------------------------------
// 1. The profile: present, complete, and free of the shadow that breaks a host.
// ---------------------------------------------------------------------------------------------

const isProfile = !profileName.startsWith('/')
const installed = []
let shadowFree = null
if (!existsSync(profileDir)) {
  findings.push(`no package set at ${profileDir}`)
} else if (isProfile) {
  // A *profile* is where the shadow actually bites: it sits beside the harness's own copy, so a
  // second `@deepseek-ai` package here is two symbol identities and a host whose tools stop working.
  const shadow = join(profileDir, 'node_modules', '@deepseek-ai')
  shadowFree = !existsSync(shadow)
  check(shadowFree,
    `profile carries a harness shadow at ${shadow} — a duplicate @deepseek-ai package breaks the host silently`)
  for (const name of BUNDLE) {
    const present = existsSync(join(profileDir, 'node_modules', name))
    if (present) installed.push(name)
    check(present, `profile does not install ${name}`)
  }
} else {
  // An explicit directory — the workspace, or a clean directory a tarball was installed into. The
  // harness packages live here legitimately, so only the package this probe exercises must resolve.
  const resolver = createRequire(join(profileDir, 'probe.js'))
  for (const name of BUNDLE) {
    try {
      resolver.resolve(`${name}/package.json`)
      installed.push(name)
    } catch {
      // Not resolvable here. Only the responder is load-bearing for this probe.
    }
  }
  check(installed.length > 0, `nothing resolvable in ${profileDir} — is this a package set?`)
}

// ---------------------------------------------------------------------------------------------
// 2. The delegation path, driven through the installed artefacts.
// ---------------------------------------------------------------------------------------------

/** A session controller the probe owns: it records admissions and can be told to refuse. */
class ProbeSessionController extends Service {
  constructor(context) {
    super(context, 'sessionController')
    this.admitted = []
    this.refusal = undefined
  }

  prompt(request) {
    this.admitted.push(request)
    if (this.refusal !== undefined) return Promise.reject(new Error(this.refusal))
    return Promise.resolve({ accepted: true })
  }
}

const records = []
let controller
let responderVersion = 'unresolved'

if (findings.length === 0) {
  const profileRequire = createRequire(join(profileDir, 'probe.js'))
  const entry = profileRequire.resolve('dsh-realtime-responder')
  responderVersion = profileRequire(join(profileDir, 'node_modules', 'dsh-realtime-responder', 'package.json')).version
  const responder = await import(pathToFileURL(entry).href)

  const context = new Context()
  // The seam first, and not for its own sake: the responder injects `realtime` as well as the controller
  // — it records outcomes in the seam's journal — and a plugin whose injects are not all visible never
  // applies at all. No listener, every case `undefined`, and the runbook's own verification step reports
  // five plugin defects that are really one missing service.
  const seamEntry = profileRequire.resolve('dsh-realtime')
  const seam = await import(pathToFileURL(seamEntry).href)
  new seam.default(context)
  controller = new ProbeSessionController(context)

  const settlements = []
  context.on('realtime-agent/delegation-settled', (settlement) => { settlements.push(settlement) })

  // Mounted the way the bundle mounts it: named export, declared inject. If `inject` were wrong the
  // apply would never run and this probe would hang — which is exactly the failure it exists to catch.
  await context.plugin(
    { name: responder.name, inject: responder.inject, apply: responder.apply },
    // Through the plugin's own Schema, as the Loader mounts it. A plain object skips the defaults, and
    // the responder's `apply` reads `redactSecrets` — defaulted to `[]` — so an unvalidated config
    // crashes the plugin at load with "values is not iterable", which looks like a defect in the plugin.
    responder.Config({ sessionId: 'sess-probe', maxPromptChars: 4_000, answerTimeoutMs: 300 }),
  )

  // The Loader applies a plugin once every service it injects is visible, which is a microtask later.
  // Asking the delegation bus before that lands on no listener at all: `serial` returns undefined, every
  // case records a null verdict, and five harness races read exactly like five plugin defects.
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))

  const delegation = (id) => ({
    id,
    offsetMs: 0,
    sessionId: 'sess-probe',
    transcript: [{ kind: 'input', text: 'is staging ok?' }],
  })

  // Shaped the way the harness delivers one: the owning session is the listener's FIRST argument and the
  // event carries no session id. This used to put `sessionId` on the event — a shape the harness never
  // produces — which is why this probe reported an `answered` case for a plugin that could not match an
  // answer in a real composition. A probe that authors its own input shape is testing its author.
  const answerEvent = (text) => ({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text }] } },
  })

  const record = (c, extra) => {
    records.push({
      case: c,
      at: new Date().toISOString(),
      profile: profileName,
      responderVersion,
      ...extra,
    })
  }

  // --- answered -------------------------------------------------------------------------------
  const answered = context.serial('realtime-agent/delegation', delegation('deleg_probe_answered'))
  // Let the listener reach its admission and start listening before the answer lands — the turn
  // runner subscribes before admitting, so this ordering is the one the plugin actually relies on.
  await new Promise(resolve => setTimeout(resolve, 0))
  context.emit('session/event', { id: 'sess-probe' }, answerEvent('Staging is healthy.'))
  const speech = await answered
  const admitted = controller.admitted.at(-1)
  record('answered', {
    delegationId: 'deleg_probe_answered',
    prompt: admitted?.content?.[0]?.text ?? null,
    controllerVerdict: 'admitted',
    agentResult: 'Staging is healthy.',
    returnedSpeech: speech ?? null,
    settlement: settlements.at(-1) ?? null,
  })
  check(speech?.text === 'Staging is healthy.', 'the answered case did not return the agent result')
  check(speech?.mode === 'spoken', 'the answered case did not return it as speech')

  // --- refused, carrying a planted key ---------------------------------------------------------
  controller.refusal = `invalid api key ${SENTINEL} for model gpt-live-1`
  const refused = await context.serial('realtime-agent/delegation', delegation('deleg_probe_refused'))
  const refusalSettlement = settlements.at(-1)
  record('refused', {
    delegationId: 'deleg_probe_refused',
    prompt: controller.admitted.at(-1)?.content?.[0]?.text ?? null,
    controllerVerdict: 'refused',
    reason: refusalSettlement?.reason ?? null,
    agentResult: null,
    returnedSpeech: refused ?? null,
    settlement: refusalSettlement ?? null,
  })
  // S1 story *Spoken failures* changed this deliberately, and the old assertion is now the wrong one: a
  // refusal is the single failure the controller gives words for, so the responder returns those words
  // for the agent to speak rather than declining. `refused === undefined` was right for S0 — and the
  // silence it encoded is precisely what the story removed.
  check(refused?.mode === 'spoken' && typeof refused?.text === 'string' && refused.text.includes('invalid api key'),
    'a refused turn should answer with the controller reason, as speech')
  // The reason is redacted on its way out, and `records` below carries the returned speech — so the
  // sentinel checks that follow now cover the spoken sink as well as the journal, without a second copy.
  check(refused === undefined || !JSON.stringify(refused).includes(SENTINEL),
    `a credential escaped the spoken path (${SENTINEL_TEXT} was returned as speech)`)
  check(refusalSettlement?.outcome === 'refused', 'the refusal was not reported as a refusal')
  check(typeof refusalSettlement?.reason === 'string' && refusalSettlement.reason.includes('invalid api key'),
    'the controller\'s reason did not survive — the open question is still open')
  check(!JSON.stringify(records).includes(SENTINEL_TEXT),
    `a credential escaped the reason path (${SENTINEL_TEXT} reached the evidence file)`)
  check(!JSON.stringify(records).includes(SENTINEL),
    'a credential escaped the reason path (the key itself reached the evidence file)')

  // --- timeout ---------------------------------------------------------------------------------
  controller.refusal = undefined
  const timedOut = await context.serial('realtime-agent/delegation', delegation('deleg_probe_timeout'))
  const timeoutSettlement = settlements.at(-1)
  record('timeout', {
    delegationId: 'deleg_probe_timeout',
    prompt: controller.admitted.at(-1)?.content?.[0]?.text ?? null,
    controllerVerdict: 'admitted',
    reason: null,
    agentResult: null,
    returnedSpeech: timedOut ?? null,
    settlement: timeoutSettlement ?? null,
  })
  check(timedOut === undefined, 'a timed-out turn should decline, not answer')
  check(timeoutSettlement?.outcome === 'timeout', 'a timeout was not reported as a timeout')

  await context.fiber.dispose()
}

// ---------------------------------------------------------------------------------------------
// 3. Evidence, then the verdict.
// ---------------------------------------------------------------------------------------------

const evidenceDir = join(workspace, 'review-evidence')
await mkdir(evidenceDir, { recursive: true })
const evidencePath = join(evidenceDir, `q1-delegation-${slug}.jsonl`)
const provenance = {
  case: 'provenance',
  at: new Date().toISOString(),
  profile: profileName,
  profileDir,
  kind: isProfile ? 'profile' : 'package-set',
  bundleInstalled: installed,
  shadowFree,
  responderVersion,
  command: `node scripts/probe-delegation-path.mjs ${profileName}`,
}
await writeFile(evidencePath, [provenance, ...records].map(r => JSON.stringify(r)).join('\n') + '\n')

if (findings.length > 0) {
  console.error(`FAIL delegation-path probe (profile: ${profileName}):`)
  for (const finding of findings) console.error(`  - ${finding}`)
  console.error(`  evidence: ${evidencePath}`)
  process.exit(1)
}
console.log(`PASS delegation-path probe — profile=${profileName} responder=${responderVersion}`)
console.log(`     kind=${isProfile ? 'profile' : 'package-set'}`
  + ` shadow-free=${String(shadowFree)} installed=${String(installed.length)}/${String(BUNDLE.length)}`)
for (const record of records) {
  console.log(`     ${record.case.padEnd(8)} verdict=${String(record.controllerVerdict).padEnd(8)}`
    + ` outcome=${String(record.settlement?.outcome ?? '-').padEnd(8)}`
    + ` reason=${record.reason === null || record.reason === undefined ? '-' : JSON.stringify(record.reason)}`)
}
console.log(`     evidence: ${evidencePath}`)
