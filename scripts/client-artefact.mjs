#!/usr/bin/env node
/**
 * The client-face artefact guard.
 *
 * A client face is served to the browser and executed by the harness's **lazy-CJS module table**, which
 * does not evaluate it as ESM and does not provide an `exports` binding: the bundle must be a script that
 * REGISTERS A FACTORY —
 *
 *     window.__ModuleLoader__.load({ id: '<package>', factory: (require) => { … return exports } })
 *
 * — and the factory returns the bundle's exports. Getting this wrong is a total failure, not a subtle one:
 *
 *     ESM       → `Uncaught SyntaxError: Unexpected token 'export'`
 *     plain CJS → `Uncaught ReferenceError: exports is not defined`
 *
 * Both were shipped by this repository, each stopping the entire harness from booting, because the web
 * boot fails loudly on one bad entry. Neither was visible to any test: coverage measures the SOURCE, and
 * the source and its emitted artefact can disagree about module shape silently.
 *
 * The first version of this guard enforced "CommonJS and nothing else" — a rule inferred from the words
 * "lazy-CJS" rather than read from the table's contract. It passed while the application was broken. Hence
 * the self-test below: a guard that encodes a guess is worse than no guard, because it returns confident
 * passes.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Strip comments before scanning, so a doc block that merely discusses `export` is not a finding.
 *
 * @param source - the emitted file.
 * @returns the file with comments removed.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
}

/**
 * Find top-level ESM syntax, which the table's script evaluation cannot parse.
 *
 * The word boundary is load-bearing: without it `exports.apply` reads as the `export` keyword.
 *
 * @param source - the emitted file.
 * @returns the offending constructs, empty when there are none.
 */
export function findEsmSyntax(source) {
  return withoutComments(source).match(/(?:^|\n)[ \t]*(?:export|import)\b/gu) ?? []
}

/**
 * Does the file register a module-table factory, which is the only shape that executes?
 *
 * @param source - the emitted file.
 * @returns true when the registration is present.
 */
export function registersFactory(source) {
  return /__ModuleLoader__\s*\.\s*load\s*\(/u.test(withoutComments(source))
    && /\bfactory\s*:/u.test(withoutComments(source))
}

// ---- prove the detector can fail -----------------------------------------------------------------------

const cases = [
  { name: 'esm: export const', source: 'export const inject = []', esm: true, factory: false },
  { name: 'esm: import statement', source: "import x from 'y'", esm: true, factory: false },
  { name: 'plain cjs: exports.apply only', source: '"use strict";\nexports.apply = apply;', esm: false, factory: false },
  { name: 'registration', source: 'window.__ModuleLoader__.load({ id: "p", factory: (require) => { return {} } })', esm: false, factory: true },
  { name: 'esm word inside a comment', source: '/**\n * exporting its bundle\n */\nwindow.__ModuleLoader__.load({ factory: () => ({}) })', esm: false, factory: true },
]

for (const testCase of cases) {
  const esm = findEsmSyntax(testCase.source).length > 0
  const factory = registersFactory(testCase.source)
  if (esm !== testCase.esm || factory !== testCase.factory) {
    console.error(`SELF-TEST FAILED: "${testCase.name}" → esm=${String(esm)} factory=${String(factory)}, expected esm=${String(testCase.esm)} factory=${String(testCase.factory)}`)
    process.exit(1)
  }
}

// ---- scan every declared client face -------------------------------------------------------------------

const packagesDir = join(root, 'packages')
const findings = []
const checked = []

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const manifestPath = join(packagesDir, entry.name, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh?.client === undefined) continue

  const exported = manifest.exports?.['./client']
  const target = typeof exported === 'string' ? exported : exported?.default
  if (target === undefined) {
    findings.push(`${manifest.name}: declares dsh.client but exports no "./client" entry`)
    continue
  }

  const artefact = join(packagesDir, entry.name, target)
  const shown = relative(root, artefact)
  if (!existsSync(artefact)) {
    findings.push(`${manifest.name}: ${shown} is missing — did the client bundle step run?`)
    continue
  }

  const source = readFileSync(artefact, 'utf8')
  const esm = findEsmSyntax(source)
  if (esm.length > 0) {
    findings.push(`${manifest.name}: ${shown} carries ESM syntax ("${esm[0].trim().slice(0, 50)}") — the table evaluates a script, so the boot fails with Unexpected token 'export'`)
    continue
  }
  if (!registersFactory(source)) {
    findings.push(`${manifest.name}: ${shown} does not register a module-table factory (no __ModuleLoader__.load({ id, factory })) — the boot fails, with "exports is not defined" when it is plain CommonJS`)
    continue
  }
  checked.push(`${manifest.name} → ${shown}`)
}

if (findings.length > 0) {
  console.error(`FAIL client artefact guard — ${String(findings.length)} problem(s):`)
  for (const finding of findings) console.error(`  ${finding}`)
  process.exit(1)
}
if (checked.length === 0) {
  console.error('FAIL client artefact guard — no package declares dsh.client, so nothing was checked')
  process.exit(1)
}
console.log(`PASS client artefact guard — ${String(checked.length)} client face(s): ${checked.join('; ')}`)
