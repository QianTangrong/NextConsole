import { describe, expect, it } from 'vitest';

import { snapshotValue } from '../src/utils/snapshot';

describe('snapshotValue', () => {
  it('bounds collection size, depth, strings, and circular references', () => {
    const input: Record<string, unknown> = {
      list: Array.from({ length: 150 }, (_, index) => index),
      text: 'x'.repeat(10_100),
      nested: { level1: { level2: { level3: { level4: true } } } },
    };
    input.self = input;

    const snapshot = snapshotValue(input) as Record<string, unknown>;

    expect(snapshot.list).toHaveLength(100);
    expect(snapshot.text).toBe(`${'x'.repeat(10_000)}...`);
    expect(snapshot.nested).toEqual({ level1: { level2: { level3: '[...]' } } });
    expect(snapshot.self).toBe('[...]');
  });

  it('keeps null-prototype objects without invalidating the parent array', () => {
    const dictionary = Object.assign(Object.create(null) as Record<string, unknown>, { answer: 42 });

    const snapshot = snapshotValue([dictionary]) as unknown[];

    expect(snapshot).toEqual([{ answer: 42 }]);
  });
});
