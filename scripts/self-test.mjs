#!/usr/bin/env node
/**
 * The self-test: five checks and one verdict, in output worth pasting into a bug report.
 *
 * `probe:delegation` answers "does the delegation path work"; this answers "is voice working, and if
 * not, which of the five things is wrong". They are deliberately separate, because the second is what
 * somebody runs *before* a demo or a bug report, and the first is what somebody runs when a delegation
 * has already misbehaved.
 *
 * The five:
 *
 * 1. **key** — the credential is configured where the host will look for it. Not "the key is valid":
 *    nothing offline can tell you that, and a check that claimed to would be the diagnostics lying.
 *    What it can tell you is whether anything is configured at all, which is the failure that looks
 *    like every other failure from the outside.
 * 2. **route** — the audio route accepts an authorised client, and the same policy refuses an
 *    unauthorised one. Both halves, because a route that accepts everybody is not "accepting".
 * 3. **session** — the agent opens a session and the seam has it.
 * 4. **prompt** — a delegation reaches a controller and is admitted.
 * 5. **turn** — the answer comes back and the provider acknowledges the append.
 *
 * Checks 3-5 run against harness substitutes for the two things a script outside the app cannot
 * provide — a session controller and a provider — and against the **installed** seam, agent, responder
 * and audio route. That is the honest boundary: this proves the stack works and the profile is
 * wireable, not that a vendor's server is up.
 *
 * Usage: `pnpm self-test [profile | /path/to/package-set]` — `desktop` by default.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import WebSocket from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..')

const profileName = process.argv[2] ?? 'desktop'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
// Either a profile under `$DSH_HOME/profiles`, or an explicit directory carrying a `node_modules`.
const profileDir = profileName.startsWith('/') ? profileName : join(dshHome, 'profiles', profileName)
const isProfile = !profileName.startsWith('/')

/** The credential's name, as the bundle's patch passes it through. */
const CREDENTIAL = 'OPENAI_LIVE_API_KEY'

/**
 * The query parameter carrying the capability token.
 *
 * Restated rather than imported: the route publishes it as of this sprint, but the *installed* copy in
 * a profile predates that until the release lands. A drift here fails the route check loudly, which is
 * the correct way for a duplicated constant to behave.
 */
const TOKEN_PARAM = 't'

/** One check's result. `warning` means "could not be exercised", which is not the same as a failure. */
const results = []
const pass = (name, detail) => { results.push({ name, ok: true, detail }) }
const fail = (name, detail) => { results.push({ name, ok: false, detail }) }
const warn = (name, detail) => { results.push({ name, warning: true, detail }) }
const problem = () => results.some(result => result.ok === false)

// ---------------------------------------------------------------------------------------------
// 1. The key: is anything configured for the host to find?
// ---------------------------------------------------------------------------------------------

const fromEnv = (process.env[CREDENTIAL] ?? '').trim().length > 0
let fromPatch = false
const patchPath = join(profileDir, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  try {
    fromPatch = (await readFile(patchPath, 'utf8')).includes(CREDENTIAL)
  } catch {
    fromPatch = false
  }
}

if (fromEnv || fromPatch) {
  const where = [fromEnv ? 'environment' : undefined, fromPatch ? 'cordis.patch.yml' : undefined]
    .filter(Boolean)
    .join(' + ')
  pass('key', `configured in the ${where}; entitlement itself is only provable by a live session`)
} else {
  // Not a failure of the stack, and not a pass either. It is the single most common reason a voice
  // session does nothing, and the verdict has to say so rather than reporting a clean run.
  warn('key', `no ${CREDENTIAL} in the environment and none referenced by ${patchPath}`)
}

// ---------------------------------------------------------------------------------------------
// 2. Mount the installed artefacts, then check the route, the session, the prompt and the turn.
// ---------------------------------------------------------------------------------------------

/** A session controller the self-test owns: it records admissions. */
class SelfTestController extends Service {
  constructor(context) {
    super(context, 'sessionController')
    this.admitted = []
  }

  prompt(request) {
    this.admitted.push(request)
    return Promise.resolve({ accepted: true })
  }
}

/** The web server, with the two registration doors the audio route uses. */
class SelfTestWebServer extends Service {
  constructor(context) {
    super(context, 'webServer')
    this.upgrades = new Map()
    this.routes = new Map()
    this.config = { port: 19387, host: '127.0.0.1' }
  }

  registerUpgrade(route) {
    this.upgrades.set(route.path, route.handler)
    return () => { this.upgrades.delete(route.path) }
  }

  register(route) {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

/** The connection service, whose verdict door the audio route consults. */
class SelfTestConnection extends Service {
  constructor(context) {
    super(context, 'connection')
    this.rejection = undefined
  }

  requestRejection() { return this.rejection }
}

/** The tools service, with just enough shape for the agent to register its voice tools against. */
class SelfTestTools extends Service {
  constructor(context) {
    super(context, 'tools')
    this.registered = []
  }

  register(definition) {
    this.registered.push(definition.name)
    return () => undefined
  }
}

/**
 * A provider that opens on demand and acknowledges appends. Not a vendor: a stand-in for one.
 *
 * Built from the installed base class rather than declared with `class … extends`, because the base is
 * only known once the profile's copy has been resolved — and it carries the adapter contract the seam
 * checks for, which a plain object does not.
 * @param adapterBase - `RealtimeAdapter`, from the installed seam.
 * @returns one provider instance.
 */
const makeProvider = adapterBase => new (class extends adapterBase {
  constructor() {
    super()
    this.handlers = undefined
    this.appends = []
    this.opened = 0
  }

  session(options) {
    this.handlers = options.handlers
    this.opened += 1
    const provider = this
    return Promise.resolve({
      id: 'sess-self-test',
      started: {
        provider: 'self-test',
        model: 'self-test',
        inputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
        outputAudio: { sampleRate: 24_000, channels: 1, encoding: 'pcm16' },
      },
      sendAudio() {},
      muteInput() {},
      unmuteInput() {},
      appendCommentary(text, delegationId) {
        provider.appends.push({ kind: 'commentary', text, delegationId })
        return Promise.resolve()
      },
      appendThinking(text, delegationId) {
        provider.appends.push({ kind: 'thinking', text, delegationId })
        return Promise.resolve()
      },
      appendInstructions: () => Promise.resolve(),
      close: () => Promise.resolve(),
    })
  }
})()

const installed = []
if (!existsSync(profileDir)) {
  fail('installed', `no package set at ${profileDir}`)
} else {
  const require_ = createRequire(join(profileDir, 'self-test.cjs'))
  const load = async (name) => {
    try {
      const entry = require_.resolve(name)
      installed.push(`${name}@${require_(join(dirname(entry), '..', 'package.json')).version ?? '?'}`)
      return await import(pathToFileURL(entry).href)
    } catch (error) {
      fail('installed', `${name} did not resolve in ${profileDir}: ${String(error)}`)
      return undefined
    }
  }

  const seamModule = await load('dsh-realtime')
  const agentModule = await load('dsh-realtime-agent')
  const responderModule = await load('dsh-realtime-responder')
  const audioModule = await load('dsh-realtime-audio-ws')

  if (seamModule !== undefined && agentModule !== undefined && responderModule !== undefined && audioModule !== undefined) {
    const context = new Context()
    new seamModule.default(context)
    const controller = new SelfTestController(context)
    new SelfTestTools(context)
    const web = new SelfTestWebServer(context)
    const connection = new SelfTestConnection(context)
    const provider = makeProvider(seamModule.RealtimeAdapter)
    context.realtime.registerAdapter(['self-test'], provider)

    await context.plugin(
      { name: agentModule.name, inject: agentModule.inject, apply: agentModule.apply },
      // Each plugin is mounted through its own Schema, as the Loader does. Mounting with a plain object
      // silently skips the defaults — and a plugin whose `apply` reads a defaulted field crashes on an
      // undefined it was entitled to expect, which is a load-time failure the harness caused itself.
      agentModule.Config({ provider: 'self-test', model: 'self-test' }),
    )
    await context.plugin(
      { name: responderModule.name, inject: responderModule.inject, apply: responderModule.apply },
      responderModule.Config({ sessionId: 'sess-self-test', maxPromptChars: 4_000, answerTimeoutMs: 1_000 }),
    )
    // The audio route declares no `inject` — it is mounted by calling its `apply` with its own validated
    // config, which is what the bundle's composition smoke does. Registering it through `context.plugin`
    // with an undefined inject would mount nothing, and every check below would then fail for a reason
    // that has nothing to do with voice.
    audioModule.apply(context, audioModule.Config({}))

    // The agent reports a session it could not open on the bus rather than throwing into a handler, so
    // the self-test listens. "No session" without a reason is the report this script exists to replace.
    const sessionErrors = []
    context.on('realtime-agent/error', (error) => { sessionErrors.push(error) })

    // The page's settings row, emitted exactly as the host emits it: the token exists nowhere else, so
    // reading it out of the row is the same thing the client half does.
    const table = []
    context.emit('webserver/index-inject', table)
    const token = table[0]?.value?.token

    // The journal is a this-sprint addition. A profile installed before it has none — and a self-test
    // that threw here would report a crash instead of the version skew that is the actual answer.
    const journal = context.realtime.journal
    const kinds = () => (journal === undefined ? [] : journal.snapshot().map(entry => entry.kind))
    if (journal === undefined) {
      warn('journal', "the installed seam records no journal — it lands with this sprint's release")
    }

    // --- the route, both halves -----------------------------------------------------------------
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      const handler = web.upgrades.get(new URL(request.url ?? '/', 'http://x').pathname)
      if (handler === undefined) {
        socket.destroy()
        return
      }
      void handler(request, socket, head)
    })
    server.on('request', (request, response) => {
      const handler = web.routes.get(new URL(request.url ?? '/', 'http://x').pathname)
      if (handler === undefined) {
        response.writeHead(404)
        response.end()
        return
      }
      void handler(request, response)
    })
    await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    const audioPath = [...web.upgrades.keys()][0]
    const diagnosticsPath = [...web.routes.keys()][0]

    // Kept open rather than closed at once: connecting is what opens the session, and a client that hung
    // up here would end it again before the session check could look. It is terminated below.
    let audioClient
    const opened = await new Promise((resolve) => {
      audioClient = new WebSocket(`ws://127.0.0.1:${port}${audioPath}?${TOKEN_PARAM}=${token}`)
      audioClient.on('open', () => { resolve(true) })
      audioClient.on('error', () => { resolve(false) })
      setTimeout(() => { resolve(false) }, 3_000)
    })

    if (diagnosticsPath === undefined) {
      // The refusing door is a this-sprint addition. Until the release is installed there is only the
      // accepting half to check, and saying so is the difference between a verdict and a failure.
      if (opened) warn('route', `accepted an authorised socket on ${audioPath}; no diagnostics door to refuse at yet`)
      else fail('route', `the authorised socket did not open on ${audioPath}`)
    } else {
      // The route's policy is the connection service's verdict, overridden by a valid token — so an
      // *unauthorised* caller is one the connection objects to, not merely one carrying no token. With no
      // rejection set the route accepts, correctly, and reading that as a leak would be wrong about the
      // harness rather than right about the route.
      connection.rejection = 401
      const unauthorised = await fetch(`http://127.0.0.1:${port}${diagnosticsPath}`)
      connection.rejection = undefined
      if (opened && (unauthorised.status === 401 || unauthorised.status === 403)) {
        pass('route', `accepted an authorised socket on ${audioPath}; refused ${String(unauthorised.status)} without a token`)
      } else {
        fail('route', `authorised socket opened=${String(opened)}; unauthorised status=${String(unauthorised.status)}`)
      }
    }

    // --- the session ----------------------------------------------------------------------------
    context.emit('realtime-agent/start')
    let live = false
    for (let attempt = 0; attempt < 40 && !live; attempt += 1) {
      // The provider's own count is the half of this that survives a seam with no journal: a session
      // that opened is a session that opened, whether or not anybody wrote it down.
      live = provider.opened > 0 && (journal === undefined || kinds().includes('session.opened'))
      if (!live) await new Promise(resolve => { setTimeout(resolve, 25) })
    }
    if (live) pass('session', `opened ${String(provider.opened)} session(s) as sess-self-test`)
    else {
      const why = sessionErrors.length > 0 ? `: ${String(sessionErrors.at(-1))}` : ''
      fail('session', `no session after start; journal: ${kinds().join(' > ') || '(none)'}${why}`)
    }

    // --- the prompt and the turn -----------------------------------------------------------------
    const delegation = { id: 'deleg_self_test', offsetMs: 0, sessionId: 'sess-self-test', transcript: [{ kind: 'input', text: 'is staging ok?' }] }
    const answered = context.serial('realtime-agent/delegation', delegation)
    // The turn runner subscribes before admitting, and this ordering is the one it relies on.
    await new Promise(resolve => setTimeout(resolve, 0))
    provider.handlers?.onTranscript?.({ kind: 'input', text: 'is staging ok?', final: true })
    provider.handlers?.onDelegation?.(delegation)
    await new Promise(resolve => setTimeout(resolve, 25))
    context.emit('session/event', { id: 'sess-self-test' }, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'Staging is healthy.' }] } },
    })

    if (controller.admitted.length > 0) pass('prompt', `controller admitted ${String(controller.admitted.length)} turn(s)`)
    else fail('prompt', 'no turn reached the controller — a session with nothing to admit into')

    const speech = await answered
    // The append is the agent's own async chain, one hop behind the responder's return — so poll for the
    // entry rather than reading the journal the instant the answer resolves. That gap is the difference
    // between a check and a race, and a race here reads as "the agent never acknowledged anything".
    let acknowledged = kinds().includes('append.acknowledged')
    for (let attempt = 0; attempt < 40 && !acknowledged; attempt += 1) {
      await new Promise(resolve => { setTimeout(resolve, 25) })
      acknowledged = kinds().includes('append.acknowledged')
    }
    if (speech?.text !== 'Staging is healthy.') {
      fail('turn', `returned ${JSON.stringify(speech ?? null)} instead of the canned answer`)
    } else if (journal === undefined) {
      warn('turn', `returned ${JSON.stringify(speech.text)} as ${String(speech.mode)}; no journal, so no acknowledgement to check`)
    } else if (acknowledged) {
      pass('turn', `returned ${JSON.stringify(speech.text)} as ${String(speech.mode)}; append acknowledged`)
    } else {
      fail('turn', `returned the canned answer but no append was acknowledged; journal: ${kinds().join(' > ') || '(empty)'}`)
    }

    audioClient?.terminate()
    await new Promise(resolve => { server.close(() => { resolve() }) })

    // --- evidence -------------------------------------------------------------------------------
    const evidenceDir = join(workspace, 'review-evidence')
    await mkdir(evidenceDir, { recursive: true })
    const evidencePath = join(evidenceDir, `self-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(evidencePath, `${JSON.stringify({
      at: new Date().toISOString(),
      profile: profileName,
      installed,
      node: process.version,
      results,
    }, null, 2)}\n`)

    // --- the verdict ----------------------------------------------------------------------------
    const failed = results.filter(result => result.ok === false)
    const warned = results.filter(result => result.warning === true)
    const verdict = failed.length > 0 ? 'FAIL' : warned.length > 0 ? 'PARTIAL' : 'PASS'

    console.log(`SELF-TEST dsh-openai-live — profile=${profileName} verdict=${verdict}`)
    for (const result of results) {
      const mark = result.ok === false ? 'FAIL' : result.warning === true ? 'WARN' : 'ok  '
      console.log(`  ${mark}  ${result.name.padEnd(8)} ${result.detail}`)
    }
    console.log(`  env       node=${process.version} bundle=${installed.join(' ')}`)
    console.log(`  evidence  ${evidencePath}`)
    // An explicit exit rather than a fall-through: a socket or a timer still alive would hold the process
    // up after its verdict, and a self-test that prints PASS and then hangs reads as a broken tool.
    process.exit(failed.length > 0 ? 1 : 0)
  }
}
