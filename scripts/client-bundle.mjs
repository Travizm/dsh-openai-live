#!/usr/bin/env node
/**
 * Wrap a client face's compiled output in the shape the module table actually executes.
 *
 * The contract, quoted from the harness's own module table (`packages/client/modules/src/client/manifest.ts`):
 *
 *   "Lazy CJS model: executing a plugin bundle only REGISTERS its factory
 *    (`window.__ModuleLoader__.load({id, factory})`); every module body side effect — including CSS
 *    injection — lives inside the factory closure and runs at materialization, not at script execution.
 *    Materialization (factory(require) → exports) happens on first import/require and is memoized."
 *
 * So a client bundle is neither ESM nor plain CommonJS, and getting it wrong is not a subtle failure:
 *
 *   - ESM      → `Uncaught SyntaxError: Unexpected token 'export'`
 *   - plain CJS→ `Uncaught ReferenceError: exports is not defined`
 *
 * Both were shipped, both stopped the whole harness from booting, because the web boot fails loudly on a
 * single bad entry. The bundle is a *script* that registers a factory, and the factory is declared
 * `(require) => Record<string, unknown>` — it receives the table's synchronous require and RETURNS the
 * exports, which is why a compiled CJS body needs a local `exports` object to assign onto.
 *
 * Usage: node scripts/client-bundle.mjs <packageDir>
 *   reads  <packageDir>/lib/client/index.js   (this package's own CommonJS build)
 *   writes <packageDir>/lib/client/bundle.js  (the registration the table executes)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [packageDir] = process.argv.slice(2)
if (packageDir === undefined) {
  console.error('usage: node scripts/client-bundle.mjs <packageDir>')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const source = join(packageDir, 'lib/client/index.js')
if (!existsSync(source)) {
  console.error(`FAIL no compiled client face at ${source} — run the package build first`)
  process.exit(1)
}

const body = readFileSync(source, 'utf8')
const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)},`,
  '  factory: (require) => {',
  '    const exports = {}',
  '    const module = { exports }',
  body.replace(/^/gmu, '    ').trimEnd(),
  '    return exports',
  '  },',
  '})',
  '',
].join('\n')

writeFileSync(join(packageDir, 'lib/client/bundle.js'), wrapped)
console.log(`PASS client bundle — ${manifest.name} → lib/client/bundle.js (registers a factory)`)
