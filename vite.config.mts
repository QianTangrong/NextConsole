/**
 * Vite library build configuration: build ES and UMD bundles plus a rolled-up
 * TypeScript declaration file from src/index.ts.
 */
import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      bundleTypes: {
        bundledPackages: [],
      },
    }),
  ],
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
      fileName: (format) => `nconsole.${format}.js`,
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
