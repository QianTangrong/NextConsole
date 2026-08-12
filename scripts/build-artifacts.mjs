import { resolve } from 'node:path';
import { build } from 'vite';

const root = process.cwd();
const config = (file) => resolve(root, file);

// 在同一 Node 进程内串行构建全部 JS 入口，减少 Windows 下多层 npm 启动开销。
await build({ root, configFile: config('vite.config.mts'), mode: 'production' });
for (const mode of ['lite', 'core', 'plugin-source', 'plugin-performance', 'plugin-mimo']) {
  await build({ root, configFile: config('vite.entry.config.mts'), mode });
}
await build({ root, configFile: config('vite.cdn.config.mts'), mode: 'production' });
await build({ root, configFile: config('vite.lite-cdn.config.mts'), mode: 'production' });
