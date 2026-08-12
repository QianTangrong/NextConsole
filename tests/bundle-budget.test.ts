import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type Budget = {
  files: Record<string, { rawBytes: number; gzipBytes: number }>;
};

const root = process.cwd();
const budget = JSON.parse(
  readFileSync(resolve(root, 'bundle-budget.json'), 'utf8'),
) as Budget;

describe('bundle budget configuration', () => {
  it('covers every public JavaScript artifact', () => {
    expect(Object.keys(budget.files)).toEqual([
      'nconsole.es.mjs',
      'nconsole.cjs',
      'nconsole.umd.js',
      'nconsole.min.js',
      'lite.mjs',
      'nconsole.lite.min.js',
      'core.mjs',
      'plugins/source.mjs',
      'plugins/performance.mjs',
      'plugins/mimo-ai-diagnosis.mjs',
    ]);
  });

  it('uses positive raw and gzip limits', () => {
    for (const limits of Object.values(budget.files)) {
      expect(limits.rawBytes).toBeGreaterThan(0);
      expect(limits.gzipBytes).toBeGreaterThan(0);
      expect(limits.gzipBytes).toBeLessThan(limits.rawBytes);
    }
  });
});
