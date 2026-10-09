/**
 * The control channel: verbs, sent as text frames on the socket that already carries audio.
 *
 * Until this module there was no way to drive the plugin without a console. The socket was duplex and
 * carried PCM16 in both directions, and a text frame was explicitly *not* part of its contract; the
 * client half published itself on a `globalThis` key and that global was the on-switch. Two restarts
 * and a false lead went into changing which session the voice steered, because the config was read at
 * boot and only at boot.
 *
 * So this is a deliberate widening of a documented contract, and it is written as a **channel** rather
 * than as a second API: one text frame in, exactly one text frame out, on the socket the client already
 * holds.
 *
 * Five properties are load-bearing.
 *
 * - **Every frame is answered.** A control frame the channel cannot parse is answered with the reason,
 *   not dropped — the same rule `set` follows one layer down. A channel that reports nothing is
 *   indistinguishable from one that never received the frame.
 * - **The reply is JSON, and small.** It carries the values a status surface needs and no prose to
 *   parse: `ok`, the verb as it was sent, and the fields for that verb.
 * - **`steer` is a resolution, not a special case.** The verb addresses whichever plugin declares a live
 *   `sessionId`; it refuses with a reason rather than guessing when none or several do.
 * - **`set` goes through the settings surface and nowhere else**, so a change on this channel takes the
 *   identical path — same parse, same refusal, same journal entry — as one from any other control plane.
 * - **The verb vocabulary is closed.** A typo answers with the verbs that exist, because a silent
 *   fall-through is how a user concludes the feature is missing.
 *
 * @module dsh-realtime-audio-ws/control
 */

import type { Journal, JournalEntry, RealtimeSettingInfo, RealtimeSettingRefusalCode, RealtimeSettings } from 'dsh-realtime'
import { redact } from 'dsh-realtime'
import type { RealtimeSessionRefusal, RealtimeSessionRequestOutcome, RealtimeVoiceStatus } from 'dsh-realtime-agent'

/** The verbs this channel answers. Closed on purpose: see the module note. */
export type ControlVerb = 'status' | 'start' | 'stop' | 'steer' | 'set'

/**
 * Why a control frame was refused.
 *
 * The three settings codes are carried through unchanged, because they are the seam's vocabulary and a
 * client should branch on one set of codes rather than on a translation of them.
 */
export type ControlRefusalCode =
  /** The first word is not a verb this channel has. */
  | 'UNKNOWN_VERB'
  /** The frame is malformed: a missing argument, an unexpected one, or a `set` with no `=`. */
  | 'INVALID_CONTROL'
  /** `steer` found no plugin declaring a live `sessionId`. */
  | 'NO_STEER_TARGET'
  /** `steer` found more than one, so the key to change is the caller's to name. */
  | 'AMBIGUOUS_STEER_TARGET'
  /** The verb could not be carried out at all — nothing answered a query it needs, or it threw. */
  | 'CONTROL_FAILED'
  /** No setting is registered under that key. */
  | Extract<RealtimeSettingRefusalCode, 'UNKNOWN_SETTING'>
  /** The setting exists and its class cannot honour a change: it needs a reconnect, or a restart. */
  | Extract<RealtimeSettingRefusalCode, 'FROZEN_SETTING'>
  /** The value did not parse, or the setting's own rules rejected it. */
  | Extract<RealtimeSettingRefusalCode, 'INVALID_SETTING'>

/** One parsed control frame. */
export type ControlCommand =
  | { readonly ok: true; readonly verb: 'status' | 'start' | 'stop' }
  | { readonly ok: true; readonly verb: 'steer'; readonly sessionId: string }
  | { readonly ok: true; readonly verb: 'set'; readonly key: string; readonly value: string }
  | { readonly ok: false; readonly verb: string; readonly code: ControlRefusalCode; readonly reason: string }

/** A refusal, as any verb can produce one. */
export interface ControlRefusedReply {
  readonly ok: false
  /** The verb as it was sent — including a word that is not a verb, so a client can pair the reply. */
  readonly verb: string
  readonly code: ControlRefusalCode
  readonly reason: string
  /** The setting a `steer` or `set` addressed, when one was addressed. */
  readonly key?: string
}

/** `status`: what this route is carrying, what the voice is doing, and what a change can reach. */
export interface ControlStatusReply {
  readonly ok: true
  readonly verb: 'status'
  /** This route's own facts. */
  readonly audio: { readonly path: string; readonly clients: number }
  /**
   * The voice session's state, or `null` when **no plugin answered the query** — which is what a
   * composition with no agent row looks like, and is deliberately not the same as a session that is
   * merely closed (that answers `open: false`).
   */
  readonly voice: RealtimeVoiceStatus | null
  /** Every setting the running plugins declare, in registration order, with the values read now. */
  readonly settings: readonly RealtimeSettingInfo[]
  /** The journal's size and its last entry — enough to see that *something* just happened. */
  readonly journal: { readonly size: number; readonly oldestSeq: number | undefined; readonly last: JournalEntry | null }
}

/** `start` / `stop`: what the request produced, not merely that it was made. */
export interface ControlSessionReply {
  readonly ok: boolean
  readonly verb: 'start' | 'stop'
  /** The state **after** the attempt. */
  readonly voice: RealtimeVoiceStatus
  /** Present when the request did not achieve what it asked for. */
  readonly refusal?: RealtimeSessionRefusal
}

/** `set` / `steer`: the change that landed, and the value the setting now holds. */
export interface ControlSettingReply {
  readonly ok: true
  readonly verb: 'set' | 'steer'
  readonly key: string
  /** What the setting is now — re-read from its owner, and `undefined` when the setting is write-only. */
  readonly value: unknown
}

/** What one control frame produced. */
export type ControlReply = ControlRefusedReply | ControlStatusReply | ControlSessionReply | ControlSettingReply

/** What {@link createControlHandler} needs from the plugin that owns the route. */
export interface ControlDeps {
  /** The seam's settings surface: the only path a change takes. */
  readonly settings: Pick<RealtimeSettings, 'list' | 'apply'>
  /** The seam's journal, for the size and the last entry a status reports. */
  readonly journal: Pick<Journal, 'snapshot'>
  /** This route's own pathname, reported as-is. */
  readonly path: string
  /** How many audio sockets this route is carrying right now. */
  readonly clients: () => number
  /**
   * The voice session's state.
   *
   * `undefined` means nothing answered; a rejection means something answered badly, and the two are kept
   * apart — the first is a composition without the agent, the second is a finding.
   */
  readonly voice: () => Promise<RealtimeVoiceStatus | undefined>
  /** Run one of the two session requests the transport already makes. */
  readonly request: (verb: 'start' | 'stop') => Promise<RealtimeSessionRequestOutcome | undefined>
}

/** The verbs, as a value, so an unknown one can be answered with the list. */
const VERBS: readonly ControlVerb[] = Object.freeze(['status', 'start', 'stop', 'steer', 'set'])

/**
 * Read one text frame as a control command.
 *
 * A control frame is a **line**, so its line ending is stripped and nothing else is: `set x= 5` and
 * `set x=5` are two different requests, and a channel that normalised one into the other would apply a
 * change the caller did not ask for. For the same reason the verbs are matched exactly — an `INVALID_CONTROL`
 * for `STATUS` is a better answer than a guess about intent, because it can be read and fixed.
 *
 * @param frame - the frame as it arrived, without its line ending.
 * @returns the command, or a refusal naming the frame's fault.
 */
export function parseControlFrame(frame: string): ControlCommand {
  // The line ending and leading whitespace are the only things stripped: a control frame is a line, and a
  // shell or a console may well hand over a leading space. Everything after the first `=` is left
  // untouched, because `set x= 5` and `set x=5` are two different requests and a channel that normalised
  // one into the other would apply a change the caller did not ask for.
  const line = frame.replace(/[\r\n]+$/u, '').trimStart()
  const split = line.search(/\s/u)
  const verb = split < 0 ? line : line.slice(0, split)
  const tail = split < 0 ? '' : line.slice(split)

  const known = VERBS.find(candidate => candidate === verb)
  if (known === undefined) {
    return {
      ok: false,
      verb,
      code: 'UNKNOWN_VERB',
      reason: `"${verb}" is not a control verb — this channel answers ${VERBS.join(', ')}`,
    }
  }
  if (known === 'status' || known === 'start' || known === 'stop') {
    if (tail.trim() !== '') {
      return { ok: false, verb: known, code: 'INVALID_CONTROL', reason: `"${known}" takes no argument, received ${quote(tail.trim())}` }
    }
    return { ok: true, verb: known }
  }
  if (known === 'steer') {
    const sessionId = tail.trim()
    if (sessionId === '') {
      return { ok: false, verb: known, code: 'INVALID_CONTROL', reason: '"steer" needs the session id to steer at' }
    }
    return { ok: true, verb: known, sessionId }
  }
  // `set`: the key ends at the **first** `=`, and the value is everything after it. A value is allowed to
  // contain `=` — and a split on the last one would silently cut a session id in half.
  const argument = tail.trimStart()
  const equals = argument.indexOf('=')
  const key = equals < 0 ? '' : argument.slice(0, equals).trim()
  if (equals < 0 || key === '') {
    return { ok: false, verb: known, code: 'INVALID_CONTROL', reason: '"set" needs <key>=<value>' }
  }
  return { ok: true, verb: known, key, value: argument.slice(equals + 1) }
}

/**
 * Build the channel's handler.
 *
 * The returned function is **total**: every frame it is given produces exactly one reply string, and it
 * never rejects. That is a contract, not a hope — the caller writes the reply into a socket and has no
 * one to catch a rejection, and a control frame that produces nothing at all is the silence this
 * project keeps having to pay for.
 *
 * @param deps - the settings surface, the request edges, and this route's own facts.
 * @returns a handler taking one frame and answering with the reply to send.
 */
export function createControlHandler(deps: ControlDeps): (frame: string) => Promise<string> {
  return async (frame: string): Promise<string> => {
    try {
      return encode(await dispatch(deps, frame))
    } catch (error) {
      // Reachable through any of the deps, not just the obvious one: a status query that throws, a
      // count that throws. Refused rather than swallowed, because the alternative is a client waiting
      // for an answer that will never come.
      return encode({
        ok: false,
        verb: '',
        code: 'CONTROL_FAILED',
        reason: `the control handler failed: ${classOf(error)}`,
      })
    }
  }
}

/**
 * Carry out one frame's command.
 * @param deps - the handler's dependencies.
 * @param frame - the frame as it arrived.
 * @returns the reply to send.
 */
async function dispatch(deps: ControlDeps, frame: string): Promise<ControlReply> {
  const command = parseControlFrame(frame)
  if (!command.ok) return command
  switch (command.verb) {
    case 'status': return await statusReply(deps)
    case 'start':
    case 'stop': return await sessionReply(deps, command.verb)
    case 'steer': return steer(deps, command.sessionId)
    case 'set': return change(deps, command.key, command.value, 'set')
  }
}

/**
 * Answer `status`.
 *
 * A status that quietly omitted whether voice is live would be the same class of report this project
 * exists to replace, so a query that *fails* refuses the whole verb: a partial status is indistinguishable
 * from a healthy one to whoever is reading it in a bug report.
 * @param deps - the handler's dependencies.
 * @returns the status, or the refusal explaining why there is none.
 */
async function statusReply(deps: ControlDeps): Promise<ControlReply> {
  let voice: RealtimeVoiceStatus | null
  try {
    voice = await deps.voice() ?? null
  } catch (error) {
    return {
      ok: false,
      verb: 'status',
      code: 'CONTROL_FAILED',
      reason: `the voice status query failed: ${classOf(error)}`,
    }
  }
  const entries = deps.journal.snapshot()
  return {
    ok: true,
    verb: 'status',
    audio: { path: deps.path, clients: deps.clients() },
    voice,
    settings: deps.settings.list(),
    journal: {
      size: entries.length,
      oldestSeq: entries[0]?.seq,
      last: entries.at(-1) ?? null,
    },
  }
}

/**
 * Answer `start` or `stop`.
 *
 * These produce an **outcome** rather than an acknowledgement, which is why the dispatch is `serial` and
 * not `emit`: "asked" and "it worked" are the two things this project has already collapsed once, in the
 * delegation path, at the cost of an evening.
 * @param deps - the handler's dependencies.
 * @param verb - which request to make.
 * @returns what the request produced.
 */
async function sessionReply(deps: ControlDeps, verb: 'start' | 'stop'): Promise<ControlReply> {
  let outcome: RealtimeSessionRequestOutcome | undefined
  try {
    outcome = await deps.request(verb)
  } catch (error) {
    return {
      ok: false,
      verb,
      code: 'CONTROL_FAILED',
      reason: `the ${verb} request failed: ${classOf(error)}`,
    }
  }
  if (outcome === undefined) {
    // No listener: the agent row is absent or has not loaded. Saying so is the difference between a
    // profile that is missing a row and a plugin that is broken.
    return {
      ok: false,
      verb,
      code: 'CONTROL_FAILED',
      reason: `nothing answered the ${verb} request — is a realtime agent mounted in this profile?`,
    }
  }
  return {
    ok: outcome.ok,
    verb,
    voice: outcome.voice,
    ...outcome.refusal === undefined ? {} : { refusal: outcome.refusal },
  }
}

/**
 * Resolve `steer <sessionId>` to a setting and change it.
 *
 * The verb names a *purpose* rather than a key, because the purpose is the thing a user has: "make the
 * voice talk to that session". Which key that is belongs to whichever plugin declares it, so this
 * resolves at the moment of use and refuses when the answer is not unique.
 * @param deps - the handler's dependencies.
 * @param sessionId - the session to steer at.
 * @returns the change's outcome, or the refusal explaining why there is no single target.
 */
function steer(deps: ControlDeps, sessionId: string): ControlReply {
  const targets = deps.settings
    .list()
    .filter(entry => entry.field === 'sessionId' && entry.scope === 'live' && entry.kind === 'string')
  const only = targets[0]
  if (only === undefined) {
    return {
      ok: false,
      verb: 'steer',
      code: 'NO_STEER_TARGET',
      reason: 'no plugin declares a live sessionId to steer — use set <key>=<value>',
    }
  }
  if (targets.length > 1) {
    return {
      ok: false,
      verb: 'steer',
      code: 'AMBIGUOUS_STEER_TARGET',
      reason: `${String(targets.length)} plugins declare a sessionId (${targets.map(entry => entry.key).join(', ')}) — use set <key>=<value>`,
    }
  }
  return change(deps, only.key, sessionId, 'steer')
}

/**
 * Apply one change through the settings surface.
 * @param deps - the handler's dependencies.
 * @param key - the `<owner>.<field>` key.
 * @param value - the value as text.
 * @param verb - which verb asked, so the reply can be paired with it.
 * @returns the change that landed, or the refusal with its reason.
 */
function change(deps: ControlDeps, key: string, value: string, verb: 'set' | 'steer'): ControlReply {
  const outcome = deps.settings.apply(key, value)
  if (!outcome.ok) {
    return { ok: false, verb, code: outcome.code, key: outcome.key, reason: outcome.reason }
  }
  return { ok: true, verb, key: outcome.key, value: outcome.value }
}

/**
 * Serialise one reply.
 * @param reply - the reply to send.
 * @returns the text frame.
 */
function encode(reply: ControlReply): string {
  return JSON.stringify(reply)
}

/**
 * Name a failure without repeating it.
 *
 * A class, never a message: the message is where a provider puts the key it refused, and this module
 * holds no credential to redact against.
 * @param error - whatever was thrown.
 * @returns the failure's class, or its type for a non-Error throw.
 */
function classOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/**
 * Quote part of a frame back, redacted and bounded.
 *
 * Redacted because the echo travels to whoever sent the frame and into whatever they render it in; a
 * caller that pasted a credential to the wrong verb should not have it handed back for display.
 * @param text - the text to quote.
 * @returns a short, safe quotation.
 */
function quote(text: string): string {
  return JSON.stringify(redact(text).slice(0, 40))
}
