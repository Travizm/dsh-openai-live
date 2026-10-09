# Contributing

Thanks for looking. This is a small project with an unusually strict gate, so this file is mostly
about what the gate will ask of you.

## Getting set up

```bash
pnpm install
pnpm gate      # build → typecheck (src AND tests) → coverage gate → built-artifact smoke
```

Requires Node `^22.19.0 || >=24.0.0` and pnpm 11.

`pnpm canary` runs the live drift check. It needs `OPENAI_LIVE_API_KEY` and **self-skips without one**,
so you never need a credential to contribute.

## The gate is the contract

**Per-file 100% statements, branches, functions and lines** on `packages/*/src`. Enforced with
`perFile: true`, not reported.

Before you add a test to reach a number, check what the uncovered line *is*. Most of the time it is a
defensive arm that cannot execute — an `?? ''` fallback on an index that is always in range, a `typeof`
check for a value the transport never produces — and the right change is to **delete it** rather than
write a spec that pretends to reach it. If a branch really is unreachable, removing it is the fix.

Two non-unit tiers are required and a change cannot skip them:

1. **The real-composition test** boots a test-only `cordis.yml` through the actual Loader, so service
   dependencies resolve through the composition rather than through a test's wiring. Hand-built
   `ctx.plugin(...)` suites are explicitly insufficient for a product-visible plugin.
2. **The built-artifact smoke** (`scripts/built-composition.mjs`) runs under plain `node` against the
   built `lib/`, with real module resolution. tsx and vitest both mask resolution, interop and settle
   failures that this catches — it has already caught one.

## Rules that are enforced, not stylistic

- **Registrations are effects.** Every contribution goes through `ctx.effect()`, and a `register()`
  must return a disposer.
- **Secrets are cordis-native.** Take credentials as validated `Config` fields and let the composition
  supply them. Reading an ad-hoc key file in code is out of bounds.
- **The export form is a Loader contract.** A *service* package default-exports its class and has no
  `apply`; a *function* plugin named-exports `name` / `inject` / `Config` / `apply` and must have **no
  default export**. Mixing them makes the Loader discard the plugin's namespace — it loads and
  contributes nothing.
- **When the provider owns turn detection, do not hand-roll VAD.** Measured, VAD-only interruption
  handling misfires on a majority of backchannels.
- **Dead defensive arms are deleted, not tested around.**

## Tests

- **Never commit a spec you cannot trigger deterministically.** If a branch needs an event you cannot
  produce on demand, delete the spec and assert the reachable sibling, leaving a comment that names
  what is untested and which case covers it. A spec that passes only sometimes is a defect in the spec.
- **A guard only guards if the regression fails it.** After adding one, introduce the regression, watch
  it go red, then revert.
- **Internalise intermittent noise as a real defect.** An occasional `Errors 1 error` while every test
  passes means a resource is outliving its operation — typically a timer armed before the operation it
  bounds.

## Releasing, and refreshing the app

Two operations have their own runbooks, because both have gone wrong once and both are hard to undo:

- **[`docs/releasing.md`](docs/releasing.md)** — publish order, the 0.x **range** check, publishing
  through pnpm (never npm), and what to do when a broken version reaches the registry.
- **[`docs/refresh-the-app-profile.md`](docs/refresh-the-app-profile.md)** — update vs uninstall, the
  profile's own patch layer that outranks the bundle, and the restart that actually loads it.

## Commits and pull requests

Write the **reasoning** in the commit body: what was wrong, what was measured, what the alternative
was. A commit that says what changed but not why is a commit the next person has to re-derive.

- Keep a pull request to one concern.
- Say plainly what you did **not** verify. An honest gap is useful; a confident guess is not.
- If a claim cannot be backed by tool output, either measure it or mark it as unverified.

## Licence

By contributing you agree your contribution is licensed under the MIT licence in `LICENSE`.
