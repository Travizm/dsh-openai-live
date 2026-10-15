/**
 * The `realtime/change` session event, declared on the session's own event map.
 *
 * ## Why this file has to exist
 *
 * `Session.append` is typed
 * `append<T extends SessionEventType>(type: T, data: SessionEventMap[T], …)` — the map is
 * **key-constrained**, so a new event type is a merged declaration and not merely a string you pass. That is
 * a genuinely different shape from the message source: `MessageSourceMap.plugin` is a general string field,
 * so `{ kind: 'plugin', plugin: 'realtime' }` costs nothing, while this **does** need a declaration. The two
 * maps differ in that way and the distinction is easy to miss, so it is written down here at the point it
 * bites.
 *
 * The pattern is `dsh-schedule`'s, at `lib/types/types.d.ts:172`:
 *
 * ```ts
 * declare module '@deepseek-ai/dsh-session/types' {
 *   interface SessionEventMap { 'schedule/change': ScheduleChange }
 * }
 * ```
 *
 * ## It is load-bearing, not ceremony
 *
 * {@link DeliveryAgent}'s `session` is typed `Pick<Session, 'append'>` rather than a hand-narrowed shape, so
 * removing this declaration is a **compile error at the append call site** rather than a silent hole in the
 * durable log. A declaration nothing consumes would be the decoration the plugin skill warns about; this one
 * is what the call site typechecks against.
 *
 * @module dsh-realtime-responder/change
 */

import type { RealtimeChange } from './deliver.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One delivery the voice made into this session.
     *
     * Written between the message and the durability barrier, so a reader reconstructing "what did the
     * voice put in here, and is it durable?" finds the claim and the message it describes as one pair
     * rather than having to infer one from the other.
     */
    'realtime/change': RealtimeChange
  }
}
