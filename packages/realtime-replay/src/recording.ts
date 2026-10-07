/**
 * Reading a recorded session.
 *
 * Validation is strict and fails loudly. A replay that silently skipped a malformed row would produce
 * a session that never establishes, or one that establishes and then goes quiet — and the failure
 * would surface as a confusing assertion in whichever test happened to run first, rather than as the
 * recording being wrong.
 *
 * @module dsh-realtime-replay/recording
 */

import { readFileSync } from 'node:fs'
import { RealtimeError } from 'dsh-realtime'
import type { RecordedFrame } from './types.ts'

/** Reject one row, naming the file and line so the recording can be fixed. */
function reject(source: string, line: number, why: string): never {
  throw new RealtimeError(`${source}:${line} ${why}`, 'INVALID_RECORDING')
}

/**
 * Parse the text of a recorded session.
 *
 * Blank lines are skipped so a trailing newline is not an error. Every other line must be a JSON
 * object carrying a finite numeric `t` and an object `event`.
 * @param text - the recording's text.
 * @param source - file name used in diagnostics.
 * @returns the frames in recorded order.
 * @throws RealtimeError `INVALID_RECORDING` for a malformed row or an empty recording.
 */
export function parseRecording(text: string, source: string): RecordedFrame[] {
  const frames: RecordedFrame[] = []
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line.length === 0) continue
    const lineNumber = index + 1

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      reject(source, lineNumber, 'is not JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      reject(source, lineNumber, 'is not a recorded-frame object')
    }
    const row = parsed as { t?: unknown; event?: unknown }
    if (typeof row.t !== 'number' || !Number.isFinite(row.t)) {
      reject(source, lineNumber, 'needs a finite numeric "t"')
    }
    if (typeof row.event !== 'object' || row.event === null || Array.isArray(row.event)) {
      reject(source, lineNumber, 'needs an "event" object')
    }
    frames.push({ t: row.t, event: row.event as Record<string, unknown> })
  }
  if (frames.length === 0) {
    // An empty recording is not a valid replay: it would produce a session that never establishes.
    throw new RealtimeError(`${source} contains no recorded frames`, 'INVALID_RECORDING')
  }
  return frames
}

/**
 * Read a recorded session from disk.
 * @param path - file to read.
 * @returns the frames in recorded order.
 * @throws RealtimeError `INVALID_RECORDING` when the file cannot be read or is not a valid recording.
 */
export function loadRecording(path: string): RecordedFrame[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new RealtimeError(
      `could not read the recorded session at ${path}`,
      'INVALID_RECORDING',
      { cause: error },
    )
  }
  return parseRecording(text, path)
}
