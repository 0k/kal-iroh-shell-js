import { defineConfig } from 'vitest/config';

// `npm run test:vite-matrix` points `vite` at another major's install.
const vite = process.env.KAL_IROH_SHELL_TEST_VITE;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
    ...(vite ? { alias: { vite } } : {}),
  },
});
