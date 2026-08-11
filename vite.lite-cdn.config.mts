/** Build a classic-script Lite bundle without any optional plugin code. */
import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/cdn-lite.ts'),
      name: 'Nconsole',
      formats: ['iife'],
      fileName: () => 'nconsole.lite.min.js',
    },
    sourcemap: false,
    target: 'es2020',
  },
});
