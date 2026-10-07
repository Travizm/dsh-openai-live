import { defineConfig } from 'vitest/config'

/**
 * One workspace-wide vitest config.
 *
 * Tests live at package level under `tests/`, never `src/__tests__/` — a DeepSeek Harness
 * convention, and the reason the include pattern is not the vitest default.
 *
 * The coverage target for this repo is the same as the harness's: per-file 100% on
 * `packages/*​/src`. Thresholds are enforced once each package is complete, so that a
 * half-built package reads as unfinished rather than as a passing suite.
 */
export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/types.ts'],
      all: true,
      reporter: ['text', 'json-summary'],
    },
  },
})
