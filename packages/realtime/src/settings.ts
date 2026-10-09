/**
 * The settings surface: what a running plugin's settings are, and which of them a change can reach.
 *
 * `docs/control-plane-fields.md` is the design gate, and it classifies every field into one of three
 * classes: **live** (read at the moment of use, so a change takes effect then), **session-bound** (it
 * travelled in the provider's `session.start`, so only a new session can carry a new value) and
 * **restart-bound** (claimed once against the web server's registry or enforced by the socket). This
 * module is that classification in code, because a classification that lives only in prose cannot
 * refuse anything: the design rule is *an affordance the protocol cannot honour is worse than no
 * affordance*, and the only way to honour it is for the surface to know a setting's class and answer a
 * change with the reason instead of applying it.
 *
 * Four properties are load-bearing, and each is a test rather than a promise:
 *
 * - **The value is read at the moment of use, from the plugin that owns it.** A setting holds a
 *   `get()`, and the consumer calls it where it acts — not a copy taken at apply time. That is what
 *   makes the change take effect on the next use, and it is why a stale copy is impossible rather than
 *   merely discouraged.
 * - **A change is refused with a reason on the same channel it arrived on.** Unknown key, a class that
 *   cannot honour a change, a value that does not parse, a setter that rejects one — four different
 *   reasons, because they call for four different responses and collapsing them is the failure this
 *   project has already paid for once (see `realtime-responder/src/turn.ts`).
 * - **A secret setting is write-only.** `redactSecrets` holds values that must never be spoken,
 *   journalled or handed to a page; a surface that echoed them back through `status` or a `set`
 *   outcome would breach `design.md` invariant 3 one layer out. A setting declared `secret` reports no
 *   value at all.
 * - **Registration is a contract, checked at registration.** The declared `kind` must match what
 *   `get()` actually returns, and only a `live` setting may have a setter — so a setting that would
 *   render the wrong control, or claim a change it cannot apply, fails where it is declared rather
 *   than in a user's session.
 *
 * @module dsh-realtime/settings
 */

import { REALTIME_ERROR_CODES, RealtimeError } from './error.ts'
import type { Journal } from './journal.ts'
import { redact } from './redact.ts'

/**
 * How a setting's value is represented.
 *
 * The kind is what a text channel parses by and what a control renders for, so it is declared rather
 * than inferred: a `number` setting and a `string` setting whose values happen to look alike are
 * different controls and different refusals.
 */
export type RealtimeSettingKind = 'string' | 'number' | 'boolean' | 'string-list'

/** The three classes of `docs/control-plane-fields.md`, in code. */
export type RealtimeSettingScope = 'live' | 'session' | 'restart'

/** Machine codes a refused change carries. Branch on the code, never on the reason's prose. */
export type RealtimeSettingRefusalCode =
  /** No setting is registered under that key — usually a typo, and never a silent no-op. */
  | 'UNKNOWN_SETTING'
  /** The setting exists and its class cannot honour a change: it needs a reconnect, or a restart. */
  | 'FROZEN_SETTING'
  /** The value did not parse as the declared kind, or the owner's own validation rejected it. */
  | 'INVALID_SETTING'

/** One setting, as the plugin that owns it declares it. */
export interface RealtimeSettingSpec<T> {
  /**
   * The setting's name within its owner, e.g. `sessionId`. The registry's key is
   * `<owner>.<field>` — qualified, because two plugins may legitimately both hold a `sessionId` and a
   * bare name would make one of them unreachable.
   */
  readonly field: string
  /** How the value is represented on a text channel and in a control. */
  readonly kind: RealtimeSettingKind
  /** What a change to it would do. */
  readonly scope: RealtimeSettingScope
  /** One line for a status surface. Optional: the key is usually enough. */
  readonly describe?: string
  /**
   * Whether the value must never be reported back.
   *
   * True for a setting that holds secrets rather than a setting that needs one: the surface reports
   * `undefined` for the value and a change still applies. See the module note.
   */
  readonly secret?: boolean
  /** The value **now**. Called at the moment of use, never captured. */
  readonly get: () => T
  /**
   * Validate and apply a parsed value. Present exactly when the class is `live`.
   *
   * Declared as a **method**, not as a property holding a function, so a spec typed to its own value is
   * assignable to the erased form the registry stores: TypeScript checks a function-typed property
   * contravariantly, which would refuse `(value: string) => void` where `(value: unknown) => void` is
   * wanted and force every plugin to erase its own type at the call site. With a method signature the
   * parameter is bivariant, and inference of `T` from `get` is what types the parameter — so a plugin
   * writes the value's real type once and the surface accepts it.
   *
   * Throwing is the plugin's way to refuse a value its own rules reject (a non-empty id, a positive
   * budget). The message is carried back as the reason, so it should name the constraint rather than
   * repeat the value.
   * @param value - the value parsed from a text frame, already matching the declared `kind`.
   */
  set?(value: T): void
}

/** One setting as the surface reports it. Detached: mutating one cannot reach the registry. */
export interface RealtimeSettingInfo {
  /** `<owner>.<field>`, the key a change addresses. */
  readonly key: string
  /** The plugin that owns it, as it appears in Loader diagnostics. */
  readonly owner: string
  /** The setting's own name, for a control's label. */
  readonly field: string
  /** How the value is represented. */
  readonly kind: RealtimeSettingKind
  /** What a change to it would do. */
  readonly scope: RealtimeSettingScope
  /** The owner's one-line description, when it supplied one. */
  readonly describe?: string
  /**
   * The value now, or `undefined` when the setting is `secret`.
   *
   * Read through the owner's own `get()` at the moment the surface is asked, so it is what the plugin
   * would actually use — not a copy taken at registration.
   */
  readonly value: unknown
}

/** A change that was applied. */
export interface RealtimeSettingApplied {
  readonly ok: true
  /** The setting that changed. */
  readonly key: string
  /**
   * What the setting is **now**, re-read from its owner after the setter ran, and `undefined` for a
   * secret. A setter may clamp or normalise what it was handed, so the answer to "what did that
   * change?" is the value the plugin holds and not the value that was asked for.
   */
  readonly value: unknown
}

/** A change that was refused, with the reason to relay. */
export interface RealtimeSettingRefused {
  readonly ok: false
  /** The setting the change addressed, exactly as it was asked for. */
  readonly key: string
  /** Which class of refusal this is. */
  readonly code: RealtimeSettingRefusalCode
  /**
   * One line, written to be relayed **verbatim** to whoever made the change — the same rule the
   * controller's refusal follows one layer down. Redacted and bounded: it may echo a value the caller
   * sent, and a caller is not always the party that is allowed to see it.
   */
  readonly reason: string
}

/** What attempting a change produced. */
export type RealtimeSettingOutcome = RealtimeSettingApplied | RealtimeSettingRefused

/** The classes a setting may declare, for validating a caller that is not TypeScript. */
const SCOPES: readonly RealtimeSettingScope[] = Object.freeze(['live', 'session', 'restart'])

/** The kinds a setting may declare, for the same reason. */
const KINDS: readonly RealtimeSettingKind[] = Object.freeze(['string', 'number', 'boolean', 'string-list'])

/** Field names are dotted onto an owner, so they must be a single identifier-shaped word. */
const FIELD_SHAPE = /^[A-Za-z][A-Za-z0-9]*$/

/** Longest reason carried out of a refusal, so an owner's error cannot flood a status surface. */
const MAX_REASON_CHARS = 200

/** One registered setting. The spec, plus the identity the registry derives from it. */
interface RegisteredSetting {
  readonly key: string
  readonly owner: string
  readonly field: string
  readonly kind: RealtimeSettingKind
  readonly scope: RealtimeSettingScope
  readonly describe?: string
  readonly secret: boolean
  readonly get: () => unknown
  readonly set?: (value: unknown) => void
}

/**
 * The registry of settings a running plugin can be steered by.
 *
 * Owned by the seam, like the journal, and for the same reason: it is an object every plugin in the
 * bundle already holds, and a surface split across three of them would leave a reader — or a control
 * plane — correlating three partial answers to one question.
 *
 * Not a service and not tied to a Cordis context: a plain object, so it can be constructed in a test
 * and asked things without a harness. Registration returns a disposer rather than taking ownership of
 * one, so the *contributing* fiber is what releases a plugin's settings — call it inside
 * `ctx.effect`, exactly as a plugin registers a listener.
 */
export class RealtimeSettings {
  private readonly settings = new Map<string, RegisteredSetting>()

  /**
   * @param journal - the seam's journal. A successful change is recorded there as `config.changed`;
   *   see {@link apply} for what is deliberately not recorded.
   */
  constructor(private readonly journal: Pick<Journal, 'record'>) {}

  /**
   * Declare the settings one plugin owns, all-or-nothing.
   *
   * A malformed spec fails here rather than at the moment somebody tries to change it: the point of a
   * declared kind is that a control and a parser agree with the plugin's own type, and a setting whose
   * declaration does not match what it returns has neither.
   * @param owner - the plugin's name, as it appears in Loader diagnostics. Becomes the key's prefix.
   * @param specs - every setting this plugin declares.
   * @returns the disposer that releases them. Call it inside the contributing fiber's effect.
   * @throws RealtimeError `INVALID_SETTING` for a malformed owner, field, kind, scope or declaration.
   * @throws RealtimeError `DUPLICATE_SETTING` for a key another registration already holds.
   */
  register(owner: string, specs: readonly RealtimeSettingSpec<unknown>[]): () => void {
    if (typeof owner !== 'string' || owner.length === 0) {
      throw new RealtimeError('a settings owner must be a non-empty string', REALTIME_ERROR_CODES.INVALID_SETTING)
    }
    const prepared: RegisteredSetting[] = []
    const claimed = new Set<string>()
    for (const spec of specs) {
      const key = `${owner}.${String(spec.field)}`
      if (typeof spec.field !== 'string' || !FIELD_SHAPE.test(spec.field)) {
        throw new RealtimeError(
          `a setting's field must be identifier-shaped, received "${String(spec.field)}"`,
          REALTIME_ERROR_CODES.INVALID_SETTING,
        )
      }
      if (claimed.has(key) || this.settings.has(key)) {
        throw new RealtimeError(
          `a setting named "${key}" is already registered`,
          REALTIME_ERROR_CODES.DUPLICATE_SETTING,
        )
      }
      if (!SCOPES.includes(spec.scope)) {
        throw new RealtimeError(
          `"${key}" declared an unknown scope "${String(spec.scope)}"`,
          REALTIME_ERROR_CODES.INVALID_SETTING,
        )
      }
      if (!KINDS.includes(spec.kind)) {
        throw new RealtimeError(
          `"${key}" declared an unknown kind "${String(spec.kind)}"`,
          REALTIME_ERROR_CODES.INVALID_SETTING,
        )
      }
      // A change can only reach a `live` field, and only a `live` field has anything to apply it. Two
      // one-sided declarations, and both are refusals rather than warnings for the same reason: the
      // first would offer a control that silently does nothing, the second would answer a change by
      // doing nothing at all.
      if (spec.scope === 'live' && spec.set === undefined) {
        throw new RealtimeError(
          `"${key}" is live and must declare how a change is applied`,
          REALTIME_ERROR_CODES.INVALID_SETTING,
        )
      }
      if (spec.scope !== 'live' && spec.set !== undefined) {
        throw new RealtimeError(
          `"${key}" is ${spec.scope}-bound and cannot declare a setter`,
          REALTIME_ERROR_CODES.INVALID_SETTING,
        )
      }
      // Read once, at registration: the declared kind is a claim about what this setting *is*, and a
      // claim that does not hold here produces a control that shows the wrong thing for ever.
      const now = spec.get()
      if (!matchesKind(spec.kind, now)) {
        throw new RealtimeError(
          `"${key}" declares the kind "${spec.kind}" and returns ${describeValue(now)}`,
          REALTIME_ERROR_CODES.INVALID_SETTING,
        )
      }
      claimed.add(key)
      prepared.push({
        key,
        owner,
        field: spec.field,
        kind: spec.kind,
        scope: spec.scope,
        ...spec.describe === undefined ? {} : { describe: spec.describe },
        secret: spec.secret === true,
        get: spec.get,
        ...spec.set === undefined ? {} : { set: spec.set },
      })
    }
    for (const registered of prepared) this.settings.set(registered.key, registered)
    return () => {
      for (const registered of prepared) this.settings.delete(registered.key)
    }
  }

  /**
   * Every registered setting, in the order its plugins registered them.
   *
   * Registration order is composition order, which is what a status surface wants to show; sorting
   * would be deterministic and would also hide which plugin arrived first, which is exactly the thing
   * a reader is trying to work out when a row waits.
   * @returns detached descriptions, each with the value read now.
   */
  list(): RealtimeSettingInfo[] {
    return [...this.settings.values()].map(registered => this.describe(registered))
  }

  /**
   * Describe one setting.
   * @param key - `<owner>.<field>`.
   * @returns the description, or `undefined` when nothing is registered under that key.
   */
  get(key: string): RealtimeSettingInfo | undefined {
    const registered = this.settings.get(key)
    return registered === undefined ? undefined : this.describe(registered)
  }

  /**
   * Apply a change addressed as text, and say what happened.
   *
   * The one operation a control plane needs: it parses by the declared kind, refuses anything the
   * setting's class cannot honour, hands the value to the owner's own setter and reports the value the
   * owner now holds. A change that landed is journalled as `config.changed` **with its key and not its
   * value** — the value of a secret setting is precisely the text that must not be retained, and a
   * surface that journalled "the values it was given" would write them into the one record built to be
   * read and pasted.
   * @param key - the setting's `<owner>.<field>` key, exactly as {@link RealtimeSettingInfo.key} reports it.
   * @param text - the value as a text frame carries it.
   * @returns whether the change was applied, and either the value now or the reason it was refused.
   */
  apply(key: string, text: string): RealtimeSettingOutcome {
    const registered = this.settings.get(key)
    // Checked before the value is looked at: whether a setting can be changed at all is a property of
    // the setting, and answering a malformed value first would tell a caller to fix a typo in a number
    // where the real answer is that this field needs a restart.
    if (registered === undefined) {
      return this.refuse(key, 'UNKNOWN_SETTING', `no setting named "${key}" is registered`)
    }
    if (registered.scope !== 'live') return this.refuse(key, 'FROZEN_SETTING', frozenReason(registered))
    const parsed = parseValue(registered.kind, text)
    if (!parsed.ok) {
      return this.refuse(
        key,
        'INVALID_SETTING',
        `"${key}" expects a ${registered.kind}, received ${describeText(text)}`,
      )
    }
    try {
      registered.set?.(parsed.value)
    } catch (error) {
      // The owner's own rules — a non-empty session id, a positive budget — are the ones a caller can
      // act on, so its message is carried rather than replaced by a generic one.
      return this.refuse(key, 'INVALID_SETTING', `"${key}" refused the change: ${reasonOf(error)}`)
    }
    this.journal.record('config.changed', { key })
    return { ok: true, key, value: registered.secret ? undefined : registered.get() }
  }

  /**
   * Build one detached description, reading the value now.
   * @param registered - the stored setting.
   * @returns the description, with no value at all when the setting is secret.
   */
  private describe(registered: RegisteredSetting): RealtimeSettingInfo {
    return {
      key: registered.key,
      owner: registered.owner,
      field: registered.field,
      kind: registered.kind,
      scope: registered.scope,
      ...registered.describe === undefined ? {} : { describe: registered.describe },
      value: registered.secret ? undefined : registered.get(),
    }
  }

  /**
   * Build one refusal, redacted and bounded.
   * @param key - the setting the change addressed.
   * @param code - which class of refusal this is.
   * @param reason - the line to relay.
   * @returns the refusal to hand back.
   */
  private refuse(key: string, code: RealtimeSettingRefusalCode, reason: string): RealtimeSettingRefused {
    // The reason may quote the value the caller sent, and a caller is not always entitled to read it:
    // the shape arm runs over it, and the bound stops an owner's error message becoming the payload.
    return { ok: false, key, code, reason: redact(reason).slice(0, MAX_REASON_CHARS) }
  }
}

/**
 * Why a setting of this class cannot take a change, in the words the person making the change needs.
 *
 * The two classes are different instructions — one reconnect, one restart — and naming which is the
 * whole value of refusing rather than ignoring.
 * @param registered - the frozen setting.
 * @returns the reason.
 */
function frozenReason(registered: RegisteredSetting): string {
  return registered.scope === 'session'
    ? `"${registered.key}" is fixed when the voice session opens — reconnect to apply a new value`
    : `"${registered.key}" is claimed when the plugin loads — restart to change it`
}

/**
 * Does this value match the kind the setting declared?
 *
 * `get()` is the plugin's own, so the check costs nothing at runtime and catches the failure that
 * matters: a declaration that would render a control for one kind over a value of another.
 * @param kind - the declared kind.
 * @param value - what `get()` returned.
 * @returns whether they agree.
 */
function matchesKind(kind: RealtimeSettingKind, value: unknown): boolean {
  switch (kind) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'string-list': return Array.isArray(value) && value.every(entry => typeof entry === 'string')
  }
}

/**
 * Describe a value's shape, for a registration that declared the wrong kind.
 * @param value - whatever `get()` returned.
 * @returns a short description, never the value's content.
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/**
 * Parse one text value into the declared kind.
 *
 * `string` cannot fail — every text is a string — so an empty value is deliberately *not* refused here:
 * whether a particular string may be empty is the owner's rule, and it can say why. The other three
 * kinds have exactly one representation each, because an ambiguous parse is a change that applies
 * something the caller did not ask for.
 * @param kind - the setting's declared kind.
 * @param text - the value as it arrived.
 * @returns the parsed value, or that it did not parse.
 */
function parseValue(kind: RealtimeSettingKind, text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  switch (kind) {
    case 'string':
      return { ok: true, value: text }
    case 'number': {
      const trimmed = text.trim()
      if (trimmed.length === 0) return { ok: false }
      const value = Number(trimmed)
      return Number.isFinite(value) ? { ok: true, value } : { ok: false }
    }
    case 'boolean':
      if (text !== 'true' && text !== 'false') return { ok: false }
      return { ok: true, value: text === 'true' }
    case 'string-list': {
      // JSON, and only JSON: a list of secrets separated by commas cannot be split on a comma, and a
      // rule that guessed would silently drop half a secret from the redaction list.
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false }
      }
      if (!Array.isArray(parsed) || !parsed.every(entry => typeof entry === 'string')) return { ok: false }
      return { ok: true, value: parsed }
    }
  }
}

/**
 * Quote a received value back, redacted and bounded.
 *
 * Redacted because the echo travels to whoever asked and into whatever they render it in, and a caller
 * that sent a credential to the right route by mistake should not have it handed back for display.
 * @param text - the value as it arrived.
 * @returns a short, safe quotation of it.
 */
function describeText(text: string): string {
  return JSON.stringify(redact(text).slice(0, 40))
}

/**
 * The reason a setter refused, as a line to relay.
 *
 * A rejection that carries no message is still a rejection, and naming the absence is more useful than
 * an empty string that reads as "no reason".
 * @param error - whatever the setter threw.
 * @returns a non-empty reason.
 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return 'the setting declined the value'
}
