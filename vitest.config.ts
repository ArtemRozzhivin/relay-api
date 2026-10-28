import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    exclude: ['test/assertions/**', 'node_modules/**', 'dist/**'],

    // `include` alone decides what is reported in Vitest 4 (`all` was removed),
    // so untested files read as 0% rather than vanishing from the average.
    // There is deliberately no threshold here: the
    // reliability paths run in child processes, where V8 coverage cannot see
    // them, so a percentage gate would only reward mocking out the transaction
    // and queue behaviour that A1–A7 exist to exercise. See TECH_SPEC §15.1.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/generated/**',
        'src/main.ts',
        'src/worker.ts',
        'src/**/*.module.ts',
        'src/**/*.spec.ts',
        'src/**/*.fixture.ts',
      ],
      reporter: ['text-summary', 'html'],
    },
  },
});
