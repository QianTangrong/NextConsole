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

  it('keeps nested console hooks isolated across out-of-order destroy', () => {
    vi.stubGlobal('HTMLElement', class HTMLElementStub {});
    const nativeOutput = vi.fn();
    console.log = nativeOutput;
    const first = new ConsoleCore({ captureGlobalErrors: false, maxLogs: 10 });
    const second = new ConsoleCore({ captureGlobalErrors: false, maxLogs: 10 });

    try {
      first.init();
      second.init();
      console.log('captured by both');
      expect(first.getEntries()).toHaveLength(1);
      expect(second.getEntries()).toHaveLength(1);

      first.destroy();
      console.log('captured by second');
      expect(first.getEntries()).toHaveLength(1);
      expect(second.getEntries()).toHaveLength(2);

      second.destroy();
      expect(console.log).toBe(nativeOutput);
      console.log('native only');
      expect(first.getEntries()).toHaveLength(1);
      expect(second.getEntries()).toHaveLength(2);
      expect(nativeOutput).toHaveBeenCalledTimes(3);
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  it('rolls back earlier console hooks when installation fails partway through', () => {
    vi.stubGlobal('HTMLElement', class HTMLElementStub {});
    const originalLog = console.log;
    const originalInfoDescriptor = Object.getOwnPropertyDescriptor(console, 'info');
    const core = new ConsoleCore({ captureGlobalErrors: false, hookConsole: true });

    Object.defineProperty(console, 'info', {
      ...originalInfoDescriptor,
      writable: false,
      configurable: true,
    });

    try {
      expect(() => core.init()).toThrow();
      expect(console.log).toBe(originalLog);
    } finally {
      core.destroy();
      if (originalInfoDescriptor) {
        Object.defineProperty(console, 'info', originalInfoDescriptor);
      }
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

  it('bounds the first stream chunk and marks an exact-limit stream when more data arrives', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.set(1, callback);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => callbacks.delete(handle));
    const core = new ConsoleCore({ captureGlobalErrors: false, hookConsole: false, maxLogs: 10 });

    core.appendStream('large', 'x'.repeat(250_000));
    core.appendStream('exact', 'y'.repeat(100_000));
    core.appendStream('exact', '!');

    const [large, exact] = core.getEntries();
    expect(large.args[0]).toBe(`${'x'.repeat(100_000)}...(truncated)`);
    expect(exact.args[0]).toBe(`${'y'.repeat(100_000)}...(truncated)`);
  });

  it('keeps console argument arrays valid for null-prototype objects', () => {
    vi.stubGlobal('HTMLElement', class HTMLElementStub {});
    const nativeOutput = vi.fn();
    console.log = nativeOutput;
    const core = new ConsoleCore({ captureGlobalErrors: false, hookConsole: true, maxLogs: 10 });
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { answer: 42 });

    try {
      core.init();
      console.log(value);
      expect(core.getEntries()[0].args).toEqual([{ answer: 42 }]);
    } finally {
      core.destroy();
    }
  });

  it('preserves Error metadata in captured console arguments', () => {
    vi.stubGlobal('HTMLElement', class HTMLElementStub {});
    const nativeOutput = vi.fn();
    console.log = nativeOutput;
    const core = new ConsoleCore({ captureGlobalErrors: false, hookConsole: true, maxLogs: 10 });
    const error = new Error('origin');

    try {
      core.init();
      console.log(error);
      expect(core.getEntries()[0].args[0]).toEqual(expect.objectContaining({
        name: 'Error',
        message: 'origin',
        stack: expect.stringContaining('Error: origin'),
      }));
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

  it('falls back to the safe limit when maxLogs is undefined', () => {
    const core = new ConsoleCore({
      captureGlobalErrors: false,
      hookConsole: false,
      maxLogs: undefined,
    } as unknown as ConstructorParameters<typeof ConsoleCore>[0]);

    for (let index = 0; index < 10_005; index += 1) {
      core.appendStream(`stream-${index}`, 'value');
    }

    expect(core.getEntries()).toHaveLength(10_000);
    expect(core.getEntries()[0].streamId).toBe('stream-5');
  });
});
