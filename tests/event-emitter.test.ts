import { describe, expect, it, vi } from 'vitest';

import { EventEmitter } from '../src/utils/event-emitter';

type TestEvents = {
  value: (value: number) => void;
};

describe('EventEmitter', () => {
  it('subscribes, emits and unsubscribes a listener', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener = vi.fn();
    const unsubscribe = emitter.on('value', listener);

    emitter.emit('value', 1);
    unsubscribe();
    emitter.emit('value', 2);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(1);
  });

  it('isolates listener failures so later listeners still run', () => {
    const emitter = new EventEmitter<TestEvents>();
    const error = new Error('listener failed');
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const healthyListener = vi.fn();

    emitter.on('value', () => {
      throw error;
    });
    emitter.on('value', healthyListener);
    emitter.emit('value', 7);

    expect(report).toHaveBeenCalledWith('[NextConsole] event listener error', error);
    expect(healthyListener).toHaveBeenCalledWith(7);
  });
});
