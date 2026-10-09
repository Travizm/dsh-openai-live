/**
 * The declared-dependency check.
 *
 * Driven as a **black box** — the real script, as a process, against small workspaces built for the
 * occasion — because its contract is an exit code and a report a person reads. A check whose report
 * nobody executes is a check that cannot fail, which is the defect this file exists about one level up.
 *
 * Each case is a shape that has actually been got wrong or plausibly could be. The first is the real
 * one: `dsh-realtime-audio-ws` imported the value `redact` from `dsh-realtime` while declaring only
 * `dsh-realtime-agent` and `ws`, with the erased `import type` beside it hiding the omission from every
 * source-level reading. The rest are the ways a check like this turns into noise: a peer that satisfies
 * it, a builtin and a relative path that never need declaring, a subpath of a package that is declared,
 * and a package with nothing built — which must read as *unverified* rather than as clean.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/declared-dependencies.mjs', import.meta.url))

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** A manifest with the fields this check reads, and nothing else it might mistake for them. */
function manifest(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ version: '1.0.0', ...fields }, undefined, 2)}\n`
}

/** A workspace on disk: manifests and the shipped JavaScript beside them. */
async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-declared-deps-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return root
}

/** Run the check against a workspace. */
const check = (root: string): ReturnType<typeof spawnSync> =>
  spawnSync('node', [SCRIPT, '--root', root], { encoding: 'utf8' })

describe('the declared-dependency check', () => {
  it('finds the import no manifest declares, and names the package and the file it came from', async () => {
    const root = await workspace({
      'packages/alpha/package.json': manifest({ name: 'alpha', files: ['lib'], dependencies: { beta: '^1.0.0' } }),
      // The defect exactly: a value import whose package is undeclared, with a type import erasing
      // itself beside it. What ships is the value edge.
      'packages/alpha/lib/index.js': "import { redact } from 'gamma'\nexport const a = redact\n",
      'packages/beta/package.json': manifest({ name: 'beta', files: ['lib'] }),
      // A declared sibling that imports nothing undeclared: the check judges edges, not packages, so
      // this one must not appear in the report even though alpha's finding sits on the same run.
      'packages/beta/lib/index.js': 'export const b = 1\n',
    })

    const run = check(root)

    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('DECLARED DEPENDENCIES FAILED — 1 import(s)')
    expect(run.stderr).toContain('gamma')
    expect(run.stderr).toContain('alpha')
    expect(run.stderr).toContain('lib/index.js')
    // The sibling it does declare is not a finding: the check judges each edge, not each package.
    expect(run.stderr).not.toContain('beta')
  })

  it('accepts a peer, a builtin, a relative path, a subpath and the bundle’s own bare import', async () => {
    const root = await workspace({
      'package.json': manifest({ name: 'bundle', files: ['dsh'], dependencies: { alpha: '^1.0.0' } }),
      'dsh/index.js': "import 'alpha'\nexport const boot = true\n",
      'packages/alpha/package.json': manifest({
        name: 'alpha',
        files: ['lib'],
        dependencies: { beta: '^1.0.0', ws: '^8.0.0' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.0', '@deepseek-ai/dsh-tools': '^4.0.0' },
      }),
      'packages/alpha/lib/index.js': [
        "import { createRequire } from 'node:module'",
        "import { b } from 'beta'",
        "import { deep } from 'ws/lib/websocket.js'",
        "import { c } from '@deepseek-ai/cordis'",
        "import { local } from './local.js'",
        "const tool = require('@deepseek-ai/dsh-tools')",
        'export const all = [createRequire, b, deep, c, local, tool]',
      ].join('\n'),
      // A peer of a package that declares it too, since the harness packages are peers everywhere.
      'packages/alpha/lib/peer.js': "export const p = require('@deepseek-ai/cordis')\n",
    })

    const run = check(root)

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('PASS declared dependencies — 2 package(s)')
  })

  it('reads prose as prose, so a sentence in a string literal is not a finding', async () => {
    const root = await workspace({
      'packages/alpha/package.json': manifest({ name: 'alpha', files: ['lib'] }),
      'packages/alpha/lib/index.js': [
        "throw new Error('the answer came from cache')",
        "const note = 'require(thing) is not an edge'",
        'export const n = note',
      ].join('\n'),
    })

    const run = check(root)

    expect(run.status).toBe(0)
    expect(run.stdout).toContain('PASS declared dependencies')
  })

  it('calls a package with nothing built unverified rather than clean', async () => {
    const root = await workspace({
      'packages/alpha/package.json': manifest({ name: 'alpha', files: ['lib'] }),
    })

    const run = check(root)

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('DECLARED DEPENDENCIES UNVERIFIED')
    expect(run.stderr).toContain('alpha')
    expect(run.stderr).toContain('pnpm build')
  })

  it('calls a tree with no manifest unverified rather than a pass over nothing', async () => {
    const root = await workspace({})

    const run = check(root)

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('no package manifest found')
  })
})
