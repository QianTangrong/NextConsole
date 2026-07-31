/** 仅生成可由经典 script 标签直接加载的单文件 CDN 构建。 */
import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    // 保留常规库构建生成的 ES、UMD 和声明文件。
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/cdn.ts'),
      name: 'NextConsole',
      formats: ['iife'],
      fileName: () => 'nextconsole.min.js',
    },
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2020',
  },
});
