import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Live tests hit real provider APIs and only run via `pnpm test:live`.
    exclude: process.env.LIVE_TESTS === '1' ? ['**/node_modules/**'] : ['**/node_modules/**', 'test/live/**'],
    testTimeout: 30_000,
  },
});
