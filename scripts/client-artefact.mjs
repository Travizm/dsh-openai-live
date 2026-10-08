#!/usr/bin/env node
/**
 * The client-face artefact guard.
 *
 * A client face is served to the browser through the harness's **lazy-CJS module table**, so the bundle it
 * emits must be CommonJS. Nothing else in this repository can see that. Coverage measures the SOURCE, and
 * the source and its emitted artefact can disagree about module format without a single test noticing —
 * which is precisely how `dsh-realtime-audio-ws@0.1.0` shipped ESM into a CJS loader, produced
 * `Uncaught SyntaxError: Unexpected token 'export'` in the renderer, and took the entire harness boot down
 * with it.
 *
 * So this inspects what was actually built, for every package that declares `dsh.client`.
 *
 * It proves its own detector first, against one fixture that must be rejected and one that must be
 * accepted: a guard that has never failed is unproven, and a format detector that has silently stopped
 * detecting is worse than no guard at all.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Strip comments before scanning, so a doc block that merely says the word "export" is not a finding.
 * Crude on purpose: this asks a question about module syntax, not about JavaScript.
 *
 * @param source - the emitted file.
 * @returns the file with comments removed.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
}

/**
 * Find top-level ESM syntax in an emitted bundle.
 *
 * @param source - the emitted file.
 * @returns the offending constructs, empty when there are none.
 */
export function findEsmSyntax(source) {
  // The word boundary is load-bearing: without it `exports.apply` reads as the `export` keyword, which is
  // the false positive the self-test below exists to catch.
  return withoutComments(source).match(/(?:^|\n)[ \t]*(?:export|import)\b/gu) ?? []
}

/**
 * Does the file expose a plugin entry point at all?
 *
 * @param source - the emitted file.
 * @returns true when the module seems to export `apply`.
 */
export function exportsApply(source) {
  return /exports\.apply\b|\bmodule\.exports\b/u.test(source)
}

// ---- prove the detector can fail -----------------------------------------------------------------------

const detectorCases = [
  { name: 'esm: export const', source: 'export const inject = []', esm: true },
  { name: 'esm: export function', source: '\nexport function apply(ctx) {}', esm: true },
  { name: 'esm: import statement', source: "import x from 'y'", esm: true },
  { name: 'cjs: exports.apply', source: '"use strict";\nexports.apply = apply;', esm: false },
  { name: 'esm word inside a comment', source: '/**\n * exporting its built bundle\n */\nexports.apply = apply;', esm: false },
]

for (const testCase of detectorCases) {
  const found = findEsmSyntax(testCase.source).length > 0
  if (found !== testCase.esm) {
    console.error(`SELF-TEST FAILED: detector called "${testCase.name}" esm=${String(found)}, expected esm=${String(testCase.esm)}`)
    process.exit(1)
  }
}
if (!exportsApply('"use strict";\nexports.apply = apply;') || exportsApply('"use strict";\nconst x = 1;')) {
  console.error('SELF-TEST FAILED: the entry-point detector cannot tell a module with apply from one without')
  process.exit(1)
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
  const client = manifest.dsh?.client
  if (client === undefined) continue

  const exported = manifest.exports?.['./client']
  const target = typeof exported === 'string' ? exported : exported?.default
  if (target === undefined) {
    findings.push(`${manifest.name}: declares dsh.client but exports no "./client" entry`)
    continue
  }

  const artefact = join(packagesDir, entry.name, target)
  const shown = relative(root, artefact)
  if (!existsSync(artefact)) {
    findings.push(`${manifest.name}: ${shown} is missing — did the client build run?`)
    continue
  }

  const source = readFileSync(artefact, 'utf8')
  const esm = findEsmSyntax(source)
  if (esm.length > 0) {
    const first = esm[0].trim().slice(0, 60)
    findings.push(`${manifest.name}: ${shown} carries ESM syntax (${String(esm.length)} site(s), e.g. "${first}") — the module table materialises CommonJS, so the boot will fail`)
    continue
  }
  if (!exportsApply(source)) {
    findings.push(`${manifest.name}: ${shown} is CommonJS but exposes no "apply" — the plugin would load and contribute nothing`)
    continue
  }
  checked.push(`${manifest.name} → ${shown} (CommonJS, ${String(esm.length)} ESM sites)`)
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
