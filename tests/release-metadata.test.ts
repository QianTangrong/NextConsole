import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type PackageManifest = {
  name: string;
  version: string;
  files: string[];
  exports: Record<string, Record<string, string>>;
};

type PackageLock = PackageManifest & {
  packages: Record<string, Partial<PackageManifest>>;
};

const root = process.cwd();
const packageManifest = readJSON<PackageManifest>('package.json');
const packageLock = readJSON<PackageLock>('package-lock.json');
const readmeFiles = ['README.md', 'README.zh-CN.md', 'README.zh-TW.md', 'README.fr.md'];
const expectedEntries = [
  '.',
  './lite',
  './core',
  './plugins/source',
  './plugins/performance',
  './plugins/mimo-ai-diagnosis',
];

describe('release metadata', () => {
  it('keeps the manifest and lockfile package identity aligned', () => {
    expect(packageLock.name).toBe(packageManifest.name);
    expect(packageLock.version).toBe(packageManifest.version);
    expect(packageLock.packages['']?.name).toBe(packageManifest.name);
    expect(packageLock.packages['']?.version).toBe(packageManifest.version);
  });

  it('places the TypeScript condition before runtime conditions on the full entry', () => {
    expect(Object.keys(packageManifest.exports['.'])).toEqual(['types', 'import', 'require']);
  });

  it('exposes Lite, Core, and optional plugin subpaths with declarations', () => {
    expect(Object.keys(packageManifest.exports)).toEqual(expectedEntries);

    for (const entry of expectedEntries.slice(1)) {
      expect(Object.keys(packageManifest.exports[entry])).toEqual(['types', 'import']);
      expect(packageManifest.exports[entry].types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(packageManifest.exports[entry].import).toMatch(/^\.\/dist\/.+\.js$/);
    }
  });

  it('keeps development-only maps and example assets out of the package', () => {
    expect(packageManifest.files).toEqual([
      'dist',
      '!dist/**/*.map',
      '!dist/asset/**',
    ]);
  });

  it.each(readmeFiles)('uses the current package name in %s', (file) => {
    const readme = readFileSync(resolve(root, file), 'utf8');

    expect(readme).toContain(`npm install ${packageManifest.name}`);
    expect(readme).toContain(`from '${packageManifest.name}'`);
    expect(readme).toContain(`unpkg.com/${packageManifest.name}/`);
    expect(readme).not.toContain('@royalscome/nextconsole');
  });

  it('does not publish a prefilled provider credential', () => {
    const source = readFileSync(
      resolve(root, 'src/plugins/mimo-ai-diagnosis-plugin.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/['"`]sk-[A-Za-z0-9_-]{16,}['"`]/);
  });
});

function readJSON<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
}
