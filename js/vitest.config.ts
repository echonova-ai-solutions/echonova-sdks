import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The live suite calls the real API: `npm run test:live` (vitest.live.config.ts).
    exclude: [...configDefaults.exclude, 'tests/live/**'],
    environment: 'node',
  },
});
