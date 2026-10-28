import { defineConfig } from 'vitest/config';
// Real Chromium against a LOCAL fixture server (never Instagram). Run: pnpm test:browser
export default defineConfig({
  test: { include: ['tests/e2e/**/*.test.ts'], testTimeout: 90_000, hookTimeout: 60_000, pool: 'forks', fileParallelism: false },
});
