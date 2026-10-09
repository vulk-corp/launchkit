import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [
    dts({ insertTypesEntry: true, tsconfigPath: './tsconfig.build.json' }),
  ],
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    lib: {
      entry: {
        launchkit: resolve(__dirname, 'src/index.ts'),
        cancellation: resolve(__dirname, 'src/cancellation.ts'),
      },
      name: 'BWorldsLaunchKit',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => {
        if (format === 'es') return `${entryName}.js`;
        return `${entryName}.cjs`;
      },
    },
    rollupOptions: {
      external: ['rrweb'],
    },
    sourcemap: true,
    minify: 'esbuild',
  },
});
