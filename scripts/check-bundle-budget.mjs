import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const budget = readJSON('bundle-budget.json');
const measured = new Map();
const failures = [];

for (const [file, limits] of Object.entries(budget.files)) {
  const content = readFileSync(resolve(root, 'dist', file));
  const actual = {
    rawBytes: content.byteLength,
    gzipBytes: gzipSync(content).byteLength,
  };
  measured.set(file, actual);

  console.log(
    `${file}: ${formatBytes(actual.rawBytes)} / gzip ${formatBytes(actual.gzipBytes)} `
      + `(budget ${formatBytes(limits.rawBytes)} / ${formatBytes(limits.gzipBytes)})`,
  );

  for (const metric of ['rawBytes', 'gzipBytes']) {
    if (actual[metric] > limits[metric]) {
      failures.push(`${file} ${metric} ${actual[metric]} exceeds ${limits[metric]}`);
    }
  }
}

assertSmaller('lite.mjs', 'nconsole.es.mjs');
assertSmaller('nconsole.lite.min.js', 'nconsole.min.js');
assertSmaller('core.mjs', 'lite.mjs');

if (failures.length > 0) {
  throw new Error(`Bundle budget check failed:\n${failures.join('\n')}`);
}

function assertSmaller(smallerFile, largerFile) {
  const smaller = measured.get(smallerFile);
  const larger = measured.get(largerFile);
  if (smaller.rawBytes >= larger.rawBytes || smaller.gzipBytes >= larger.gzipBytes) {
    failures.push(`${smallerFile} must remain smaller than ${largerFile}`);
  }
}

function readJSON(file) {
  return JSON.parse(readFileSync(resolve(root, file), 'utf8'));
}

function formatBytes(value) {
  return `${(value / 1024).toFixed(2)} KiB`;
}
