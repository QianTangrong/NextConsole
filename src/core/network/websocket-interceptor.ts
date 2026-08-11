import type { NetworkEntry, StreamMessage } from '../../types';
import { nextId } from '../../utils/time';
import {
  createGlobalHook,
  detachGlobalHook,
  type GlobalHookHandle,
} from '../global-hook';
import { finishNetworkEntry, type NetworkCaptureSink } from './network-capture';

/** 代理 WebSocket 构造器与收发方法，并阻止销毁后的连接继续写入采集状态。 */
export class WebSocketInterceptor {
  private webSocketHook: GlobalHookHandle<typeof WebSocket> | null = null;
  private active = false;

  constructor(private readonly sink: NetworkCaptureSink) {}

  install(): void {
    if (this.active || typeof window.WebSocket === 'undefined') return;

    const self = this;
    const webSocketHook = createGlobalHook(window.WebSocket, (link) => function (
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ) {
      const CurrentWebSocket = link.previous;
      if (!link.active) return new CurrentWebSocket(url, protocols);

      const webSocket = new CurrentWebSocket(url, protocols);
      const entry: NetworkEntry = {
        id: nextId(),
        type: 'websocket',
        method: 'WS',
        url: String(url),
        requestHeaders: {},
        requestBody: null,
        status: 0,
        statusText: 'WebSocket',
        responseHeaders: {},
        responseBody: null,
        startTime: performance.now(),
        endTime: 0,
        duration: 0,
        pending: true,
        messages: [],
      };

      if (self.active) self.sink.addEntry(entry);

      webSocket.addEventListener('open', () => {
        if (!self.active) return;
        entry.status = 101;
        entry.statusText = 'Switching Protocols';
        self.sink.emitUpdate(entry);
      });

      webSocket.addEventListener('message', (event: MessageEvent) => {
        if (!self.active) return;
        const message: StreamMessage = {
          direction: 'in',
          data: typeof event.data === 'string' ? event.data : '[Binary]',
          timestamp: Date.now(),
          size: typeof event.data === 'string' ? event.data.length : (event.data as ArrayBuffer)?.byteLength || 0,
        };
        self.sink.pushStreamMessage(entry, message);
      });

      webSocket.addEventListener('close', (event: CloseEvent) => {
        if (!self.active) return;
        finishNetworkEntry(entry);
        entry.statusText = `Closed (${event.code})`;
        self.sink.emitUpdate(entry);
      });

      webSocket.addEventListener('error', () => {
        if (!self.active) return;
        finishNetworkEntry(entry);
        entry.error = 'WebSocket Error';
        self.sink.emitUpdate(entry);
      });

      const originalSend = webSocket.send.bind(webSocket);
      webSocket.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (self.active) {
          const message: StreamMessage = {
            direction: 'out',
            data: typeof data === 'string' ? data : '[Binary]',
            timestamp: Date.now(),
            size: typeof data === 'string' ? data.length : (data as ArrayBuffer)?.byteLength || 0,
          };
          self.sink.pushStreamMessage(entry, message);
        }
        return originalSend(data);
      };

      return webSocket;
    } as unknown as typeof WebSocket);

    Object.defineProperties(webSocketHook.hook, {
      CONNECTING: { value: window.WebSocket.CONNECTING },
      OPEN: { value: window.WebSocket.OPEN },
      CLOSING: { value: window.WebSocket.CLOSING },
      CLOSED: { value: window.WebSocket.CLOSED },
      prototype: { value: window.WebSocket.prototype },
    });

    this.webSocketHook = webSocketHook;
    this.active = true;
    window.WebSocket = webSocketHook.hook;
  }

  restore(): void {
    if (!this.active) return;
    this.active = false;
    if (this.webSocketHook) {
      window.WebSocket = detachGlobalHook(window.WebSocket, this.webSocketHook);
      this.webSocketHook = null;
    }
  }
}
