import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleCore } from '../src/core/console-core';

const nativeConsoleLog = console.log;

afterEach(() => {
  console.log = nativeConsoleLog;
  vi.unstubAllGlobals();
});

describe('ConsoleCore', () => {
  it('captures console calls, keeps the configured limit and preserves native output', () => {
    vi.stubGlobal('HTMLElement', class HTMLElementStub {});
    const nativeOutput = vi.fn();
    console.log = nativeOutput;
    const core = new ConsoleCore({
      captureGlobalErrors: false,
      hookConsole: true,
      maxLogs: 2,
    });

    try {
      core.init();
      console.log('first');
      console.log('second');
      console.log('third');

      expect(nativeOutput).toHaveBeenCalledTimes(3);
      expect(core.getEntries().map((entry) => entry.args)).toEqual([['second'], ['third']]);
    } finally {
      core.destroy();
    }
  });

  it('batches chunks into one streaming entry and marks it complete', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => callbacks.delete(handle));

    const core = new ConsoleCore({
      captureGlobalErrors: false,
      hookConsole: false,
      maxLogs: 10,
    });
    const streamUpdate = vi.fn();
    core.on('streamUpdate', streamUpdate);
    core.init();

    try {
      core.appendStream('answer', 'Hello');
      core.appendStream('answer', ' world');
      core.appendStream('answer', '!');

      expect(callbacks.size).toBe(1);
      expect(core.getEntries()).toHaveLength(1);
      expect(core.getEntries()[0].args).toEqual(['Hello world!']);

      callbacks.values().next().value?.(0);
      expect(streamUpdate).toHaveBeenCalledOnce();

      core.endStream('answer');
      expect(core.getEntries()[0].streaming).toBe(false);
      expect(streamUpdate).toHaveBeenCalledTimes(2);
    } finally {
      core.destroy();
    }
  });

  it('releases pending stream work when entries are evicted or cleared', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => callbacks.delete(handle));

    const core = new ConsoleCore({
      captureGlobalErrors: false,
      hookConsole: false,
      maxLogs: 1,
    });
    const streamUpdate = vi.fn();
    core.on('streamUpdate', streamUpdate);
    core.init();

    try {
      core.appendStream('old', 'first');
      core.appendStream('old', ' chunk');
      expect(callbacks.size).toBe(1);

      core.appendStream('current', 'second');
      expect(core.getEntries().map((entry) => entry.streamId)).toEqual(['current']);
      expect(callbacks.size).toBe(0);

      core.appendStream('current', ' chunk');
      expect(callbacks.size).toBe(1);
      core.clear();
      expect(callbacks.size).toBe(0);
      expect(core.getEntries()).toEqual([]);
      expect(streamUpdate).not.toHaveBeenCalled();
    } finally {
      core.destroy();
    }
  });
});
