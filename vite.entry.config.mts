import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const entries = {
  lite: {
    entry: 'src/lite.ts',
    fileName: 'lite.js',
    name: 'NconsoleLite',
  },
  core: {
    entry: 'src/core.ts',
    fileName: 'core.js',
    name: 'NconsoleCore',
  },
  'plugin-source': {
    entry: 'src/plugins/source-plugin.ts',
    fileName: 'plugins/source.js',
    name: 'NconsoleSourcePlugin',
  },
  'plugin-performance': {
    entry: 'src/plugins/performance-plugin.ts',
    fileName: 'plugins/performance.js',
    name: 'NconsolePerformancePlugin',
  },
  'plugin-mimo': {
    entry: 'src/plugins/mimo-ai-diagnosis-plugin.ts',
    fileName: 'plugins/mimo-ai-diagnosis.js',
    name: 'NconsoleMimoAIDiagnosisPlugin',
  },
} as const;

/** Build one ESM subpath at a time so each optional entry has an auditable size. */
export default defineConfig(({ mode }) => {
  const selected = entries[mode as keyof typeof entries];
  if (!selected) {
    throw new Error(`Unsupported library entry mode: ${mode}`);
  }

  return {
    build: {
      copyPublicDir: false,
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, selected.entry),
        name: selected.name,
        formats: ['es'],
        fileName: () => selected.fileName,
      },
      rolldownOptions: {
        output: {
          codeSplitting: false,
          exports: 'named',
        },
      },
      target: 'es2020',
      // 保留本地映射文件供调试，但不让发布 JS 引用被 files 规则排除的 .map。
      sourcemap: 'hidden',
    },
  };
});
