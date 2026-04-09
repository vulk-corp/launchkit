import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'launchkit',
    environment: 'jsdom',
    globals: true,
  },
});
