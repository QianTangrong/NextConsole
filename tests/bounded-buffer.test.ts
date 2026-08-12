import { describe, expect, it } from 'vitest';

import { BoundedBuffer, normalizeRetentionLimit } from '../src/utils/bounded-buffer';

describe('BoundedBuffer', () => {
  it('keeps chronological order while overwriting the oldest value', () => {
    const buffer = new BoundedBuffer<number>(3);
    expect(buffer.push(1)).toBeUndefined();
    buffer.push(2);
    buffer.push(3);
    expect(buffer.push(4)).toBe(1);
    expect(buffer.toArray()).toEqual([2, 3, 4]);
  });

  it('falls back for undefined, NaN, infinity, and negative retention values', () => {
    expect(normalizeRetentionLimit(undefined, 10)).toBe(10);
    expect(normalizeRetentionLimit(Number.NaN, 10)).toBe(10);
    expect(normalizeRetentionLimit(Number.POSITIVE_INFINITY, 10)).toBe(10);
    expect(normalizeRetentionLimit(-1, 10)).toBe(10);
    expect(normalizeRetentionLimit(3.9, 10)).toBe(3);
  });
});
