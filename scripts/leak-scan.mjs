#!/usr/bin/env node
/**
 * Leak scan over every tracked file.
 *
 * Why this exists: the publish guard ("inspect the tarball before publishing") caught a credential
 * **fingerprint** sitting in a document that was about to ship. A fingerprint is not the key, but it
 * is a credential-derived identifier — stable, org-identifying, and not something to publish. The
 * tarball guard found the instance; this finds the class, on every commit, so the next one never
 * reaches a tarball.
 *
 * Scans `git ls-files` rather than the working tree: a file that is ignored locally but tracked is
 * still published, and an untracked scratch file cannot leak. Published artefacts contain nothing but
 * tracked files plus build output derived from them, so this covers what ships.
 *
 * Every pattern here is unambiguous by construction. That matters: a check with no compliant path
 * relocates the work rather than preventing it, so there is deliberately no allow-list and no bypass
 * to maintain. If you need to write a credential-shaped literal in a document, write it as the name of
 * the setting instead — which is more useful to a reader anyway.
 *
 * Usage: node scripts/leak-scan.mjs
 * Exit:  0 = clean · 1 = a hit
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Unambiguous credential shapes. No false-positive-prone heuristics: no "high entropy" guessing. */
const PATTERNS = [
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9_.-]{20,}/g },
  { name: 'PEM private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  // A recorded fingerprint of a real credential.
  { name: 'key fingerprint', re: /\bfp=[0-9a-f]{8,}\b/gi },
  // A credential assigned a literal value. `$VAR`, `${VAR}`, and an empty value are all fine, which is
  // the compliant path: name the setting, let the composition supply it.
  {
    name: 'literal credential assignment',
    re: /\b(?:OPENAI_API_KEY|VOICE_TOOLS_OPENAI_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN|NPM_TOKEN)\s*=\s*(?![\s"'`$])[^\s"'`]{7,}/g,
  },
]

const SKIP_EXTENSIONS = /\.(?:png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|mp3|wav|aiff|pcm|bin|db)$/i

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)

const hits = []
let scanned = 0

for (const file of files) {
  if (SKIP_EXTENSIONS.test(file)) continue
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  scanned += 1
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length
      // The matched text is NOT echoed: printing it would put the very thing being guarded against
      // into a CI log. The pattern name and the location are enough to act on.
      hits.push({ file, line, name })
    }
  }
}

if (hits.length > 0) {
  console.error(`LEAK SCAN FAILED — ${hits.length} credential-shaped match(es):`)
  for (const { file, line, name } of hits) console.error(`  ${file}:${line}  ${name}`)
  console.error('\n  Values are not echoed, deliberately. Replace the literal with the NAME of the setting.')
  process.exit(1)
}

console.log(`PASS leak scan — ${scanned} tracked file(s), ${PATTERNS.length} patterns, no hits`)
