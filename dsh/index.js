/**
 * The bundle's host half.
 *
 * This package is a **bundle**: its `cordis.patch.yml` inserts the plugin rows, and those rows name
 * the three packages rather than this one. So nothing in a normal profile imports this module — it
 * exists so the package is loadable, and so a Node consumer can reach the seam and the adapters
 * without having to know how the work is split across packages.
 *
 * Deliberately re-exports rather than re-implements. There is exactly one implementation of each, and
 * a copy here would be a second one.
 *
 * Namespaced rather than flat: `dsh-realtime-openai` and `dsh-realtime-replay` both export a `Config`,
 * so a flat `export *` from both would make that name ambiguous and silently drop it.
 */

export * as realtime from 'dsh-realtime'
export * as openaiLive from 'dsh-realtime-openai'
export * as realtimeReplay from 'dsh-realtime-replay'

/** The seam's service class, re-exported for convenience — the common import. */
export { default as RealtimeRuntime } from 'dsh-realtime'
