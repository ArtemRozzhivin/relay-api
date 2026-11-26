import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.e2e-spec.ts'],
    env: {
      // Every file registers its accounts from one address, far past the
      // limits; the files that test the limits switch them back on.
      RATE_LIMITS: 'false',
      // Whatever .env names: no test pays for a request to a model.
      LLM_PROVIDER: 'fake',
    },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
