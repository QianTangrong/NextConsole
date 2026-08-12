import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = process.cwd();
const require = createRequire(import.meta.url);

/** 通过原生 Node ESM 加载真实产物，避免只验证 package.json 字符串。 */
async function importArtifact(relativePath) {
  return import(pathToFileURL(resolve(root, relativePath)).href);
}

const rootModule = await importArtifact('dist/nconsole.es.mjs');
assert.equal(typeof rootModule.default, 'function');
assert.equal(rootModule.default, rootModule.Nconsole);

const liteModule = await importArtifact('dist/lite.mjs');
assert.equal(typeof liteModule.default, 'function');
assert.equal(liteModule.default, liteModule.Nconsole);

const coreModule = await importArtifact('dist/core.mjs');
assert.equal(typeof coreModule.ConsoleCore, 'function');
assert.equal(typeof coreModule.NetworkCore, 'function');
assert.equal(typeof coreModule.StorageCore, 'function');

for (const [file, exportName] of [
  ['dist/plugins/source.mjs', 'createSourcePlugin'],
  ['dist/plugins/performance.mjs', 'createPerformancePlugin'],
  ['dist/plugins/mimo-ai-diagnosis.mjs', 'createMimoAIDiagnosisPlugin'],
]) {
  const pluginModule = await importArtifact(file);
  assert.equal(typeof pluginModule[exportName], 'function');
}

const CommonJSNconsole = require(resolve(root, 'dist/nconsole.cjs'));
assert.equal(typeof CommonJSNconsole, 'function');
assert.equal(CommonJSNconsole.default, CommonJSNconsole);
assert.equal(CommonJSNconsole.Nconsole, CommonJSNconsole);
assert.equal(typeof CommonJSNconsole.createSourcePlugin, 'function');
assert.equal(typeof CommonJSNconsole.createPerformancePlugin, 'function');
assert.equal(typeof CommonJSNconsole.createMimoAIDiagnosisPlugin, 'function');

for (const file of ['dist/nconsole.min.js', 'dist/nconsole.lite.min.js']) {
  const context = { globalThis: undefined };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(await readFile(resolve(root, file), 'utf8'), context, { filename: file });
  assert.equal(typeof context.Nconsole, 'function');
}

console.log('Package exports: ESM, CommonJS, and CDN entry checks passed.');
