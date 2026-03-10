import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    dts({ insertTypesEntry: true }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'BWorldsLaunchKit',
      formats: ['es', 'cjs', 'umd'],
      fileName: (format) => {
        if (format === 'es') return 'launchkit.js';
        if (format === 'cjs') return 'launchkit.cjs';
        return 'launchkit.umd.js';
      },
    },
    sourcemap: true,
    minify: 'esbuild',
  },
});
