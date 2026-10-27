import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A hung test, hook or teardown fails fast instead of stalling the run.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    teardownTimeout: 15_000,
    // npm run bench; see docs/development.md.
    benchmark: {
      include: ['bench/**/*.bench.ts'],
      // Vitest warns when benchmarked code calls imported functions many times, as the connections search does: its
      // module runner reaches them through getters. Timed in plain Node against dist/, the search takes as long.
      suppressExportGetterWarnings: true,
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
