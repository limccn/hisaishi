import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // F1 writes to a real SQLite file (node:sqlite is not mocked here), so
    // tests share a filesystem. Keep files sequential to avoid one test's
    // temp DB colliding with another's.
    fileParallelism: false,
    setupFiles: ['./test/setup-wrangler-smoke.ts'],
  },
});
