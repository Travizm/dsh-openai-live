import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const pkg = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * One workspace-wide vitest config.
 *
 * Tests live at package level under `tests/`, never `src/__tests__/` — a DeepSeek Harness
 * convention, and the reason the include pattern is not the vitest default.
 *
 * `resolve.alias` keeps the test plane on **source**: without it, a workspace dependency resolves
 * through its package `exports` to built `lib/`, so the suite would test stale artifacts and load a
 * second copy of module singletons. The harness enforces the same rule via tsconfig paths.
 *
 * The coverage target matches the harness's: per-file 100% on `packages/*​/src`. Thresholds are
 * enforced once each package is complete, so a half-built package reads as unfinished rather than as
 * a passing suite.
 */
export default defineConfig({
  resolve: {
    alias: {
      'dsh-realtime': pkg('./packages/realtime/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/types.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
})
