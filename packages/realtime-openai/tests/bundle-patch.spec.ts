import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { parse } from 'yaml'
import RealtimeRuntime from 'dsh-realtime'
import * as realtimeAgent from 'dsh-realtime-agent'
import { Config as AgentConfig } from 'dsh-realtime-agent'
import * as openaiLive from '../src/index.ts'
import { Config } from '../src/index.ts'

/**
 * The **shipped** bundle patch, tested.
 *
 * Until this existed, `cordis.patch.yml` was untested text: it is what a user's profile actually
 * mounts, and a mistake in it would surface on that user's machine rather than here. Two failure modes
 * motivated it, and only one of them is loud:
 *
 *   - a row named wrongly, or a config key the schema does not declare. This one is **silent**:
 *     schemastery keeps unknown keys, so a typo'd field is not rejected — it is simply ignored, for
 *     ever, and the plugin runs at its defaults.
 *   - a missing credential breaking the boot. This one is not silent, and it must not happen.
 *
 * So the patch is read, parsed, checked against the real schema, and then **booted through the real
 * Loader** with the credential absent.
 */
interface PatchRow {
  id: string
  name: string
  config?: Record<string, unknown>
}

const here = dirname(fileURLToPath(import.meta.url))
const PATCH_PATH = join(here, '..', '..', '..', 'cordis.patch.yml')

/**
 * A marker substituted for the `!!js` tag before parsing, so an expression can still be told apart
 * from a literal string afterwards. Without it the test cannot distinguish `process.env.X` from the
 * literal `"openai-live"`, and would try to evaluate both.
 */
const JS_EXPR_PREFIX = '__js_expr__'

/**
 * Read the patch's `insert` rows.
 *
 * The `!!js` tag is replaced with a marker before parsing, deliberately. It is DSH's own config-layer
 * tag, not YAML: `@deepseek-ai/cordis-plugin-include` resolves it to an expression node which the
 * Loader evaluates when the row activates — and only inside a plugin's `config`, a trap DSH carries a
 * postmortem about. A plain YAML parser has no such tag, and hand-rolling one here would test my tag
 * implementation rather than the patch. The row *shape* is what this file is about, and `evaluate()`
 * models the one expression shape the patch uses.
 */
function rows(): PatchRow[] {
  const text = readFileSync(PATCH_PATH, 'utf8').replace(/!!js\s+/g, JS_EXPR_PREFIX)
  const document = parse(text) as Array<{ insert?: PatchRow[] }>
  expect(document).toHaveLength(1)
  return document[0]?.insert ?? []
}

/**
 * Evaluate a config value the way the Loader would.
 *
 * Supports only the single shape the patch actually uses, and throws on anything else rather than
 * guessing — an unrecognised expression silently becoming a literal string is exactly the class of bug
 * this file exists to prevent.
 */
function evaluate(value: unknown): unknown {
  // A value without the marker is a literal and is passed through untouched — which is the whole
  // reason the marker exists rather than a bare strip.
  if (typeof value !== 'string' || !value.startsWith(JS_EXPR_PREFIX)) return value
  const source = value.slice(JS_EXPR_PREFIX.length)
  const expression = /^process\.env\.([A-Z0-9_]+)$/.exec(source)
  if (expression === null) {
    throw new Error(`the patch uses a !!js expression this test does not model: ${source}`)
  }
  return process.env[expression[1] as string]
}

/** The rows as YAML the Loader can mount, with keys whose evaluated value is absent omitted. */
function asConfig(inserted: readonly PatchRow[]): string {
  return inserted.map((row) => {
    if (row.config === undefined) return `- name: '${row.name}'`
    const entries = Object.entries(row.config)
      .map(([key, value]) => [key, evaluate(value)] as const)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)
    return entries.length === 0
      ? `- name: '${row.name}'`
      : `- name: '${row.name}'\n  config:\n${entries.join('\n')}`
  }).join('\n') + '\n'
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the given rows through the real Loader, with module resolution stubbed to the plugin files. */
async function boot(inserted: readonly PatchRow[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-bundle-patch-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, asConfig(inserted))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['dsh-realtime', RealtimeRuntime],
    ['dsh-realtime-openai', openaiLive],
    ['dsh-realtime-agent', realtimeAgent],
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

/** Run with the credential genuinely absent, then restore whatever the machine had. */
async function withoutCredential<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.OPENAI_LIVE_API_KEY
  delete process.env.OPENAI_LIVE_API_KEY
  try {
    return await run()
  } finally {
    if (saved === undefined) delete process.env.OPENAI_LIVE_API_KEY
    else process.env.OPENAI_LIVE_API_KEY = saved
  }
}

describe('the shipped bundle patch', () => {
  it('inserts the seam, the adapter and the consumer, and nothing else', () => {
    const inserted = rows()
    expect(inserted.map(row => row.id)).toEqual(['dsh-realtime', 'dsh-realtime-openai', 'dsh-realtime-agent'])
    expect(inserted.map(row => row.name)).toEqual(['dsh-realtime', 'dsh-realtime-openai', 'dsh-realtime-agent'])
    // The seam is a *service* package: it default-exports its class, takes no config and has no
    // `apply`. A config block here would be a row that mounts and ignores everything in it.
    expect(inserted[0]).not.toHaveProperty('config')
  })

  it('configures every row using only fields its own schema declares', () => {
    const schemas: Record<string, Record<string, unknown>> = {
      'dsh-realtime-openai': Config.dict as Record<string, unknown>,
      'dsh-realtime-agent': AgentConfig.dict as Record<string, unknown>,
    }
    // This is the assertion that matters most, because the failure it prevents is SILENT: schemastery
    // KEEPS an undeclared key rather than rejecting it, so `api_key` boots clean and is ignored while
    // the plugin runs on defaults. A row whose name has no schema here fails loudly for the same
    // reason — it means a row was added without anyone checking its config against anything.
    for (const row of rows()) {
      const keys = Object.keys(row.config ?? {})
      if (keys.length === 0) continue
      const declared = new Set(Object.keys(schemas[row.name] ?? {}))
      expect(keys.filter(key => !declared.has(key)), `undeclared config on row ${row.name}`).toEqual([])
    }
  })

  it('declares a credential field but does not require it', () => {
    expect(() => Config({})).not.toThrow()
    expect(Object.keys(Config.dict as Record<string, unknown>)).toContain('apiKey')
  })

  it('boots through the real Loader with no credential present', { timeout: 60_000 }, async () => {
    const loaded = await withoutCredential(() => boot(rows()))

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    expect(loaded.realtime).toBeInstanceOf(RealtimeRuntime)
    // The route name comes from the patch's `provider`, so this asserts the config was actually
    // applied rather than the row merely mounting.
    expect(loaded.realtime.listProviders().map(provider => provider.id)).toEqual(['openai-live'])
  })

  it('lands a missing credential at the session request, not at boot', { timeout: 60_000 }, async () => {
    // The claim in the README, tested: an unconfigured machine composes, then says precisely what is
    // missing. Failing at boot would break a user's harness for a configuration they have not made.
    const loaded = await withoutCredential(() => boot(rows()))
    let code: unknown
    try {
      await loaded.realtime.session({
        provider: 'openai-live',
        model: 'gpt-live-1',
        handlers: {},
      })
    } catch (error) {
      code = (error as { code?: unknown }).code
    }
    expect(code).toBe('NOT_CONFIGURED')
  })
})
