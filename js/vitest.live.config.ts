import { defineConfig } from 'vitest/config';

// The live suite (tests/live): calls the real API, and some tests cost credits.
//   ECHONOVA_LIVE=1 ECHONOVA_API_KEY=ek_... npm run test:live
// Without ECHONOVA_LIVE=1 every test is skipped; without ECHONOVA_API_KEY only the free
// rejected-key checks run. See tests/live/support.ts for the other variables.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5 * 60_000,
    hookTimeout: 5 * 60_000,
    // One file at a time: fewer concurrent streams and requests against the key's limits.
    fileParallelism: false,
    retry: 0,
    // Lists every test, with the reason each skipped one was skipped.
    reporters: ['verbose'],
  },
});
