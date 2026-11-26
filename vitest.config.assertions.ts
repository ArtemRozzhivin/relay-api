import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// The system-level assertions of §14. They spawn real API and worker processes
// against real Postgres, Redis and the S3 dev bucket, and every worker consumes
// the one shared queue, so the files must not run concurrently with each other.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/assertions/**/*.spec.ts'],
    env: {
      // Every file registers its accounts from one address, far past the
      // limits, which the integration tests cover.
      RATE_LIMITS: 'false',
      // Whatever .env names: no test pays for a request to a model.
      LLM_PROVIDER: 'fake',
    },
    globalSetup: ['test/harness/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
