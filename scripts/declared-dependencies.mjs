#!/usr/bin/env node
/**
 * The declared-dependency check: every bare specifier a package's **shipped** JavaScript imports must be
 * declared by that package.
 *
 * Why this exists: `dsh-realtime-audio-ws` imported the *value* `redact` from `dsh-realtime` while its
 * manifest declared only `dsh-realtime-agent` and `ws`. The type imports sitting beside the value import
 * are erased at build, which is exactly what kept it invisible — the source reads as a package that needs
 * nothing, and the built `lib/` reaches for a package the tarball never asked for.
 *
 * It did not fail loudly, and that is the whole point. It resolved by accident: the consumer installs the
 * aggregating bundle, whose own dependency on the seam hoists a copy at the profile's top level, and the
 * plugin's `import` walks up and finds it. That is a property of the installer's layout, not a contract,
 * so what this catches is a boot error waiting for a layout change — `ERR_MODULE_NOT_FOUND` in a user's
 * profile, naming a plugin whose row is the only thing that pointed at it.
 *
 * It reads **shipped** JavaScript rather than source. A type-only import is not a dependency, so a
 * source-level check would report the erased type edges as ones — the same wrong answer in the other
 * direction. `files` in the manifest is what defines shipping, so that is what gets walked.
 *
 * There is deliberately no allow-list. The compliant path is to declare the dependency, which is also
 * the honest description of the package, and a check with no compliant path relocates the work rather
 * than preventing it. Three rules, and why none of them is a false positive:
 *
 *   - a **peer** satisfies it: the harness supplies the instance and the manifest names the range.
 *   - relative and absolute paths are the package's own code; `node:` builtins are the runtime's.
 *   - a specifier has to *look* like one (`name`, `@scope/name`, `name/sub`), so ordinary prose does not
 *     qualify. It does not parse, though: a string literal containing a complete import statement — an
 *     error message quoting one — is indistinguishable from code by shape. There are none in this tree,
 *     and that is the safe direction to be wrong in: a false finding stops the gate loudly and names the
 *     file, where a missed edge is a boot error in a user's profile.
 *
 * Usage: node scripts/declared-dependencies.mjs [--root <dir>]        (after `pnpm build`)
 * Exit:  0 = every package declares what it imports · 1 = one does not, or nothing was built
 *
 * `--root` exists so the check can be pointed at a fixture tree, which is how the tests drive this
 * script's own exit code and message rather than only the function behind them: a check whose report
 * nobody executes is a check that cannot fail.
 *
 * @module
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The four shapes a module edge takes. Order matters only in that the call forms come first. */
const SPECIFIER = /(?:\bimport\s*\(\s*|\brequire\s*\(\s*|\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/gu

/** What a specifier can be spelled as. Anything else is prose that happened to follow `from`. */
const SPECIFIER_SHAPE = /^(?:@[\w.~-]+\/)?[\w.~-]+(?:\/[\w.~-]+)*$/u

const SKIP_DIRS = new Set(['node_modules', '.git'])

/**
 * Every bare specifier a piece of shipped JavaScript imports, in source order and with duplicates.
 * @param source - the file's text.
 * @returns the specifier names, including relative and builtin ones, for the caller to classify.
 */
export function specifiersIn(source) {
  const found = []
  SPECIFIER.lastIndex = 0
  let match
  while ((match = SPECIFIER.exec(source)) !== null) {
    const specifier = match[1]
    if (SPECIFIER_SHAPE.test(specifier)) found.push(specifier)
  }
  return found
}

/**
 * The package a specifier names, which is what a manifest can declare.
 * @param specifier - a bare specifier.
 * @returns its package name, honouring the scope.
 */
export function packageOf(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
}

/**
 * Whether one specifier is somebody else's problem.
 * @param specifier - a bare specifier.
 * @returns true for the package's own files and for runtime builtins.
 */
function notADependency(specifier) {
  return specifier.startsWith('.') || isAbsolute(specifier) || isBuiltin(specifier)
}

/** Every `.js` file under a path, following directories but never `node_modules`. */
function shippedFiles(path) {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const child = join(current, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.js')) found.push(child)
    }
  }
  if (statSync(path).isDirectory()) walk(path)
  return found
}

/**
 * Read every workspace manifest, judge what it imports against what it declares, and hand the caller
 * facts rather than a verdict — the CLI below decides what a failure prints, and the tests drive this
 * directly so the check is proven to bite rather than merely reported to pass.
 * @param root - the repository root.
 * @returns one entry per package, each with its undeclared imports and its build state.
 */
export function checkDeclaredDependencies(root) {
  const dirs = ['packages', '.']
    .flatMap(prefix => {
      const dir = join(root, prefix)
      if (prefix === '.') return [dir]
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => join(dir, entry.name))
      } catch {
        // No `packages/` is an empty workspace rather than a crash: the CLI's own report is where a
        // missing tree should be understood, and a stack trace is not a report.
        return []
      }
    })

  const packages = []
  for (const dir of dirs) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    // What ships, per the manifest's own `files`: a package that lists nothing is unverified rather
    // than clean, because a check that passes over code it never read is worse than no check.
    const roots = (manifest.files ?? []).map(entry => join(dir, entry)).filter(entry => {
      try {
        return statSync(entry) !== undefined
      } catch {
        return false
      }
    })
    const files = roots.flatMap(shippedFiles)

    const undeclared = []
    for (const file of files) {
      for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
        if (notADependency(specifier)) continue
        const name = packageOf(specifier)
        if (declared.has(name)) continue
        const at = relative(dir, file)
        if (!undeclared.some(finding => finding.name === name)) undeclared.push({ name, file: at })
      }
    }
    packages.push({ name: manifest.name, dir: relative(root, dir) || '.', files: files.length, declared, undeclared })
  }
  return packages
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  const flag = process.argv.indexOf('--root')
  const root = flag === -1 ? fileURLToPath(new URL('..', import.meta.url)) : process.argv[flag + 1]
  const packages = checkDeclaredDependencies(root)
  const built = packages.filter(entry => entry.files > 0)
  const unverified = packages.filter(entry => entry.files === 0)
  const findings = built.flatMap(entry => entry.undeclared.map(finding => ({ ...finding, package: entry.name })))
  const files = built.reduce((total, entry) => total + entry.files, 0)

  if (packages.length === 0) {
    console.error(`DECLARED DEPENDENCIES UNVERIFIED — no package manifest found under ${root}`)
    console.error('\n  A check that passes over nothing it read is worse than no check.')
    process.exit(1)
  }

  if (findings.length > 0) {
    console.error(`DECLARED DEPENDENCIES FAILED — ${findings.length} import(s) no manifest declares:`)
    for (const { package: name, name: specifier, file } of findings) {
      console.error(`  ${name.padEnd(26)} imports ${specifier.padEnd(22)} (${file})`)
    }
    console.error('\n  Declare it in that package\'s package.json. A runtime edge is a `dependency`;')
    console.error('  a package the host supplies is a `peerDependency`. Do not inline the call instead.')
    process.exit(1)
  }

  if (unverified.length > 0) {
    console.error(`DECLARED DEPENDENCIES UNVERIFIED — ${unverified.length} package(s) have no shipped JavaScript to read:`)
    for (const { name, dir } of unverified) console.error(`  ${name.padEnd(26)} (${dir})`)
    console.error('\n  Run `pnpm build` first: this check reads what ships, not what is written.')
    process.exit(1)
  }

  console.log(`PASS declared dependencies — ${packages.length} package(s), ${files} shipped file(s), no undeclared import`)
}
