import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Requests to the real model, billed to the key in .env. Run only by hand
// (`npm run test:live`): never in CI, and never by the other commands.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/live/**/*.live-spec.ts'],
    testTimeout: 120_000,
  },
});
