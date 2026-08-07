import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type PackageManifest = {
  name: string;
  version: string;
};

type PackageLock = PackageManifest & {
  packages: Record<string, Partial<PackageManifest>>;
};

const root = process.cwd();
const packageManifest = readJSON<PackageManifest>('package.json');
const packageLock = readJSON<PackageLock>('package-lock.json');
const readmeFiles = ['README.md', 'README.zh-CN.md', 'README.zh-TW.md', 'README.fr.md'];

describe('release metadata', () => {
  it('keeps the manifest and lockfile package identity aligned', () => {
    expect(packageLock.name).toBe(packageManifest.name);
    expect(packageLock.version).toBe(packageManifest.version);
    expect(packageLock.packages['']?.name).toBe(packageManifest.name);
    expect(packageLock.packages['']?.version).toBe(packageManifest.version);
  });

  it.each(readmeFiles)('uses the current package name in %s', (file) => {
    const readme = readFileSync(resolve(root, file), 'utf8');

    expect(readme).toContain(`npm install ${packageManifest.name}`);
    expect(readme).toContain(`from '${packageManifest.name}'`);
    expect(readme).toContain(`unpkg.com/${packageManifest.name}/`);
    expect(readme).not.toContain('@royalscome/nextconsole');
  });
});

function readJSON<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
}
