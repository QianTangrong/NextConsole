/** Build the single-file CDN bundle that can be loaded by a classic script tag. */
import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    copyPublicDir: false,
    // Preserve the ES, UMD, and declaration files created by the library build.
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/cdn.ts'),
      name: 'NextConsole',
      formats: ['iife'],
      fileName: () => 'nextconsole.min.js',
    },
    sourcemap: false,
    target: 'es2020',
  },
});
