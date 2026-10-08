/**
 * Realtime voice seam: a provider registry plus the adapter base every voice backend extends.
 *
 * Exports the `RealtimeRuntime` service as the **default** export (a DeepSeek Harness convention for
 * service packages) and the abstract `RealtimeAdapter` for provider backends. Function plugins
 * must supply `name` / `inject` / `Config` / `apply` and no default export; this package is a
 * service package, so it is mounted as a class plugin and default-exports its service.
 *
 * @module dsh-realtime
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { REALTIME_ERROR_CODES, RealtimeError } from './error.ts'
import type {
  RealtimeDelegation,
  RealtimeModelInfo,
  RealtimeProviderInfo,
  RealtimeSession,
  RealtimeSessionHandlers,
  RealtimeSessionOptions,
} from './types.ts'

export * from './types.ts'
export * from './error.ts'
export * from './redact.ts'
export { RealtimeError, REALTIME_ERROR_CODES } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    realtime: RealtimeRuntime
  }
}

/**
 * What {@link RealtimeRuntime.registerAdapter} returns: the disposer, plus an atomic route
 * replacement for the same adapter instance.
 */
export interface AdapterRegistrationHandle {
  /** Release every route this registration currently holds. */
  (): void
  /**
   * Replace this registration's routes, keeping the same adapter instance. The candidate set is
   * validated in full first — a conflict with another registration or a malformed route throws and
   * leaves the current routes untouched — and the swap is one synchronous section, so no observer
   * can see the registry between release and re-registration.
   *
   * An empty array is legal here (a plugin whose configuration emptied holds zero routes while
   * staying registered), unlike an empty initial registration.
   *
   * Throws `REGISTRATION_DISPOSED` once the registration was released: its routes are gone and its
   * disposer has already run, so anything registered afterwards would have no owner left to release it.
   * @param providers - the complete next route set for this registration.
   */
  replace(providers: string[]): void
}

/**
 * Provider-wire adapter for the realtime session vocabulary.
 *
 * Register implementations with `ctx.realtime.registerAdapter(providers, adapter)`. The single
 * required method is {@link session}; every other method exists so a provider can describe itself
 * without the seam having to special-case it.
 */
export abstract class RealtimeAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose `id` must equal `provider`.
   */
  providerInfo(provider: string): RealtimeProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * List the voice models this adapter can currently advertise for one owned route.
   *
   * The result is advisory: an adapter may accept unlisted model ids, and consumers must not turn
   * absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly RealtimeModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * Open one voice session. The only required method.
   *
   * Implementations must honor `options.signal` during establishment, and must throw (rather than
   * resolve with a dead session) when the session cannot open.
   * @param options - the fully-resolved request; `options.provider` selects the registered route.
   * @returns the live session, with `options.handlers` already wired.
   */
  abstract session(options: RealtimeSessionOptions): Promise<RealtimeSession>
}

/** One resolved route registration. */
interface AdapterRegistration {
  readonly adapter: RealtimeAdapter
  readonly provider: RealtimeProviderInfo
}

/**
 * The `realtime` service: an adapter registry over the session vocabulary.
 *
 * Registration is effect-based, so HMR or a disposal unmounts routes with the contributing fiber —
 * there is no separate teardown path that can be forgotten.
 */
export class RealtimeRuntime extends Service {
  private readonly adapters = new Map<string, AdapterRegistration>()

  /**
   * @param ctx - the Cordis context this service is mounted on.
   */
  constructor(ctx: Context) {
    super(ctx, 'realtime')
  }

  /**
   * Register an adapter for the given provider routes, all-or-nothing.
   *
   * Disposed with the fiber. Throws `INVALID_PROVIDER` for a malformed route, `DUPLICATE_PROVIDER`
   * if any route is already held by another registration.
   * @param providers - every provider route this adapter should serve.
   * @param adapter - the adapter that opens sessions for those routes.
   * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
   */
  registerAdapter(providers: string[], adapter: RealtimeAdapter): AdapterRegistrationHandle {
    if (providers.length === 0) {
      throw new RealtimeError('an adapter must register at least one provider', REALTIME_ERROR_CODES.INVALID_PROVIDER)
    }
    // Routes this registration currently holds; `replace` rewrites it, and the disposer releases
    // whatever it holds at disposal time.
    const owned = new Set<string>()
    // `owned` being empty cannot report disposal on its own, because `replace([])` legally leaves a
    // live registration holding none.
    let released = false

    const dispose = this.ctx.effect(function* (this: RealtimeRuntime) {
      this.commit(owned, this.prepare(providers, adapter, owned))
      yield () => {
        released = true
        for (const provider of owned) this.adapters.delete(provider)
        owned.clear()
      }
    }.bind(this), 'realtime.registerAdapter()')

    const handle = (() => void dispose()) as AdapterRegistrationHandle
    handle.replace = (next: string[]): void => {
      // Registering here would leak: the effect's disposer already ran, so nothing remains to
      // release whatever this call would put in the map.
      if (released) {
        throw new RealtimeError(
          'a disposed adapter registration cannot replace its routes',
          REALTIME_ERROR_CODES.REGISTRATION_DISPOSED,
        )
      }
      this.commit(owned, this.prepare(next, adapter, owned))
    }
    return handle
  }

  /**
   * Validate one candidate route set for `adapter`, treating routes this registration already holds
   * as available.
   *
   * Nothing is mutated: a rejected candidate leaves the registry exactly as it was, which is what
   * makes {@link AdapterRegistrationHandle.replace} a swap rather than a delete-then-add that can
   * strand the registry empty.
   * @param providers - candidate routes.
   * @param adapter - the adapter that would own them.
   * @param owned - routes this same registration already holds.
   * @returns registrations ready to commit.
   */
  private prepare(providers: string[], adapter: RealtimeAdapter, owned: ReadonlySet<string>): AdapterRegistration[] {
    const unique = new Set<string>()
    const registrations: AdapterRegistration[] = []
    for (const provider of providers) {
      if (typeof provider !== 'string' || provider.length === 0) {
        throw new RealtimeError('adapter provider names must be non-empty strings', REALTIME_ERROR_CODES.INVALID_PROVIDER)
      }
      if (unique.has(provider) || (this.adapters.has(provider) && !owned.has(provider))) {
        throw new RealtimeError(
          `an adapter for provider "${provider}" is already registered`,
          REALTIME_ERROR_CODES.DUPLICATE_PROVIDER,
        )
      }
      const info = adapter.providerInfo(provider)
      if (typeof info.id !== 'string' || info.id !== provider
        || typeof info.name !== 'string' || info.name.length === 0) {
        throw new RealtimeError(
          `adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`,
          REALTIME_ERROR_CODES.INVALID_PROVIDER,
        )
      }
      unique.add(provider)
      registrations.push({
        adapter,
        provider: info.description === undefined
          ? { id: info.id, name: info.name }
          : { id: info.id, name: info.name, description: info.description },
      })
    }
    return registrations
  }

  /**
   * Swap this registration's routes for the prepared ones in one synchronous section, so no
   * observer can see the registry between the release and the re-registration.
   * @param owned - mutable set tracking which routes this registration holds.
   * @param registrations - validated registrations to install.
   */
  private commit(owned: Set<string>, registrations: readonly AdapterRegistration[]): void {
    for (const provider of owned) this.adapters.delete(provider)
    owned.clear()
    for (const registration of registrations) {
      this.adapters.set(registration.provider.id, registration)
      owned.add(registration.provider.id)
    }
  }

  /**
   * Describe the provider routes that currently have an adapter.
   * @returns detached provider metadata in registration order.
   */
  listProviders(): RealtimeProviderInfo[] {
    return [...this.adapters.values()].map(({ provider }) => ({ ...provider }))
  }

  /**
   * Resolve the adapter owning one route.
   * @param provider - registered route to look up.
   * @returns that route's registration.
   * @throws RealtimeError `NO_ADAPTER` when the route is unregistered.
   */
  private registration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (registration === undefined) {
      throw new RealtimeError(`no realtime adapter registered for provider "${provider}"`, REALTIME_ERROR_CODES.NO_ADAPTER)
    }
    return registration
  }

  /**
   * Discover the voice models one registered route advertises.
   * @param provider - registered route to inspect.
   * @returns detached model metadata in adapter-preferred order, duplicates removed.
   */
  async listModels(provider: string): Promise<RealtimeModelInfo[]> {
    const models = await this.registration(provider).adapter.listModels(provider)
    const seen = new Set<string>()
    const detached: RealtimeModelInfo[] = []
    for (const model of models) {
      if (typeof model.id !== 'string' || model.id.length === 0 || seen.has(model.id)) continue
      seen.add(model.id)
      detached.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
        ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
        ...model.outputModalities === undefined ? {} : { outputModalities: [...model.outputModalities] },
      })
    }
    return detached
  }

  /**
   * Open one voice session through the adapter registered for its route.
   *
   * A field this seam cannot honor is rejected here rather than forwarded as a no-op — the caller
   * learns the request is unsupported before a live conversation depends on it.
   * @param options - the session request; `options.provider` selects the adapter.
   * @returns the adapter's live session.
   * @throws RealtimeError `NO_ADAPTER` for an unregistered route.
   */
  async session(options: RealtimeSessionOptions): Promise<RealtimeSession> {
    if (typeof options.provider !== 'string' || options.provider.length === 0) {
      throw new RealtimeError('a session needs a non-empty provider route', REALTIME_ERROR_CODES.INVALID_PROVIDER)
    }
    if (typeof options.model !== 'string' || options.model.length === 0) {
      throw new RealtimeError('a session needs a non-empty model id', REALTIME_ERROR_CODES.INVALID_PROVIDER)
    }
    if (options.instructions !== undefined && options.instructions.length === 0) {
      throw new RealtimeError('session instructions must be non-empty when supplied', REALTIME_ERROR_CODES.INVALID_APPEND)
    }
    if (options.signal?.aborted) {
      throw new RealtimeError('session establishment was aborted before it started', REALTIME_ERROR_CODES.SESSION_CLOSED, {
        cause: options.signal.reason,
      })
    }
    return await this.registration(options.provider).adapter.session(options)
  }

  /**
   * Validate one context append against the seam's bounds.
   *
   * Exposed so an adapter can enforce the same bound the seam promises, instead of each backend
   * re-deriving it. Bound enforcement lives at the operation that makes the decision: a caller that
   * bypasses this cannot silently send an over-long append.
   * @param content - candidate append text.
   * @param maxChars - character ceiling; defaults to the provider's documented bound.
   * @returns the content unchanged, for convenient inline use.
   * @throws RealtimeError `INVALID_APPEND` for a non-string, empty, or over-long value.
   */
  static assertAppendable(content: string, maxChars: number): string {
    if (typeof content !== 'string' || content.length === 0) {
      throw new RealtimeError('an append needs non-empty content', REALTIME_ERROR_CODES.INVALID_APPEND)
    }
    if (content.length > maxChars) {
      throw new RealtimeError(
        `an append of ${content.length} characters exceeds the ${maxChars}-character seam bound`,
        REALTIME_ERROR_CODES.INVALID_APPEND,
      )
    }
    return content
  }
}

/** Re-exported so adapters can type their handler wiring without a second import. */
export type { RealtimeDelegation, RealtimeSessionHandlers }

export default RealtimeRuntime
