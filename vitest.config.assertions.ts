import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// The system-level assertions of §14. They spawn real API and worker processes
// against real Postgres and Redis, so they share port 3000 and must not run
// concurrently with each other.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/assertions/**/*.spec.ts'],
    globalSetup: ['test/harness/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
