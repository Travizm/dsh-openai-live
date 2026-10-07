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
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..')
const fixture = join(workspace, 'packages', 'realtime-replay', 'tests', 'fixtures', 'mini-session.jsonl')

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
  '',
].join('\n'))

const context = new Context()
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

await context.fiber.dispose()
await rm(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('FAIL built composition smoke (plain node, built lib):')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`PASS built composition smoke — plain node, built lib: provider=${providers.join(',')}`
  + ` model=${started?.model ?? '?'} voice=${started?.voice ?? '?'}`)
