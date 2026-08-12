/**
 * Vite library build configuration for the ES and UMD runtime bundles.
 * TypeScript declarations are emitted once by tsconfig.build.json.
 */
import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    open: '/examples/index.html',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    copyPublicDir: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Nconsole',
      formats: ['es', 'umd'],
      fileName: (format) => format === 'es' ? 'nconsole.es.mjs' : 'nconsole.umd.js',
    },
    rolldownOptions: {
      output: {
        codeSplitting: false,
        exports: 'named',
      },
    },
    target: 'es2020',
    // 发布包排除 .map，隐藏映射注释可避免产物引用不存在的文件。
    sourcemap: 'hidden',
  },
});
