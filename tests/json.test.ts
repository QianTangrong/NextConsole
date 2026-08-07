import { describe, expect, it } from 'vitest';

import { highlightJSON, safeStringify } from '../src/utils/json';

describe('JSON utilities', () => {
  it('serializes circular references, bigint and errors safely', () => {
    const value: Record<string, unknown> = {
      count: 2n,
      error: new Error('boom'),
    };
    value.self = value;

    const serialized = safeStringify(value);

    expect(JSON.parse(serialized)).toMatchObject({
      count: '2',
      error: { message: 'boom' },
      self: '[Circular]',
    });
  });

  it('escapes untrusted object keys and values before highlighting them', () => {
    const highlighted = highlightJSON({ '<img>': '<script>alert(1)</script>' });

    expect(highlighted).toContain('&lt;img&gt;');
    expect(highlighted).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(highlighted).not.toContain('<script>');
  });
});
