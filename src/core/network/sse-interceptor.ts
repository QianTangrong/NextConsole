import type { NetworkEntry, SSEEvent, StreamMessage } from '../../types';
import { nextId } from '../../utils/time';
import { finishNetworkEntry, type NetworkCaptureSink } from './network-capture';

function getEventCapture(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
  return typeof options === 'boolean' ? options : Boolean(options?.capture);
}

/** 代理 EventSource 构造与自定义事件监听，并独立拥有恢复边界。 */
export class SSEInterceptor {
  private originalEventSource: typeof EventSource | null = null;
  private active = false;

  constructor(private readonly sink: NetworkCaptureSink) {}

  install(): void {
    if (this.active || typeof window.EventSource === 'undefined') return;

    const OriginalEventSource = window.EventSource;
    const self = this;
    const ProxiedEventSource = function (
      this: EventSource,
      url: string | URL,
      init?: EventSourceInit,
    ) {
      const eventSource = new OriginalEventSource(url, init);
      const entry: NetworkEntry = {
        id: nextId(),
        type: 'sse',
        method: 'GET',
        url: String(url),
        requestHeaders: {},
        requestBody: null,
        status: 0,
        statusText: 'SSE',
        responseHeaders: {},
        responseBody: null,
        startTime: performance.now(),
        endTime: 0,
        duration: 0,
        pending: true,
        sseEvents: [],
        messages: [],
      };

      self.sink.addEntry(entry);

      eventSource.addEventListener('open', () => {
        if (!self.active) return;
        entry.status = 200;
        self.sink.emitUpdate(entry);
      });

      const originalAddEventListener = eventSource.addEventListener.bind(eventSource);
      const originalRemoveEventListener = eventSource.removeEventListener.bind(eventSource);
      const wrappedListeners = new Map<
        string,
        WeakMap<EventListenerOrEventListenerObject, Map<boolean, EventListener>>
      >();

      // 命名 SSE 事件必须包裹业务监听器，才能捕获数据且保持 removeEventListener 对称。
      (eventSource as any).addEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (!listener) {
          return originalAddEventListener(
            type,
            listener as unknown as EventListenerOrEventListenerObject,
            options,
          );
        }
        if (type !== 'open' && type !== 'error' && type !== 'message') {
          const capture = getEventCapture(options);
          let listenersForType = wrappedListeners.get(type);
          if (!listenersForType) {
            listenersForType = new WeakMap();
            wrappedListeners.set(type, listenersForType);
          }

          let listenersForOptions = listenersForType.get(listener);
          if (!listenersForOptions) {
            listenersForOptions = new Map();
            listenersForType.set(listener, listenersForOptions);
          }

          let wrappedListener = listenersForOptions.get(capture);
          if (!wrappedListener) {
            wrappedListener = function (event: Event) {
              if (self.active) self.captureMessage(entry, event as MessageEvent, type);

              if (typeof listener === 'function') {
                listener.call(eventSource, event);
              } else {
                listener.handleEvent(event);
              }
            };
            listenersForOptions.set(capture, wrappedListener);
          }
          return originalAddEventListener(type, wrappedListener, options);
        }
        return originalAddEventListener(type, listener, options);
      };

      (eventSource as any).removeEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) {
        if (listener && type !== 'open' && type !== 'error' && type !== 'message') {
          const capture = getEventCapture(options);
          const listenersForType = wrappedListeners.get(type);
          const listenersForOptions = listenersForType?.get(listener);
          const wrappedListener = listenersForOptions?.get(capture);
          if (wrappedListener) {
            listenersForOptions?.delete(capture);
            if (listenersForOptions?.size === 0) listenersForType?.delete(listener);
            return originalRemoveEventListener(type, wrappedListener, options);
          }
        }
        return originalRemoveEventListener(
          type,
          listener as unknown as EventListenerOrEventListenerObject,
          options,
        );
      };

      // message 使用原始注册入口，避免经过上面的业务监听包装后重复采集。
      originalAddEventListener('message', ((event: MessageEvent) => {
        if (self.active) self.captureMessage(entry, event);
      }) as EventListener);

      eventSource.addEventListener('error', () => {
        if (!self.active) return;
        finishNetworkEntry(entry);
        entry.error = 'SSE Connection Error';
        self.sink.emitUpdate(entry);
      });

      return eventSource;
    } as unknown as typeof EventSource;

    Object.defineProperties(ProxiedEventSource, {
      CONNECTING: { value: OriginalEventSource.CONNECTING },
      OPEN: { value: OriginalEventSource.OPEN },
      CLOSED: { value: OriginalEventSource.CLOSED },
      prototype: { value: OriginalEventSource.prototype },
    });

    this.originalEventSource = OriginalEventSource;
    this.active = true;
    window.EventSource = ProxiedEventSource;
  }

  restore(): void {
    if (!this.active) return;
    this.active = false;
    if (this.originalEventSource) window.EventSource = this.originalEventSource;
    this.originalEventSource = null;
  }

  private captureMessage(entry: NetworkEntry, event: MessageEvent, eventName?: string): void {
    const timestamp = Date.now();
    const sseEvent: SSEEvent = {
      data: event.data,
      timestamp,
      id: event.lastEventId || undefined,
      event: eventName,
    };
    const message: StreamMessage = {
      direction: 'in',
      data: event.data,
      timestamp,
      event: eventName,
      size: typeof event.data === 'string' ? event.data.length : 0,
    };
    this.sink.pushSSEEvent(entry, sseEvent);
    this.sink.pushStreamMessage(entry, message);
  }
}
