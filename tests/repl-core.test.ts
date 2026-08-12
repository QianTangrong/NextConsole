import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReplCore } from '../src/core/repl-core';

afterEach(() => vi.unstubAllGlobals());

describe('ReplCore', () => {
  it('bounds command history, output entries, and serialized results', () => {
    vi.stubGlobal('HTMLElement', class HTMLElementStub {});
    vi.stubGlobal('NodeList', class NodeListStub {});
    const core = new ReplCore();

    for (let index = 0; index < 300; index += 1) core.execute(String(index));

    expect(core.getEntries()).toHaveLength(500);
    expect(core.getHistory()).toHaveLength(100);

    core.execute(`({ value: '${'x'.repeat(20_000)}' })`);
    const entries = core.getEntries();
    const result = entries[entries.length - 1];
    expect(result?.type).toBe('output');
    expect(result?.content.length).toBeLessThan(11_000);
  });
});
