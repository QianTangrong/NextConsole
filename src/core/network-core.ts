import type { NetworkEntry, NetworkOptions, SSEEvent, StreamMessage } from '../types';
import { EventEmitter } from '../utils/event-emitter';
import { nextId } from '../utils/time';

type NetworkEvents = {
  request: (entry: NetworkEntry) => void;
  update: (entry: NetworkEntry) => void;
  clear: () => void;
};

type FetchIgnoreRule = (url: string, method: string) => boolean;

const DEFAULT_OPTIONS: NetworkOptions = {
  maxRequests: 500,
  hookFetch: true,
  hookXHR: true,
  hookSSE: true,
  hookWebSocket: true,
  previewFetchResponseBody: false,
  maxFetchStreamResponseChars: 1_000_000,
};

const MAX_MESSAGES = 1000;
const MAX_BODY_PREVIEW_CHARS = 10000;
const MAX_BODY_PREVIEW_BYTES = 10000;
const STREAMING_CONTENT_TYPES = [
  'text/event-stream',
  'application/x-ndjson',
  'application/json-seq',
  'application/jsonl',
];
const BINARY_CONTENT_TYPES = [
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
];

function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

function getFetchURL(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function getFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method || (isRequest(input) ? input.method : 'GET')).toUpperCase();
}

function collectFetchHeaders(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const headers = new Headers(isRequest(input) ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  const result: Record<string, string> = {};
  headers.forEach((value, key) => (result[key] = value));
  return result;
}

function getEventCapture(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
  return typeof options === 'boolean' ? options : Boolean(options?.capture);
}

function getContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (!raw) return null;

  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function isStreamingContentType(contentType: string): boolean {
  return STREAMING_CONTENT_TYPES.some((type) => contentType.includes(type)) || contentType.includes('stream');
}

/** Serialize request body for display */
function serializeBody(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const obj: Record<string, string> = {};
    body.forEach((v, k) => { obj[k] = typeof v === 'string' ? v : `[File: ${(v as File).name}]`; });
    return obj;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return `[Blob: ${body.size} bytes]`;
  if (body instanceof ArrayBuffer) return `[ArrayBuffer: ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[${body.constructor.name}: ${body.byteLength} bytes]`;
  return String(body);
}

function serializeXHRResponse(xhr: XMLHttpRequest): unknown {
  const responseType = xhr.responseType || 'text';

  if (responseType === 'json') {
    return xhr.response;
  }
  if (responseType === 'blob') {
    const blob = xhr.response as Blob | null;
    return blob ? `[Blob: ${blob.size} bytes]` : '[Blob]';
  }
  if (responseType === 'arraybuffer') {
    const buffer = xhr.response as ArrayBuffer | null;
    return buffer ? `[ArrayBuffer: ${buffer.byteLength} bytes]` : '[ArrayBuffer]';
  }
  if (responseType === 'document') {
    const doc = xhr.response as Document | null;
    return doc ? `[Document: ${doc.contentType || 'unknown'}]` : '[Document]';
  }

  try {
    const contentType = xhr.getResponseHeader('content-type') || '';
    const text = xhr.responseText || '';
    const bodyText = text.length > MAX_BODY_PREVIEW_CHARS
      ? `${text.slice(0, MAX_BODY_PREVIEW_CHARS)}...(truncated)`
      : text;

    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(text);
      } catch {
        return bodyText;
      }
    }

    return bodyText;
  } catch {
    return '[Unable to read body]';
  }
}

/**
 * NetworkCore hooks into fetch, XMLHttpRequest, and EventSource
 * to capture network activity including SSE streams.
 */
export class NetworkCore extends EventEmitter<NetworkEvents> {
  private entries: NetworkEntry[] = [];
  private options: NetworkOptions;
  private originalFetch: typeof window.fetch | null = null;
  private originalXHR: typeof XMLHttpRequest.prototype.open | null = null;
  private originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null;
  private originalXHRSetHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;
  private originalEventSource: typeof EventSource | null = null;
  private originalWebSocket: typeof WebSocket | null = null;
  private scheduledStreamUpdates = new Map<number, { type: 'raf' | 'timeout'; handle: number }>();
  private fetchIgnoreRules = new Set<FetchIgnoreRule>();
  private hooked = false;

  constructor(options?: Partial<NetworkOptions>) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  init(): void {
    if (this.hooked) return;
    if (this.options.hookFetch) this.hookFetch();
    if (this.options.hookXHR) this.hookXHR();
    if (this.options.hookSSE) this.hookSSE();
    if (this.options.hookWebSocket) this.hookWebSocket();
    this.hooked = true;
  }

  private hookFetch(): void {
    this.originalFetch = window.fetch.bind(window);
    const self = this;
    const origFetch = this.originalFetch;

    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = getFetchURL(input);
      const method = getFetchMethod(input, init);

      // 先判断再读取 header/body，避免调试工具自身的凭据和诊断内容被记录下来。
      if (self.shouldIgnoreFetch(url, method)) {
        return origFetch(input, init);
      }
      const requestHeaders = collectFetchHeaders(input, init);

      const entry: NetworkEntry = {
        id: nextId(),
        type: 'fetch',
        method,
        url,
        requestHeaders,
        requestBody: serializeBody(init?.body),
        status: 0,
        statusText: '',
        responseHeaders: {},
        responseBody: null,
        startTime: performance.now(),
        endTime: 0,
        duration: 0,
        pending: true,
      };

      self.addEntry(entry);

      try {
        const response = await origFetch(input, init);

        entry.status = response.status;
        entry.statusText = response.statusText;
        response.headers.forEach((v, k) => (entry.responseHeaders[k] = v));
        entry.endTime = performance.now();
        entry.duration = entry.endTime - entry.startTime;
        entry.pending = false;
        if (!self.options.previewFetchResponseBody) {
          entry.responseBody = '[Fetch response body preview disabled]';
        }

        self.emit('update', entry);
        if (self.options.previewFetchResponseBody) {
          self.startFetchBodyCapture(response, entry, method);
        }
        return response;
      } catch (err) {
        entry.endTime = performance.now();
        entry.duration = entry.endTime - entry.startTime;
        entry.pending = false;
        entry.error = err instanceof Error ? err.message : String(err);
        self.emit('update', entry);
        throw err;
      }
    };
  }

  /**
   * 为可信插件注册精确的 fetch 排除规则。
   * 规则只影响 Network 面板展示，不会修改或阻断真实网络请求。
   */
  addFetchIgnoreRule(rule: FetchIgnoreRule): () => void {
    this.fetchIgnoreRules.add(rule);
    return () => this.fetchIgnoreRules.delete(rule);
  }

  private shouldIgnoreFetch(url: string, method: string): boolean {
    for (const rule of this.fetchIgnoreRules) {
      try {
        if (rule(url, method)) return true;
      } catch {
        // 不让一个插件的匹配异常影响业务 fetch。
      }
    }
    return false;
  }

  private startFetchBodyCapture(response: Response, entry: NetworkEntry, method: string): void {
    let clone: Response;
    try {
      // 在业务代码消费原始 Response 前立即创建副本，避免流已被锁定。
      clone = response.clone();
    } catch {
      entry.responseBody = '[Unable to read body]';
      this.emit('update', entry);
      return;
    }

    void this.captureFetchBody(clone, entry, method);
  }

  private async captureFetchBody(response: Response, entry: NetworkEntry, method: string): Promise<void> {
    const skipReason = this.getBodySkipReason(response, method);
    if (skipReason === null) return;
    if (skipReason) {
      entry.responseBody = skipReason;
      this.emit('update', entry);
      return;
    }

    try {
      const contentType = response.headers.get('content-type')?.toLowerCase() || '';
      if (isStreamingContentType(contentType)) {
        await this.captureFetchStream(response, entry);
        return;
      }

      const preview = await this.readTextPreview(response, MAX_BODY_PREVIEW_CHARS);
      const bodyText = preview.truncated ? `${preview.text}...(truncated)` : preview.text;

      if (!preview.truncated && contentType.includes('json')) {
        try {
          entry.responseBody = JSON.parse(preview.text);
        } catch {
          entry.responseBody = bodyText;
        }
      } else {
        entry.responseBody = bodyText;
      }
    } catch {
      entry.responseBody = '[Unable to read body]';
    }

    this.emit('update', entry);
  }

  private getBodySkipReason(response: Response, method: string): string | null | undefined {
    if (method === 'HEAD' || [204, 205, 304].includes(response.status) || !response.body) {
      return null;
    }

    if (response.bodyUsed || response.body.locked) {
      return '[Response body consumed by page]';
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (isStreamingContentType(contentType)) {
      return undefined;
    }
    if (
      contentType.startsWith('image/') ||
      contentType.startsWith('audio/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('font/') ||
      BINARY_CONTENT_TYPES.some((type) => contentType.includes(type))
    ) {
      return '[Binary response body omitted]';
    }

    const contentLength = getContentLength(response);
    if (contentLength === null) {
      return '[Response body preview skipped: unknown size]';
    }
    if (contentLength === 0) {
      return null;
    }
    if (contentLength > MAX_BODY_PREVIEW_BYTES) {
      return `[Response body omitted: ${contentLength} bytes]`;
    }

    return undefined;
  }

  private async readTextPreview(response: Response, maxChars: number): Promise<{ text: string; truncated: boolean }> {
    if (!response.body) return { text: '', truncated: false };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let truncated = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        text += decoder.decode(value, { stream: true });
        if (text.length > maxChars) {
          text = text.slice(0, maxChars);
          truncated = true;
          await reader.cancel();
          break;
        }
      }

      if (!truncated) {
        text += decoder.decode();
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released after cancelation in some browsers.
      }
    }

    return { text, truncated };
  }

  private async captureFetchStream(response: Response, entry: NetworkEntry): Promise<void> {
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const configuredLimit = this.options.maxFetchStreamResponseChars ?? 1_000_000;
    const maxChars = Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : 1_000_000;
    let text = '';
    let truncated = false;

    entry.streaming = true;
    entry.responseBody = '';
    this.emit('update', entry);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        text += decoder.decode(value, { stream: true });
        if (maxChars > 0 && text.length > maxChars) {
          text = text.slice(0, maxChars);
          truncated = true;
          void reader.cancel();
          break;
        }

        entry.responseBody = text;
        this.scheduleStreamUpdate(entry);
      }

      if (!truncated) {
        text += decoder.decode();
      }
      entry.responseBody = truncated ? `${text}...(truncated)` : text;
    } catch {
      entry.responseBody = text || '[Unable to read body]';
    } finally {
      entry.streaming = false;
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released after cancelation in some browsers.
      }
    }

    this.emit('update', entry);
  }

  private pushSSEEvent(entry: NetworkEntry, event: SSEEvent): void {
    const events = entry.sseEvents;
    if (!events) return;
    if (events.length >= MAX_MESSAGES) {
      events.splice(0, events.length - MAX_MESSAGES + 100);
    }
    events.push(event);
  }

  private pushStreamMessage(entry: NetworkEntry, message: StreamMessage): void {
    const messages = entry.messages;
    if (!messages) return;
    if (messages.length >= MAX_MESSAGES) {
      messages.splice(0, messages.length - MAX_MESSAGES + 100);
    }
    messages.push(message);
    this.scheduleStreamUpdate(entry);
  }

  private scheduleStreamUpdate(entry: NetworkEntry): void {
    if (this.scheduledStreamUpdates.has(entry.id)) return;

    const flush = () => {
      this.scheduledStreamUpdates.delete(entry.id);
      this.emit('update', entry);
    };

    if (typeof window.requestAnimationFrame === 'function') {
      const handle = window.requestAnimationFrame(flush);
      this.scheduledStreamUpdates.set(entry.id, { type: 'raf', handle });
      return;
    }

    const handle = window.setTimeout(flush, 16);
    this.scheduledStreamUpdates.set(entry.id, { type: 'timeout', handle });
  }

  private cancelScheduledStreamUpdate(entry: NetworkEntry): void {
    const scheduled = this.scheduledStreamUpdates.get(entry.id);
    if (!scheduled) return;

    if (scheduled.type === 'raf') {
      window.cancelAnimationFrame(scheduled.handle);
    } else {
      window.clearTimeout(scheduled.handle);
    }
    this.scheduledStreamUpdates.delete(entry.id);
  }

  private emitUpdateNow(entry: NetworkEntry): void {
    this.cancelScheduledStreamUpdate(entry);
    this.emit('update', entry);
  }

  private hookXHR(): void {
    const self = this;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    this.originalXHR = origOpen;
    this.originalXHRSend = origSend;
    this.originalXHRSetHeader = origSetHeader;

    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest & { _nc_entry?: NetworkEntry; _nc_headers?: Record<string, string> },
      method: string,
      url: string | URL,
    ) {
      this._nc_headers = {};
      this._nc_entry = {
        id: nextId(),
        type: 'xhr',
        method: method.toUpperCase(),
        url: String(url),
        requestHeaders: this._nc_headers,
        requestBody: null,
        status: 0,
        statusText: '',
        responseHeaders: {},
        responseBody: null,
        startTime: 0,
        endTime: 0,
        duration: 0,
        pending: true,
      };

      return origOpen.apply(this, arguments as any);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (
      this: XMLHttpRequest & { _nc_headers?: Record<string, string> },
      name: string,
      value: string,
    ) {
      if (this._nc_headers) {
        this._nc_headers[name] = value;
      }
      return origSetHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest & { _nc_entry?: NetworkEntry },
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const entry = this._nc_entry;
      if (entry) {
        entry.startTime = performance.now();
        entry.requestBody = serializeBody(body);
        self.addEntry(entry);

        this.addEventListener('loadend', () => {
          entry.status = this.status;
          entry.statusText = this.statusText;
          entry.endTime = performance.now();
          entry.duration = entry.endTime - entry.startTime;
          entry.pending = false;

          // Parse response headers
          const headerStr = this.getAllResponseHeaders();
          if (headerStr) {
            headerStr.split('\r\n').forEach((line) => {
              const idx = line.indexOf(':');
              if (idx > 0) {
                entry.responseHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
              }
            });
          }

          entry.responseBody = serializeXHRResponse(this);

          self.emit('update', entry);
        });

        this.addEventListener('error', () => {
          entry.endTime = performance.now();
          entry.duration = entry.endTime - entry.startTime;
          entry.pending = false;
          entry.error = 'Network Error';
          self.emit('update', entry);
        });
      }

      return origSend.call(this, body);
    };
  }

  private hookSSE(): void {
    if (typeof EventSource === 'undefined') return;
    const self = this;
    const OrigES = EventSource;
    this.originalEventSource = OrigES;

    const ProxiedES = function (this: EventSource, url: string | URL, init?: EventSourceInit) {
      const es = new OrigES(url, init);
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

      self.addEntry(entry);

      es.addEventListener('open', () => {
        entry.status = 200;
        self.emit('update', entry);
      });

      // Capture all messages (including named events via onmessage)
      const origAddEventListener = es.addEventListener.bind(es);
      const origRemoveEventListener = es.removeEventListener.bind(es);
      const wrappedListeners = new Map<string, WeakMap<EventListenerOrEventListenerObject, Map<boolean, EventListener>>>();

      (es as any).addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        if (!listener) {
          return origAddEventListener(type, listener as unknown as EventListenerOrEventListenerObject, options);
        }
        if (type !== 'open' && type !== 'error' && type !== 'message') {
          // Wrap to capture named events (message events are captured by the internal handler below)
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
            wrappedListener = function (e: Event) {
              const me = e as MessageEvent;
              const sseEvent: SSEEvent = {
                data: me.data,
                timestamp: Date.now(),
                id: me.lastEventId || undefined,
                event: type,
              };
              self.pushSSEEvent(entry, sseEvent);
              const msg: StreamMessage = {
                direction: 'in',
                data: me.data,
                timestamp: Date.now(),
                event: type,
                size: typeof me.data === 'string' ? me.data.length : 0,
              };
              self.pushStreamMessage(entry, msg);

              if (typeof listener === 'function') {
                listener.call(es, e);
              } else {
                listener.handleEvent(e);
              }
            };
            listenersForOptions.set(capture, wrappedListener);
          }
          return origAddEventListener(type, wrappedListener as EventListener, options);
        }
        return origAddEventListener(type, listener, options);
      };

      (es as any).removeEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
        if (listener && type !== 'open' && type !== 'error' && type !== 'message') {
          const listenersForType = wrappedListeners.get(type);
          const listenersForOptions = listenersForType?.get(listener);
          const wrappedListener = listenersForOptions?.get(getEventCapture(options));
          if (wrappedListener) {
            listenersForOptions?.delete(getEventCapture(options));
            if (listenersForOptions?.size === 0) {
              listenersForType?.delete(listener);
            }
            return origRemoveEventListener(type, wrappedListener, options);
          }
        }
        return origRemoveEventListener(type, listener as unknown as EventListenerOrEventListenerObject, options);
      };

      // Capture all messages via original addEventListener to avoid double recording
      origAddEventListener('message', ((e: MessageEvent) => {
        const sseEvent: SSEEvent = {
          data: e.data,
          timestamp: Date.now(),
          id: e.lastEventId || undefined,
        };
        self.pushSSEEvent(entry, sseEvent);
        const msg: StreamMessage = {
          direction: 'in',
          data: e.data,
          timestamp: Date.now(),
          size: typeof e.data === 'string' ? e.data.length : 0,
        };
        self.pushStreamMessage(entry, msg);
      }) as EventListener);

      es.addEventListener('error', () => {
        entry.pending = false;
        entry.endTime = performance.now();
        entry.duration = entry.endTime - entry.startTime;
        entry.error = 'SSE Connection Error';
        self.emitUpdateNow(entry);
      });

      return es;
    } as unknown as typeof EventSource;

    Object.defineProperties(ProxiedES, {
      CONNECTING: { value: OrigES.CONNECTING },
      OPEN: { value: OrigES.OPEN },
      CLOSED: { value: OrigES.CLOSED },
      prototype: { value: OrigES.prototype },
    });

    (window as any).EventSource = ProxiedES;
  }

  private hookWebSocket(): void {
    if (typeof WebSocket === 'undefined') return;
    const self = this;
    const OrigWS = WebSocket;
    this.originalWebSocket = OrigWS;

    const ProxiedWS = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const ws = new OrigWS(url, protocols);
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

      self.addEntry(entry);

      ws.addEventListener('open', () => {
        entry.status = 101;
        entry.statusText = 'Switching Protocols';
        self.emit('update', entry);
      });

      ws.addEventListener('message', (e: MessageEvent) => {
        const data = typeof e.data === 'string' ? e.data : '[Binary]';
        const msg: StreamMessage = {
          direction: 'in',
          data,
          timestamp: Date.now(),
          size: typeof e.data === 'string' ? e.data.length : (e.data as ArrayBuffer)?.byteLength || 0,
        };
        self.pushStreamMessage(entry, msg);
      });

      ws.addEventListener('close', (e: CloseEvent) => {
        entry.pending = false;
        entry.endTime = performance.now();
        entry.duration = entry.endTime - entry.startTime;
        entry.statusText = `Closed (${e.code})`;
        self.emitUpdateNow(entry);
      });

      ws.addEventListener('error', () => {
        entry.pending = false;
        entry.endTime = performance.now();
        entry.duration = entry.endTime - entry.startTime;
        entry.error = 'WebSocket Error';
        self.emitUpdateNow(entry);
      });

      // Hook send to capture outgoing messages
      const origSend = ws.send.bind(ws);
      ws.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const text = typeof data === 'string' ? data : '[Binary]';
        const msg: StreamMessage = {
          direction: 'out',
          data: text,
          timestamp: Date.now(),
          size: typeof data === 'string' ? data.length : (data as ArrayBuffer)?.byteLength || 0,
        };
        self.pushStreamMessage(entry, msg);
        return origSend(data);
      };

      return ws;
    } as unknown as typeof WebSocket;

    Object.defineProperties(ProxiedWS, {
      CONNECTING: { value: OrigWS.CONNECTING },
      OPEN: { value: OrigWS.OPEN },
      CLOSING: { value: OrigWS.CLOSING },
      CLOSED: { value: OrigWS.CLOSED },
      prototype: { value: OrigWS.prototype },
    });

    (window as any).WebSocket = ProxiedWS;
  }

  private addEntry(entry: NetworkEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.options.maxRequests) {
      this.entries.splice(0, this.entries.length - this.options.maxRequests);
    }
    this.emit('request', entry);
  }

  getEntries(): NetworkEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries.length = 0;
    this.emit('clear');
  }

  destroy(): void {
    if (!this.hooked) return;

    this.scheduledStreamUpdates.forEach((scheduled) => {
      if (scheduled.type === 'raf') {
        window.cancelAnimationFrame(scheduled.handle);
      } else {
        window.clearTimeout(scheduled.handle);
      }
    });
    this.scheduledStreamUpdates.clear();
    this.fetchIgnoreRules.clear();

    if (this.originalFetch) {
      window.fetch = this.originalFetch;
    }
    if (this.originalXHR) {
      XMLHttpRequest.prototype.open = this.originalXHR;
    }
    if (this.originalXHRSend) {
      XMLHttpRequest.prototype.send = this.originalXHRSend;
    }
    if (this.originalXHRSetHeader) {
      XMLHttpRequest.prototype.setRequestHeader = this.originalXHRSetHeader;
    }
    if (this.originalEventSource) {
      (window as any).EventSource = this.originalEventSource;
    }
    if (this.originalWebSocket) {
      (window as any).WebSocket = this.originalWebSocket;
    }

    this.hooked = false;
    this.removeAllListeners();
  }
}
