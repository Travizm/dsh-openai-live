import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadRecording, parseRecording } from '../src/recording.ts'

const FIXTURE = new URL('./fixtures/mini-session.jsonl', import.meta.url)

const good = JSON.stringify({ t: 0, event: { type: 'session.started' } })

describe('parseRecording', () => {
  it('reads a recording into frames in order', () => {
    const frames = parseRecording(`${good}\n${JSON.stringify({ t: 5, event: { type: 'session.closed' } })}\n`, 'x')
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ t: 0, event: { type: 'session.started' } })
    expect(frames[1]?.event.type).toBe('session.closed')
  })

  it('tolerates blank lines and a trailing newline', () => {
    expect(parseRecording(`\n${good}\n\n`, 'x')).toHaveLength(1)
  })

  it('rejects a line that is not JSON, naming the file and line', () => {
    const failure = (() => {
      try {
        parseRecording(`${good}\nnot json`, 'rec.jsonl')
        return undefined
      } catch (error: unknown) {
        return error as { code?: string; message?: string }
      }
    })()
    expect(failure?.code).toBe('INVALID_RECORDING')
    expect(failure?.message).toContain('rec.jsonl:2')
  })

  it('rejects a row that is not a plain object', () => {
    expect(() => parseRecording('[]', 'x')).toThrowError(expect.objectContaining({ code: 'INVALID_RECORDING' }))
    expect(() => parseRecording('null', 'x')).toThrowError(expect.objectContaining({ code: 'INVALID_RECORDING' }))
    expect(() => parseRecording('7', 'x')).toThrowError(expect.objectContaining({ code: 'INVALID_RECORDING' }))
  })

  it('rejects a row without a finite numeric t', () => {
    for (const row of [{ event: {} }, { t: '0', event: {} }, { t: Number.NaN, event: {} }]) {
      expect(() => parseRecording(JSON.stringify(row), 'x'))
        .toThrowError(expect.objectContaining({ code: 'INVALID_RECORDING' }))
    }
  })

  it('rejects a row whose event is missing or not an object', () => {
    for (const row of [{ t: 0 }, { t: 0, event: null }, { t: 0, event: [] }, { t: 0, event: 'x' }]) {
      expect(() => parseRecording(JSON.stringify(row), 'x'))
        .toThrowError(expect.objectContaining({ code: 'INVALID_RECORDING' }))
    }
  })

  it('refuses an empty recording rather than replaying a session that cannot establish', () => {
    expect(() => parseRecording('', 'x')).toThrowError(expect.objectContaining({ code: 'INVALID_RECORDING' }))
    expect(() => parseRecording('\n\n', 'x')).toThrowError(expect.objectContaining({ code: 'INVALID_RECORDING' }))
  })
})

describe('loadRecording', () => {
  it('reads a recorded session from disk', () => {
    const frames = loadRecording(FIXTURE.pathname)
    expect(frames.length).toBeGreaterThan(5)
    expect(frames[0]?.event.type).toBe('session.started')
    expect(frames.at(-1)?.event.type).toBe('session.usage.updated')
  })

  it('refuses a path it cannot read, keeping the cause', () => {
    const failure = (() => {
      try {
        loadRecording('/nonexistent/recording.jsonl')
        return undefined
      } catch (error: unknown) {
        return error as { code?: string; message?: string; cause?: unknown }
      }
    })()
    expect(failure?.code).toBe('INVALID_RECORDING')
    expect(failure?.message).toContain('/nonexistent/recording.jsonl')
    expect(failure?.cause).toBeInstanceOf(Error)
  })

  it('reports a real recording as valid, so the fixture itself is checked', () => {
    // Guard against the fixture silently rotting into an invalid recording.
    expect(parseRecording(readFileSync(FIXTURE, 'utf8'), 'mini')).toHaveLength(9)
  })
})
