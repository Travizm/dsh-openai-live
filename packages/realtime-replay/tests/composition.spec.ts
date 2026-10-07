import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import RealtimeRuntime from 'dsh-realtime'
import * as replay from '../src/index.ts'

/**
 * The **real-composition test** the harness requires of a product-visible plugin.
 *
 * Hand-built `ctx.plugin(...)` suites are explicitly insufficient: they prove the plugin works when a
 * test wires it, not when the Loader does. This boots a test-only `cordis.yml` through the real
 * Loader and app, so service dependencies are resolved by the composition, and asserts on what a
 * consumer would actually see.
 *
 * The composition is the seam plus the replay backend rather than the live adapter, because the live
 * adapter requires a provider — and a test that needs a provider cannot run on a fork or a
 * contributor's machine. Replay exists precisely so this tier is reachable keylessly.
 */
let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot a composition from YAML lines through the real Loader. */
async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-realtime-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  // Module resolution is supplied from this map rather than from node_modules, which keeps the
  // composition hermetic in the test plane: the YAML names plugins the way the Loader does, and a
  // stale build cannot make this pass.
  const modules = new Map<string, unknown>([
    ['dsh-realtime', RealtimeRuntime],
    ['dsh-realtime-replay', replay],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Let the replay transport's scheduled delivery run. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const FIXTURE = new URL('./fixtures/mini-session.jsonl', import.meta.url).pathname

const composition = (extra: readonly string[] = []): string[] => [
  "- name: 'dsh-realtime'",
  "- name: 'dsh-realtime-replay'",
  '  config:',
  `    fixture: "${FIXTURE}"`,
  ...extra,
]

describe('real Loader composition', () => {
  it('composes the seam with the replay plugin and replays a conversation', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml(composition())

    // An entry with no fiber is a plugin that failed to resolve or threw in `apply`. The harness's own
    // real-composition specs assert this, because a silently absent plugin is the failure mode this
    // tier exists to catch.
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    expect(loaded.realtime).toBeInstanceOf(RealtimeRuntime)
    expect(loaded.realtime.listProviders().map(provider => provider.id)).toEqual(['replay'])

    // Drive the composed service — not one a test hand-built.
    const transcripts: string[] = []
    const delegations: Array<{ id: string; target: string }> = []
    const session = await loaded.realtime.session({
      provider: 'replay',
      model: 'gpt-live-1',
      handlers: {
        onTranscript: transcript => transcripts.push(transcript.text),
        onDelegation: delegation => delegations.push({ id: delegation.id, target: delegation.target }),
      },
    })
    await tick()
    await tick()

    expect(session.started).toMatchObject({ provider: 'replay', model: 'gpt-live-1', voice: 'marin' })
    expect(transcripts.join('')).toContain('check staging')
    expect(delegations.map(delegation => delegation.target)).toEqual(['client'])
    await session.close()
  })

  it('takes the provider route from configuration rather than a hardcoded name', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      "- name: 'dsh-realtime'",
      "- name: 'dsh-realtime-replay'",
      '  config:',
      '    provider: replay-staging',
      `    fixture: "${FIXTURE}"`,
    ])
    expect(loaded.realtime.listProviders().map(provider => provider.id)).toEqual(['replay-staging'])
  })

  it('refuses to bring up a route when the recording cannot be read', { timeout: 60_000 }, async () => {
    // A plugin whose `apply` throws must not leave a working route behind. Cordis may propagate the
    // throw or record the failed entry and continue, depending on where the failure lands — so the
    // property under test is the outcome, not the mechanism: a route that only fails at first use is
    // the failure. (`rejects.toThrow` is also avoided: Cordis wraps a plugin-apply failure in its own
    // diagnostic, and vitest's pretty-printer cannot serialise that wrapper.)
    let threw = false
    let providers: string[] = []
    try {
      const loaded = await loadYaml([
        "- name: 'dsh-realtime'",
        "- name: 'dsh-realtime-replay'",
        '  config:',
        '    fixture: "/nonexistent/session.jsonl"',
      ])
      providers = loaded.realtime.listProviders().map(provider => provider.id)
    } catch {
      threw = true
    }
    expect(threw ? [] : providers).toEqual([])
  })

  it('leaves no route behind when the composition is torn down', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml(composition())
    const service = loaded.realtime
    expect(service.listProviders()).toHaveLength(1)
    await loaded.fiber.dispose()
    context = undefined
    expect(service.listProviders()).toEqual([])
  })
})
