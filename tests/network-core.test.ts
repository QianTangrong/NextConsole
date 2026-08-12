import { afterEach, describe, expect, it, vi } from 'vitest';

import { NetworkCore } from '../src/core/network-core';
import { NetworkCaptureStore } from '../src/core/network/network-capture';
import type { NetworkEntry } from '../src/types';

type WindowHarness = {
  window: Window & typeof globalThis;
  frameCallbacks: Map<number, FrameRequestCallback>;
};

function installWindow(overrides: Partial<Window & typeof globalThis> = {}): WindowHarness {
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const windowStub = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const handle = ++nextFrame;
      frameCallbacks.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle: number) => frameCallbacks.delete(handle),
    ...overrides,
  } as unknown as Window & typeof globalThis;

  vi.stubGlobal('window', windowStub);
  return { window: windowStub, frameCallbacks };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NetworkCore', () => {
  it('drops scheduled work and messages for evicted or cleared stream entries', () => {
    const { frameCallbacks } = installWindow();
    const onUpdate = vi.fn();
    const store = new NetworkCaptureStore(1, vi.fn(), onUpdate, vi.fn());
    const createEntry = (id: number): NetworkEntry => ({
      id,
      type: 'websocket',
      method: 'WS',
      url: `ws://localhost/${id}`,
      requestHeaders: {},
      requestBody: null,
      status: 101,
      statusText: 'Switching Protocols',
      responseHeaders: {},
      responseBody: null,
      startTime: 0,
      endTime: 0,
      duration: 0,
      pending: true,
      messages: [],
    });
    const staleEntry = createEntry(1);
    const activeEntry = createEntry(2);

    store.addEntry(staleEntry);
    store.pushStreamMessage(staleEntry, { direction: 'in', data: 'first', timestamp: 1 });
    expect(frameCallbacks.size).toBe(1);

    store.addEntry(activeEntry);
    expect(frameCallbacks.size).toBe(0);
    store.pushStreamMessage(staleEntry, { direction: 'in', data: 'stale', timestamp: 2 });
    expect(staleEntry.messages).toHaveLength(1);

    store.pushStreamMessage(activeEntry, { direction: 'in', data: 'active', timestamp: 3 });
    expect(frameCallbacks.size).toBe(1);
    frameCallbacks.values().next().value?.(0);
    expect(onUpdate).toHaveBeenLastCalledWith(activeEntry, false);

    store.emitUpdate(activeEntry);
    expect(onUpdate).toHaveBeenLastCalledWith(activeEntry, true);
    store.clear();
    store.pushStreamMessage(activeEntry, { direction: 'in', data: 'cleared', timestamp: 4 });
    expect(activeEntry.messages).toHaveLength(1);
    expect(store.getEntries()).toEqual([]);
  });

  it('captures fetch without changing its response and restores the exact native function', async () => {
    const nativeFetch = vi.fn(async () => new Response('created', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-length': '7', 'content-type': 'text/plain' },
    }));
    const { window } = installWindow({ fetch: nativeFetch as typeof fetch });
    const core = new NetworkCore({
      hookFetch: true,
      hookXHR: false,
      hookSSE: false,
      hookWebSocket: false,
      maxRequests: 10,
    });

    const onRequest = vi.fn();
    const onUpdate = vi.fn();
    core.on('request', onRequest);
    core.on('update', onUpdate);

    try {
      core.init();
      const installedFetch = window.fetch;
      core.init();
      expect(window.fetch).toBe(installedFetch);

      const response = await window.fetch('/users', {
        method: 'post',
        headers: { 'x-request-id': 'request-1' },
        body: 'payload',
      });

      expect(await response.text()).toBe('created');
      expect(nativeFetch).toHaveBeenCalledOnce();
      expect(onRequest).toHaveBeenCalledOnce();
      expect(onUpdate).toHaveBeenCalledOnce();
      expect(core.getEntries()[0]).toMatchObject({
        type: 'fetch',
        method: 'POST',
        url: '/users',
        requestHeaders: { 'x-request-id': 'request-1' },
        requestBody: 'payload',
        status: 201,
        statusText: 'Created',
        responseBody: '[Fetch response body preview disabled]',
        pending: false,
      });
    } finally {
      core.destroy();
    }

    expect(window.fetch).toBe(nativeFetch);
  });

  it('keeps nested fetch hooks isolated across out-of-order destroy', async () => {
    const nativeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const { window } = installWindow({ fetch: nativeFetch as typeof fetch });
    const options = {
      hookFetch: true,
      hookXHR: false,
      hookSSE: false,
      hookWebSocket: false,
      maxRequests: 10,
    };
    const first = new NetworkCore(options);
    const second = new NetworkCore(options);

    try {
      first.init();
      second.init();
      await window.fetch('/captured-by-both');
      expect(first.getEntries()).toHaveLength(1);
      expect(second.getEntries()).toHaveLength(1);

      first.destroy();
      await window.fetch('/captured-by-second');
      expect(first.getEntries()).toHaveLength(1);
      expect(second.getEntries()).toHaveLength(2);

      second.destroy();
      expect(window.fetch).toBe(nativeFetch);
      await window.fetch('/native-only');
      expect(first.getEntries()).toHaveLength(1);
      expect(second.getEntries()).toHaveLength(2);
      expect(nativeFetch).toHaveBeenCalledTimes(3);
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  it('preserves a third-party fetch hook installed after NetworkCore', async () => {
    const nativeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const { window } = installWindow({ fetch: nativeFetch as typeof fetch });
    const core = new NetworkCore({
      hookFetch: true,
      hookXHR: false,
      hookSSE: false,
      hookWebSocket: false,
      maxRequests: 10,
    });

    core.init();
    const nconsoleFetch = window.fetch;
    const thirdPartyFetch = vi.fn((...args: Parameters<typeof fetch>) => nconsoleFetch(...args));
    window.fetch = thirdPartyFetch as typeof fetch;
    core.destroy();

    expect(window.fetch).toBe(thirdPartyFetch);
    await window.fetch('/third-party-only');
    expect(thirdPartyFetch).toHaveBeenCalledOnce();
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(core.getEntries()).toEqual([]);
  });

  it('applies fetch ignore rules before reading request metadata', async () => {
    const nativeFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const { window } = installWindow({ fetch: nativeFetch as typeof fetch });
    const core = new NetworkCore({
      hookFetch: true,
      hookXHR: false,
      hookSSE: false,
      hookWebSocket: false,
      maxRequests: 10,
    });
    core.addFetchIgnoreRule((url, method) => url === '/diagnosis' && method === 'POST');

    try {
      core.init();
      await window.fetch('/diagnosis', { method: 'POST', body: 'secret' });
      expect(core.getEntries()).toEqual([]);
      expect(nativeFetch).toHaveBeenCalledOnce();
    } finally {
      core.destroy();
    }
  });

  it('captures XHR metadata and restores all patched prototype methods', () => {
    class FakeXMLHttpRequest {
      private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
      status = 200;
      statusText = 'OK';
      responseType: XMLHttpRequestResponseType = '';
      response: unknown = null;
      responseText = '{"ok":true}';
      sentBody: unknown = null;

      open(_method: string, _url: string | URL): void {}
      setRequestHeader(_name: string, _value: string): void {}
      send(body?: Document | XMLHttpRequestBodyInit | null): void {
        this.sentBody = body;
      }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      getAllResponseHeaders(): string {
        return 'content-type: application/json\r\nx-response-id: response-1\r\n';
      }
      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      }
      dispatch(type: string): void {
        const event = { type } as Event;
        this.listeners.get(type)?.forEach((listener) => {
          if (typeof listener === 'function') listener.call(this, event);
          else listener.handleEvent(event);
        });
      }
    }

    installWindow();
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest as unknown as typeof XMLHttpRequest);
    const nativeOpen = FakeXMLHttpRequest.prototype.open;
    const nativeSend = FakeXMLHttpRequest.prototype.send;
    const nativeSetRequestHeader = FakeXMLHttpRequest.prototype.setRequestHeader;
    const core = new NetworkCore({
      hookFetch: false,
      hookXHR: true,
      hookSSE: false,
      hookWebSocket: false,
      maxRequests: 10,
    });
    const onUpdate = vi.fn();
    core.on('update', onUpdate);

    try {
      core.init();
      const xhr = new FakeXMLHttpRequest();
      xhr.open('post', '/items');
      xhr.setRequestHeader('x-request-id', 'request-2');
      xhr.send('body');
      xhr.dispatch('loadend');

      expect(core.getEntries()[0]).toMatchObject({
        type: 'xhr',
        method: 'POST',
        url: '/items',
        requestHeaders: { 'x-request-id': 'request-2' },
        requestBody: 'body',
        status: 200,
        responseHeaders: {
          'content-type': 'application/json',
          'x-response-id': 'response-1',
        },
        responseBody: { ok: true },
        pending: false,
      });

      const largeXHR = new FakeXMLHttpRequest();
      largeXHR.responseText = JSON.stringify({ value: 'x'.repeat(20_000) });
      largeXHR.open('post', '/large');
      largeXHR.send('x'.repeat(20_000));
      largeXHR.dispatch('loadend');
      const largeEntry = core.getEntries()[1];
      expect(largeEntry.requestBody).toContain('(truncated)');
      expect(typeof largeEntry.responseBody).toBe('string');
      expect((largeEntry.responseBody as string).length).toBeLessThan(11_000);
      expect(onUpdate).toHaveBeenCalledTimes(2);
    } finally {
      core.destroy();
    }

    expect(FakeXMLHttpRequest.prototype.open).toBe(nativeOpen);
    expect(FakeXMLHttpRequest.prototype.send).toBe(nativeSend);
    expect(FakeXMLHttpRequest.prototype.setRequestHeader).toBe(nativeSetRequestHeader);
  });

  it('captures named SSE events and keeps listener removal symmetric across destroy', () => {
    class FakeEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

      constructor(public readonly url: string | URL) {}
      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener) return;
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (listener) this.listeners.get(type)?.delete(listener);
      }
      dispatch(type: string, data: string): void {
        const event = { type, data, lastEventId: 'event-1' } as MessageEvent;
        this.listeners.get(type)?.forEach((listener) => {
          if (typeof listener === 'function') listener.call(this, event);
          else listener.handleEvent(event);
        });
      }
    }

    const { window } = installWindow({
      EventSource: FakeEventSource as unknown as typeof EventSource,
    });
    const core = new NetworkCore({
      hookFetch: false,
      hookXHR: false,
      hookSSE: true,
      hookWebSocket: false,
      maxRequests: 10,
    });
    const businessListener = vi.fn();

    core.init();
    const InstalledEventSource = window.EventSource;
    const source = new InstalledEventSource('/events') as unknown as FakeEventSource;
    source.addEventListener('progress', businessListener);
    source.dispatch('progress', 'first');

    expect(core.getEntries()[0].sseEvents).toEqual([
      expect.objectContaining({ data: 'first', event: 'progress', id: 'event-1' }),
    ]);
    expect(core.getEntries()[0].messages).toEqual([
      expect.objectContaining({ direction: 'in', data: 'first', event: 'progress' }),
    ]);
    expect(businessListener).toHaveBeenCalledOnce();

    core.destroy();
    expect(window.EventSource).toBe(FakeEventSource);

    source.dispatch('progress', 'after-destroy');
    expect(businessListener).toHaveBeenCalledTimes(2);
    expect(core.getEntries()[0].messages).toHaveLength(1);

    source.removeEventListener('progress', businessListener);
    source.dispatch('progress', 'after-remove');
    expect(businessListener).toHaveBeenCalledTimes(2);
  });

  it('captures WebSocket traffic and stops old connections from writing after destroy', () => {
    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
      sent: unknown[] = [];

      constructor(public readonly url: string | URL) {}
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        this.sent.push(data);
      }
      dispatch(type: string, event: Event): void {
        this.listeners.get(type)?.forEach((listener) => {
          if (typeof listener === 'function') listener.call(this, event);
          else listener.handleEvent(event);
        });
      }
    }

    const { window, frameCallbacks } = installWindow({
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const core = new NetworkCore({
      hookFetch: false,
      hookXHR: false,
      hookSSE: false,
      hookWebSocket: true,
      maxRequests: 10,
    });

    core.init();
    const InstalledWebSocket = window.WebSocket;
    const socket = new InstalledWebSocket('ws://localhost') as unknown as FakeWebSocket;
    socket.dispatch('open', { type: 'open' } as Event);
    socket.dispatch('message', { type: 'message', data: 'incoming' } as MessageEvent);
    socket.send('outgoing');

    expect(core.getEntries()[0]).toMatchObject({
      type: 'websocket',
      status: 101,
      statusText: 'Switching Protocols',
      pending: true,
    });
    expect(core.getEntries()[0].messages).toEqual([
      expect.objectContaining({ direction: 'in', data: 'incoming' }),
      expect.objectContaining({ direction: 'out', data: 'outgoing' }),
    ]);
    expect(frameCallbacks).toHaveLength(1);

    core.destroy();
    expect(window.WebSocket).toBe(FakeWebSocket);
    expect(frameCallbacks).toHaveLength(0);

    socket.dispatch('message', { type: 'message', data: 'after-destroy' } as MessageEvent);
    socket.send('still-sent');
    expect(socket.sent).toEqual(['outgoing', 'still-sent']);
    expect(core.getEntries()[0].messages).toHaveLength(2);
  });

  it('bounds individual and aggregate streaming message payloads', () => {
    installWindow();
    const store = new NetworkCaptureStore(1, vi.fn(), vi.fn(), vi.fn());
    const entry: NetworkEntry = {
      id: 1,
      type: 'websocket',
      method: 'WS',
      url: 'ws://localhost',
      requestHeaders: {},
      requestBody: null,
      status: 101,
      statusText: 'Switching Protocols',
      responseHeaders: {},
      responseBody: null,
      startTime: 0,
      endTime: 0,
      duration: 0,
      pending: true,
      messages: [],
    };
    store.addEntry(entry);

    for (let index = 0; index < 1200; index += 1) {
      store.pushStreamMessage(entry, {
        direction: 'in',
        data: 'x'.repeat(25_000),
        timestamp: index,
      });
    }

    expect(entry.messages?.[0].data).toContain('(truncated)');
    expect(entry.messages).toHaveLength(1000);
    expect(entry.messages?.reduce((total, message) => total + message.data.length, 0)).toBeLessThanOrEqual(1_000_000);
  });
});
