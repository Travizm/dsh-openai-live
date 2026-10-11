#!/usr/bin/env node
/**
 * Built-artifact composition smoke — runs under **plain node**, no tsx.
 *
 * This is the harness's "real entry path" tier: a package's built `lib/` exercised by `node` itself,
 * booting a real `cordis.yml` through the real Loader with real module resolution. tsx and vitest both
 * mask failures this catches — module-resolution mistakes, ESM/CJS interop, settle races, and a plugin
 * that loads but contributes nothing.
 *
 * Unlike the in-suite composition test, module specifiers here are **not** stubbed: `dsh-realtime` and
 * `dsh-realtime-replay` resolve through node_modules to their built `lib/index.js`, which is what a
 * user installs. Run `pnpm build` first.
 *
 * Exits non-zero on any mismatch, so CI can gate on it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..')
const fixture = join(workspace, 'packages', 'realtime-replay', 'tests', 'fixtures', 'mini-session.jsonl')

/**
 * The tools service, which the harness supplies in the app.
 *
 * Mounted here because the agent publishes `voice_journal` on it, and a tool that cannot be *called* on the
 * built artifact is a claim rather than a surface: the unit suite supplies its own journal and its own
 * service, so nothing there proves the pair the app actually assembles.
 */
class Tools extends Service {
  registered = []

  constructor(context) {
    super(context, 'tools')
  }

  register(definition) {
    this.registered.push(definition)
    return () => {}
  }
}

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-realtime-built-'))
const configPath = join(scratch, 'cordis.yml')
await writeFile(configPath, [
  "- name: 'dsh-realtime'",
  "- name: 'dsh-realtime-replay'",
  '  config:',
  `    fixture: "${fixture}"`,
  "- name: 'dsh-realtime-agent'",
  '  config:',
  "    provider: 'replay'",
  // Not `autoStart`: the session is opened through the product's own `voice_start`, so what this exercises
  // is the path a model takes rather than a boot-time race against the adapter's registration.
  '    autoStart: false',
  '',
].join('\n'))

const context = new Context()
// Before the Loader runs, so the service the agent injects is there when its row is applied.
const tools = new Tools(context)
context.baseUrl = pathToFileURL(here).href + '/'
await context.plugin(Loader)
context.loader.builtins.include = Include
await context.loader.create({
  name: 'cordis:include',
  config: { path: pathToFileURL(configPath).href },
})
await context.loader.await()

// An entry with no fiber resolved to nothing or threw in `apply`.
const unloaded = [...context.loader.entries()]
  .filter(entry => entry.fiber === undefined && !entry.disabled)
  .map(entry => entry.options.name)
check(unloaded.length === 0, `entries did not mount: ${unloaded.join(', ')}`)

check(context.realtime !== undefined, 'the realtime service is not on the context')
const providers = context.realtime === undefined
  ? []
  : context.realtime.listProviders().map(provider => provider.id)
check(providers.join(',') === 'replay', `expected the replay route, got [${providers.join(', ')}]`)


let started
if (context.realtime !== undefined) {
  const transcripts = []
  const session = await context.realtime.session({
    provider: 'replay',
    model: 'gpt-live-1',
    handlers: { onTranscript: transcript => transcripts.push(transcript.text) },
  })
  // The replay transport delivers on a macrotask, so let it play before asserting.
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
  started = session.started
  check(started.model === 'gpt-live-1', `the session reported model ${started.model}`)
  check(started.provider === 'replay', `the session reported provider ${started.provider}`)
  check(transcripts.join('').includes('check staging'), 'the recorded transcript never arrived')
  await session.close()
}

// The agent's own tools, published on the built artifact and *called* on it — the tier this file exists
// for. No session is opened here on purpose: the replay transport plays one fixture per process, so a
// session opened for the tool would consume it and the transport assertions below would hang instead.
// What this proves is the surface a model gets; what needs a live session is asserted in the package's own
// suite, where a fake adapter can serve as many as it likes.
const published = tools.registered.map(definition => definition.name)
check(published.includes('voice_journal'), `voice_journal was not published: [${published.join(', ')}]`)

const journalTool = tools.registered.find(definition => definition.name === 'voice_journal')
if (journalTool === undefined) {
  check(false, 'voice_journal is not on the tools service, so it could not be called')
} else {
  const answer = await journalTool.execute({}, {})
  const kinds = answer.entries.map(entry => entry.kind)
  // The record the *plugin* wrote, reached through the tool: `config.resolved` is this boot's own entry.
  check(kinds.includes('config.resolved'), `the tool did not read the plugin's record: [${kinds.join(', ')}]`)
  // The filter, on a real record: the playout frames are one entry per frame, reported as a count.
  check(!kinds.includes('speech.sent'), `the default answer carried per-frame audio entries: [${kinds.join(', ')}]`)
  const seqs = answer.entries.map(entry => entry.seq)
  check(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]), `entries were not oldest-first: [${seqs.join(', ')}]`)
  check(Number.isInteger(answer.skippedFrames) && answer.skippedFrames >= 0, 'skippedFrames is not a count')
  check(answer.entries.every(entry => typeof entry.kind === 'string' && typeof entry.at === 'number'),
    'an entry did not carry a kind and a time')
}

await context.fiber.dispose()
await rm(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('FAIL built composition smoke (plain node, built lib):')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`PASS built composition smoke — plain node, built lib: provider=${providers.join(',')}`
  + ` model=${started?.model ?? '?'} voice=${started?.voice ?? '?'}`)
