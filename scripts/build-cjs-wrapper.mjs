import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const distDir = resolve(process.cwd(), 'dist');
const outputFile = resolve(distDir, 'nconsole.cjs');
const source = `'use strict';
const namespace = require('./nconsole.umd.js');
const Nconsole = namespace.default || namespace.Nconsole;

if (typeof Nconsole !== 'function') {
  throw new TypeError('The Nconsole UMD bundle did not expose a constructor.');
}

Object.assign(Nconsole, namespace, {
  default: Nconsole,
  Nconsole,
});

module.exports = Nconsole;
`;

await mkdir(distDir, { recursive: true });
await writeFile(outputFile, source, 'utf8');
