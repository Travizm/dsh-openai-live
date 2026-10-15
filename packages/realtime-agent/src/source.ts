/**
 * The source a voice message carries, and the declaration that makes it usable here.
 *
 * ## Why this declaration has to exist
 *
 * `MessageSourceMap` is **merge-extensible by design** — a producer declares its own source kind rather
 * than riding someone else's — and this is that declaration, in the package that already speaks the agent
 * protocol.
 *
 * It is needed because **the published line lags the runtime line, and the difference is a capability
 * rather than a version.** Measured:
 *
 * | tree | `MessageSourceMap` keys |
 * |---|---|
 * | runtime `0.1.5-rc.2` (the local checkout the plugin resolves from) | `user, plugin, model, tool` |
 * | npm `0.1.7-rc.2` (the nearest installable) | `user, model, tool, 'system-prompt'` |
 *
 * The general `plugin` kind — the one `dsh-schedule` writes, and the one the runtime honours — is **absent
 * from the only version npm will give us**, and `0.1.5-rc.2` is unpublished. So a message carrying a
 * `plugin` source cannot be constructed against the registry at all: `tsc` rejects it at the
 * `createUserMessage` call site.
 *
 * The two honest ways out are to take the constructor from outside the plugin, or to state the runtime's
 * shape here. **This is both**: the construction lives in this package rather than in the responder, and
 * the shape it needs is declared rather than assumed. What is deliberately *not* done is a cast — a cast
 * would hide exactly the divergence that would then bite at runtime, and the failure would arrive as a
 * session that rejected a message nobody could explain.
 *
 * ## The shape
 *
 * `{ kind: 'plugin', plugin: string }`, with the plugin named — the general kind, so no new key is invented
 * and any harness that understands `plugin` understands this message. Not `& ContextFormed`: the runtime
 * declares that intersection, and the extra fields are optional-shaped so a producer that sets none is
 * still valid. At runtime the harness's own declaration is what applies; this is the compile-time half of
 * the same fact.
 *
 * @module dsh-realtime-agent/source
 */

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    /** A message produced by a plugin, named. The general kind, used by `dsh-schedule` and here. */
    plugin: { kind: 'plugin'; plugin: string }
  }
}

/** The plugin name this bundle writes under, as it appears in a message's source. */
export const VOICE_PLUGIN = 'realtime'

/**
 * The source every voice message carries.
 *
 * Frozen, because it describes who wrote a message that is already in a durable log: the same message can
 * be re-read long after the fact, and a mutable source would let its provenance be rewritten after the
 * event — the one field that must be immutable for the record to mean anything.
 */
export const VOICE_SOURCE: { readonly kind: 'plugin'; readonly plugin: string } =
  Object.freeze({ kind: 'plugin', plugin: VOICE_PLUGIN })
