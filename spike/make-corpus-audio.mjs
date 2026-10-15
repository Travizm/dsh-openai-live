/**
 * Generate the intent corpus's audio from `corpus.json`.
 *
 * **`say -v <voice>` is not optional.** `say` with no voice writes a header-only AIFF (4332 bytes,
 * 0.01 s), exits 0, and silently produces no speech — which is how a first batch of five 258-byte
 * fixtures was produced and nearly used.
 *
 * Every fixture is verified afterwards: non-trivial length *and* a plausible mean volume, because a
 * corpus of silence would make every downstream measurement meaningless while looking fine.
 *
 * Usage: node spike/make-corpus-audio.mjs [voice]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(here, 'fixtures', 'corpus')
const VOICE = process.argv[2] ?? 'Karen'
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'

const manifest = JSON.parse(readFileSync(join(corpusDir, 'corpus.json'), 'utf8'))
const cases = manifest.cases.filter((c) => typeof c.name === 'string')

/** Mean volume, so silence cannot pass as a fixture. Returns null when it cannot be read. */
function meanVolumeDb(pcmPath) {
  // `volumedetect` reports on **stderr**, which `execFileSync` does not return — the first version of
  // this check read stdout, got nothing, and marked all 21 good fixtures BAD. The instrument has to be
  // checked as carefully as the thing it measures.
  const result = spawnSync(FFMPEG, [
    '-hide_banner', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath,
    '-af', 'volumedetect', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = /mean_volume:\s*(-?[\d.]+)/.exec(text)
  return match === null ? null : Number(match[1])
}

console.log(`generating ${cases.length} fixtures · voice ${VOICE}\n`)

let bad = 0
for (const item of cases) {
  const aiff = join(corpusDir, `${item.name}.aiff`)
  const pcm = join(corpusDir, `${item.name}.pcm`)
  execFileSync('say', ['-v', VOICE, '-o', aiff, item.says])
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '24000', '-ac', '1', '-f', 's16le', pcm])
  if (existsSync(aiff)) unlinkSync(aiff)

  const bytes = statSync(pcm).size
  const seconds = bytes / 2 / 24_000
  const mean = meanVolumeDb(pcm)
  const ok = seconds >= 0.4 && mean !== null && mean > -50 && mean < -5
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok  ' : 'BAD '} ${item.name.padEnd(4)} ${item.class.padEnd(16)} ${String(bytes).padStart(7)} B  ${seconds.toFixed(2)}s  mean ${mean ?? '—'} dB`)
}

console.log(`\n${cases.length - bad}/${cases.length} usable${bad === 0 ? '' : ` — ${bad} BAD fixtures must be fixed before harvesting`}`)
process.exit(bad === 0 ? 0 : 1)
