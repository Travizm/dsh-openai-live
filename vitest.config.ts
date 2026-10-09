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
 * The coverage target is the harness's own: per-file 100% on `packages/*​/src`. It is ENFORCED, not
 * merely reported — a half-built package must read as unfinished rather than as a passing suite, and
 * a threshold nobody fails is not a gate.
 */
export default defineConfig({
  resolve: {
    alias: {
      'dsh-realtime-agent': pkg('./packages/realtime-agent/src/index.ts'),
      'dsh-realtime-responder': pkg('./packages/realtime-responder/src/index.ts'),
      'dsh-realtime-audio-ws': pkg('./packages/realtime-audio-ws/src/index.ts'),
      'dsh-realtime-openai': pkg('./packages/realtime-openai/src/index.ts'),
      'dsh-realtime-replay': pkg('./packages/realtime-replay/src/index.ts'),
      'dsh-realtime': pkg('./packages/realtime/src/index.ts'),
    },
  },
  test: {
    // Package tests, plus the bundle's own composition tests. A failure that only exists *between*
    // packages — one key escaping through three sinks — has no package to live in, and the bundle is
    // the project that depends on all of them.
    include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/types.ts'],
      reporter: ['text', 'json-summary', 'json'],
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
