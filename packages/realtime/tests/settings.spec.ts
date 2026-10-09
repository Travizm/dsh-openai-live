import { describe, expect, it } from 'vitest'
import { RealtimeSettings, type RealtimeSettingSpec } from '../src/settings.ts'
import { Journal } from '../src/journal.ts'
import { RealtimeError, REALTIME_ERROR_CODES } from '../src/error.ts'

/** A registry with a real journal, so a change can be read back from the record it writes. */
function registry(): { settings: RealtimeSettings; journal: Journal } {
  const journal = new Journal()
  return { settings: new RealtimeSettings(journal), journal }
}

/** A `live` setting over a mutable number, which is the shape every consumer actually declares. */
function counter(over: Partial<RealtimeSettingSpec<number>> = {}) {
  const state = { value: 1_000 }
  return {
    state,
    spec: {
      field: 'value',
      kind: 'number',
      scope: 'live',
      get: () => state.value,
      set: (next: number) => { state.value = next },
      ...over,
    } satisfies RealtimeSettingSpec<number>,
  }
}

/** A frozen setting — no setter, which is what makes it frozen. */
const frozen = (field: string, scope: 'session' | 'restart', value: unknown = 'x'): RealtimeSettingSpec<unknown> =>
  ({ field, kind: 'string', scope, get: () => value }) as RealtimeSettingSpec<unknown>

describe('the spec a plugin writes', () => {
  it('accepts a declaration typed to its own value, without the plugin erasing anything', () => {
    const { state, spec } = counter()
    const settings = new RealtimeSettings(new Journal())
    // The point of the method-typed `set`: `(value: number) => void` is accepted where the registry
    // stores `(value: unknown) => void`, so a plugin states its value's type once and is done.
    expect(() => { settings.register('owner', [spec]) }).not.toThrow()
    expect(state.value).toBe(1_000)
  })
})

describe('register', () => {
  it('keys a setting by its owner and field, and reads its value now', () => {
    const { settings } = registry()
    const { spec, state } = counter()
    settings.register('realtime-responder', [spec])

    expect(settings.list()).toEqual([{
      key: 'realtime-responder.value',
      owner: 'realtime-responder',
      field: 'value',
      kind: 'number',
      scope: 'live',
      value: 1_000,
    }])

    // Read at the moment of asking, through the owner's own accessor — not a copy taken at
    // registration. This is the whole reason a live change takes effect on the next use.
    state.value = 42
    expect(settings.get('realtime-responder.value')?.value).toBe(42)
    expect(settings.get('nothing.here')).toBeUndefined()
  })

  it('carries the owner’s description when it supplied one', () => {
    const { settings } = registry()
    const { spec } = counter({ describe: 'Character budget for the prompt' })
    settings.register('realtime-responder', [spec])
    expect(settings.get('realtime-responder.value')?.describe).toBe('Character budget for the prompt')
  })

  it('keeps registration order, which is composition order', () => {
    const { settings } = registry()
    settings.register('second', [frozen('b', 'restart')])
    settings.register('first', [frozen('a', 'restart')])
    expect(settings.list().map(entry => entry.key)).toEqual(['second.b', 'first.a'])
  })

  it('releases only its own settings when the contributing fiber disposes', () => {
    const { settings } = registry()
    const { spec } = counter()
    const release = settings.register('realtime-responder', [spec])
    settings.register('realtime-agent', [frozen('autoStart', 'restart')])

    release()

    expect(settings.list().map(entry => entry.key)).toEqual(['realtime-agent.autoStart'])
    // And the key is free again, because nothing holds it any more.
    expect(() => settings.register('realtime-responder', [spec])).not.toThrow()
  })

  it('refuses an owner that is not a name', () => {
    const { settings } = registry()
    expect(() => settings.register('', [])).toThrow(RealtimeError)
    expect(() => settings.register('', [])).toThrow(/owner must be a non-empty string/)
  })

  it('refuses a field that is not a single identifier-shaped word', () => {
    const { settings } = registry()
    for (const field of ['', 'a.b', '1a', '-a']) {
      expect(() => settings.register('owner', [frozen(field, 'restart')]))
        .toThrow(/must be identifier-shaped/)
    }
  })

  it('refuses two settings under one key, whether in one call or two', () => {
    const { settings } = registry()
    const { spec } = counter()
    expect(() => settings.register('owner', [spec, spec])).toThrow(/already registered/)
    settings.register('owner', [spec])
    expect(() => settings.register('owner', [spec])).toThrow(/already registered/)
  })

  it('is all-or-nothing: a rejected spec leaves the earlier one unregistered', () => {
    const { settings } = registry()
    const { spec } = counter()
    expect(() => settings.register('owner', [spec, frozen('bad.field', 'restart')])).toThrow(RealtimeError)
    expect(settings.get('owner.value')).toBeUndefined()
  })

  it('refuses a scope or kind the surface does not know', () => {
    const { settings } = registry()
    const scope = { field: 'a', kind: 'string', scope: 'sometimes', get: () => 'x' } as unknown as RealtimeSettingSpec<unknown>
    expect(() => settings.register('owner', [scope])).toThrow(/unknown scope "sometimes"/)
    const kind = { field: 'a', kind: 'money', scope: 'restart', get: () => 'x' } as unknown as RealtimeSettingSpec<unknown>
    expect(() => settings.register('owner', [kind])).toThrow(/unknown kind "money"/)
  })

  it('refuses a class and a setter that disagree, in both directions', () => {
    const { settings } = registry()
    // Live with no way to apply a change: a control that would silently do nothing.
    expect(() => settings.register('owner', [
      { field: 'a', kind: 'number', scope: 'live', get: () => 1 } satisfies RealtimeSettingSpec<number>,
    ])).toThrow(/is live and must declare how a change is applied/)

    // Session-bound with a setter: a change this class cannot honour.
    expect(() => settings.register('owner', [
      { field: 'a', kind: 'string', scope: 'session', get: () => 'x', set: () => undefined },
    ])).toThrow(/is session-bound and cannot declare a setter/)
  })

  it('refuses a declared kind that does not match what the setting returns', () => {
    const { settings } = registry()
    const cases: readonly (readonly [RealtimeSettingSpec<unknown>, RegExp])[] = [
      [{ field: 'a', kind: 'string', scope: 'restart', get: () => 5 } as RealtimeSettingSpec<unknown>,
        /declares the kind "string" and returns a number/],
      [{ field: 'a', kind: 'number', scope: 'restart', get: () => Number.NaN } as RealtimeSettingSpec<unknown>,
        /returns a number/],
      [{ field: 'a', kind: 'boolean', scope: 'restart', get: () => 'yes' } as RealtimeSettingSpec<unknown>,
        /returns a string/],
      [{ field: 'a', kind: 'string-list', scope: 'restart', get: () => 'not-a-list' } as RealtimeSettingSpec<unknown>,
        /returns a string/],
      [{ field: 'a', kind: 'string-list', scope: 'restart', get: () => ['ok', 7] } as RealtimeSettingSpec<unknown>,
        /returns an array/],
      [{ field: 'a', kind: 'string', scope: 'restart', get: () => null } as RealtimeSettingSpec<unknown>,
        /returns null/],
    ]
    for (const [spec, expected] of cases) {
      expect(() => settings.register('owner', [spec])).toThrow(expected)
    }
  })

  it('carries the offending declaration’s code, so a caller can branch on it', () => {
    const { settings } = registry()
    try {
      settings.register('owner', [
        { field: 'a', kind: 'number', scope: 'live', get: () => 1 } satisfies RealtimeSettingSpec<number>,
      ])
      expect.unreachable('the declaration should have been refused')
    } catch (error) {
      expect((error as RealtimeError).code).toBe(REALTIME_ERROR_CODES.INVALID_SETTING)
    }
    const { spec } = counter()
    settings.register('owner', [spec])
    try {
      settings.register('owner', [spec])
      expect.unreachable('the key should have been taken')
    } catch (error) {
      expect((error as RealtimeError).code).toBe(REALTIME_ERROR_CODES.DUPLICATE_SETTING)
    }
  })
})

describe('apply', () => {
  it('applies a change, reports the value the owner now holds, and journals the key', () => {
    const { settings, journal } = registry()
    const state = { value: 1_000 }
    settings.register('realtime-responder', [{
      field: 'answerTimeoutMs',
      kind: 'number',
      scope: 'live',
      get: () => state.value,
      // A clamped setter: the answer to "what did that change?" is what the plugin holds, not what was
      // asked for.
      set: (next: number) => { state.value = Math.min(next, 60_000) },
    }])

    expect(settings.apply('realtime-responder.answerTimeoutMs', '5000'))
      .toEqual({ ok: true, key: 'realtime-responder.answerTimeoutMs', value: 5_000 })
    expect(settings.apply('realtime-responder.answerTimeoutMs', '900000')).toMatchObject({ value: 60_000 })

    // The key, and never the value: this is the record built to be read and pasted.
    expect(journal.snapshot().map(entry => [entry.kind, entry.detail])).toEqual([
      ['config.changed', { key: 'realtime-responder.answerTimeoutMs' }],
      ['config.changed', { key: 'realtime-responder.answerTimeoutMs' }],
    ])
  })

  it('refuses a key nothing is registered under, rather than doing nothing', () => {
    const { settings, journal } = registry()
    const outcome = settings.apply('realtime-responder.sessionId', 'sess-1')
    expect(outcome).toEqual({
      ok: false,
      key: 'realtime-responder.sessionId',
      code: 'UNKNOWN_SETTING',
      reason: 'no setting named "realtime-responder.sessionId" is registered',
    })
    // A refused change is not a change: nothing was recorded as having happened.
    expect(journal.snapshot()).toEqual([])
  })

  it('refuses a session-bound field with the reconnect instruction', () => {
    const { settings } = registry()
    settings.register('realtime-agent', [frozen('model', 'session', 'gpt-live-1')])
    expect(settings.apply('realtime-agent.model', 'gpt-live-2')).toEqual({
      ok: false,
      key: 'realtime-agent.model',
      code: 'FROZEN_SETTING',
      reason: '"realtime-agent.model" is fixed when the voice session opens — reconnect to apply a new value',
    })
  })

  it('refuses a restart-bound field with the restart instruction', () => {
    const { settings } = registry()
    settings.register('realtime-agent', [
      { field: 'autoStart', kind: 'boolean', scope: 'restart', get: () => false } satisfies RealtimeSettingSpec<boolean>,
    ])
    // The gate lists this field's class, and this is the class biting: a field whose only read site is
    // the boot cannot honour a change, so the answer is how to get one rather than a silent no-op.
    expect(settings.apply('realtime-agent.autoStart', 'true')).toMatchObject({
      ok: false,
      code: 'FROZEN_SETTING',
      reason: '"realtime-agent.autoStart" is claimed when the plugin loads — restart to change it',
    })
  })

  it('checks the class before the value, so a frozen field is never blamed on a typo', () => {
    const { settings } = registry()
    settings.register('realtime-agent', [
      { field: 'autoStart', kind: 'boolean', scope: 'restart', get: () => false } satisfies RealtimeSettingSpec<boolean>,
    ])
    expect(settings.apply('realtime-agent.autoStart', 'not-a-boolean')).toMatchObject({ code: 'FROZEN_SETTING' })
  })

  it('parses every kind, and refuses text that is not one', () => {
    const { settings } = registry()
    const held: { text: string; flag: boolean; list: string[] } = { text: 'start', flag: false, list: [] }
    const heldNumber = { value: 0 }
    settings.register('owner', [
      { field: 'text', kind: 'string', scope: 'live', get: () => held.text, set: (value: string) => { held.text = value } },
      { field: 'number', kind: 'number', scope: 'live', get: () => heldNumber.value, set: (value: number) => { heldNumber.value = value } },
      { field: 'flag', kind: 'boolean', scope: 'live', get: () => held.flag, set: (value: boolean) => { held.flag = value } },
      { field: 'list', kind: 'string-list', scope: 'live', get: () => held.list, set: (value: readonly string[]) => { held.list = [...value] } },
    ])

    // A string is any text at all — emptiness is the owner's rule to make, not the surface's.
    expect(settings.apply('owner.text', '')).toMatchObject({ ok: true, value: '' })
    expect(settings.apply('owner.number', ' 42 ')).toMatchObject({ ok: true, value: 42 })
    expect(settings.apply('owner.number', '1e3')).toMatchObject({ ok: true, value: 1_000 })
    expect(settings.apply('owner.flag', 'true')).toMatchObject({ ok: true, value: true })
    expect(settings.apply('owner.flag', 'false')).toMatchObject({ ok: true, value: false })
    expect(settings.apply('owner.list', '["a","b"]')).toMatchObject({ ok: true, value: ['a', 'b'] })

    for (const [key, text] of [
      ['owner.number', ''],
      ['owner.number', 'twelve'],
      ['owner.flag', 'yes'],
      ['owner.flag', 'TRUE'],
      ['owner.list', 'a,b'],
      ['owner.list', '{"a":1}'],
      ['owner.list', '["a",7]'],
    ] as const) {
      const outcome = settings.apply(key, text)
      expect(outcome).toMatchObject({ ok: false, code: 'INVALID_SETTING' })
      // The reason names the kind expected and quotes what arrived, so a caller can fix it without
      // reading the plugin's source.
      expect((outcome as { reason: string }).reason).toContain('expects a')
    }
  })

  it("carries the owner's own refusal, because that is the constraint a caller can act on", () => {
    const { settings } = registry()
    settings.register('realtime-responder', [{
      field: 'sessionId',
      kind: 'string',
      scope: 'live',
      get: () => '',
      set: (value: string) => {
        if (value.length === 0) throw new RealtimeError('sessionId must be non-empty', REALTIME_ERROR_CODES.INVALID_SETTING)
      },
    }])

    expect(settings.apply('realtime-responder.sessionId', '')).toEqual({
      ok: false,
      key: 'realtime-responder.sessionId',
      code: 'INVALID_SETTING',
      reason: '"realtime-responder.sessionId" refused the change: sessionId must be non-empty',
    })
  })

  it('names the absence when a setter rejects without saying why', () => {
    const { settings } = registry()
    settings.register('owner', [
      { field: 'a', kind: 'string', scope: 'live', get: () => '', set: () => { throw new Error('') } },
      { field: 'b', kind: 'string', scope: 'live', get: () => '', set: () => { throw 'no' } },
      { field: 'c', kind: 'string', scope: 'live', get: () => '', set: () => { throw { code: 500 } } },
    ])
    expect(settings.apply('owner.a', 'x')).toMatchObject({ reason: '"owner.a" refused the change: the setting declined the value' })
    // A bare string rejection is still a reason.
    expect(settings.apply('owner.b', 'x')).toMatchObject({ reason: '"owner.b" refused the change: no' })
    expect(settings.apply('owner.c', 'x')).toMatchObject({ reason: '"owner.c" refused the change: the setting declined the value' })
  })

  it('redacts what it echoes back, so a stray credential does not return for display', () => {
    const { settings } = registry()
    const planted = ['sk', 'settings', 'sentinelmustneverappear'].join('-')
    settings.register('owner', [
      { field: 'a', kind: 'number', scope: 'live', get: () => 1, set: () => undefined },
      { field: 'b', kind: 'string', scope: 'live', get: () => '', set: () => { throw new Error(`refused key ${planted}`) } },
    ])
    const echoed = settings.apply('owner.a', planted) as { reason: string }
    expect(echoed.reason).not.toContain('sentinelmustneverappear')
    expect(echoed.reason).toContain('[redacted]')
    const fromOwner = settings.apply('owner.b', 'x') as { reason: string }
    expect(fromOwner.reason).not.toContain('sentinelmustneverappear')
  })

  it('bounds the reason, so an owner error cannot become the payload', () => {
    const { settings } = registry()
    settings.register('owner', [
      { field: 'a', kind: 'string', scope: 'live', get: () => '', set: () => { throw new Error('x'.repeat(600)) } },
    ])
    const outcome = settings.apply('owner.a', 'x') as { reason: string }
    expect(outcome.reason).toHaveLength(200)
  })
})

describe('a setting that offers candidates', () => {
  it('reports them at the moment it is asked, beside the value', () => {
    let ids = ['session-a']
    const { settings } = registry()
    settings.register('realtime-responder', [{
      field: 'sessionId',
      kind: 'string',
      scope: 'live',
      get: () => 'sess-1',
      set: () => undefined,
      choices: () => ids,
    }])

    expect(settings.get('realtime-responder.sessionId')).toMatchObject({ value: 'sess-1', choices: ['session-a'] })
    // Read per ask, like the value: a session created a second ago is a candidate now, and the surface must
    // not be serving a list from when the plugin applied.
    ids = ['session-b', 'session-c']
    expect(settings.get('realtime-responder.sessionId')?.choices).toEqual(['session-b', 'session-c'])
  })

  it('omits the field entirely for a setting that declared none', () => {
    // Absence and emptiness are different statements, and a surface has to be able to tell them apart: no
    // field means "a text control", an empty list means "a picker with nothing to pick from yet".
    const { settings } = registry()
    const { spec } = counter()
    settings.register('owner', [spec])
    expect('choices' in settings.list()[0]!).toBe(false)
  })

  it('refuses candidates for anything that is not a string', () => {
    // A picker exists for a string. A number, a boolean and a list each have one representation, and offering
    // candidates for one would be a control that cannot render what it was given.
    const { settings } = registry()
    expect(() => settings.register('owner', [{
      field: 'budget',
      kind: 'number',
      scope: 'live',
      get: () => 1,
      set: () => undefined,
      choices: () => ['1'],
    }])).toThrow(/declares choices and the kind "number"/)
  })
})

describe('a secret setting', () => {
  /** Every value a profile has named as a redaction secret must never be reported back. */
  const planted = ['sk', 'secret', 'sentinelmustneverappear'].join('-')

  it('reports no value at all, in the list and in a change’s outcome', () => {
    const { settings } = registry()
    const state = { secrets: ['one'] as readonly string[] }
    settings.register('realtime-responder', [{
      field: 'redactSecrets',
      kind: 'string-list',
      scope: 'live',
      secret: true,
      get: () => state.secrets,
      set: (value: readonly string[]) => { state.secrets = [...value] },
    }])

    const listed = settings.list()[0]!
    expect(listed.value).toBeUndefined()
    // The registry's own reporting is the sink: nothing anywhere in what it hands back mentions the
    // value, because a surface that echoed a secret would breach invariant 3 one layer out.
    expect(JSON.stringify(settings.list())).not.toContain('one')

    const outcome = settings.apply('realtime-responder.redactSecrets', JSON.stringify([planted]))
    expect(outcome).toEqual({ ok: true, key: 'realtime-responder.redactSecrets', value: undefined })
    expect(JSON.stringify(outcome)).not.toContain('sentinelmustneverappear')
    // It still applied: write-only, not unchangeable.
    expect(state.secrets).toEqual([planted])
    expect(JSON.stringify(settings.list())).not.toContain('sentinelmustneverappear')
  })
})
