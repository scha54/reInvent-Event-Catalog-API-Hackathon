import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CDK synth tests are slow when many workers run in parallel.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**'],
  },
});
