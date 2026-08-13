import type { NetworkEntry, NetworkOptions } from '../../types';
import { nextId } from '../../utils/time';
import {
  createGlobalHook,
  detachGlobalHook,
  type GlobalHookHandle,
} from '../global-hook';
import { serializeBody } from './body-serialization';
import { finishNetworkEntry, type NetworkCaptureSink } from './network-capture';

export type FetchIgnoreRule = (url: string, method: string) => boolean;

const INTERNAL_FETCH_MARKER = Symbol.for('nconsole.internal-fetch.v1');
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

/** 给可信插件请求添加不可序列化标记，使所有嵌套 Nconsole fetch Hook 在读取敏感元数据前直接放行。 */
export function markFetchAsNconsoleInternal(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    [INTERNAL_FETCH_MARKER]: true,
  } as RequestInit;
}

function isNconsoleInternalFetch(init?: RequestInit): boolean {
  if (!init) return false;
  return Boolean((init as RequestInit & Record<PropertyKey, unknown>)[INTERNAL_FETCH_MARKER]);
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

function getContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (!raw) return null;

  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function isStreamingContentType(contentType: string): boolean {
  return STREAMING_CONTENT_TYPES.some((type) => contentType.includes(type)) || contentType.includes('stream');
}

/** 接管并恢复 fetch，独立管理响应副本读取与忽略规则。 */
export class FetchInterceptor {
  private fetchHook: GlobalHookHandle<typeof window.fetch> | null = null;
  private activeReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  private ignoreRules = new Set<FetchIgnoreRule>();
  private active = false;

  constructor(
    private readonly options: NetworkOptions,
    private readonly sink: NetworkCaptureSink,
  ) {}

  install(): void {
    if (this.active) return;

    const self = this;
    const fetchHook = createGlobalHook(window.fetch, (link) => async function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      if (!link.active) return link.previous.call(window, input, init);

      const url = getFetchURL(input);
      const method = getFetchMethod(input, init);

      // 先判断再读取 header/body，避免调试工具自身的凭据和诊断内容被记录下来。
      if (isNconsoleInternalFetch(init) || self.shouldIgnore(url, method)) {
        return link.previous.call(window, input, init);
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

      self.sink.addEntry(entry);

      try {
        const response = await link.previous.call(window, input, init);
        if (!self.active) return response;

        entry.status = response.status;
        entry.statusText = response.statusText;
        response.headers.forEach((value, key) => (entry.responseHeaders[key] = value));
        finishNetworkEntry(entry);
        if (!self.options.previewFetchResponseBody) {
          entry.responseBody = '[Fetch response body preview disabled]';
        }

        self.sink.emitUpdate(entry);
        if (self.options.previewFetchResponseBody) {
          self.startBodyCapture(response, entry, method);
        }
        return response;
      } catch (error) {
        if (self.active) {
          finishNetworkEntry(entry);
          entry.error = error instanceof Error ? error.message : String(error);
          self.sink.emitUpdate(entry);
        }
        throw error;
      }
    });

    this.fetchHook = fetchHook;
    this.active = true;
    window.fetch = fetchHook.hook;
  }

  addIgnoreRule(rule: FetchIgnoreRule): () => void {
    this.ignoreRules.add(rule);
    return () => this.ignoreRules.delete(rule);
  }

  restore(): void {
    this.ignoreRules.clear();
    if (!this.active) return;
    this.active = false;

    this.activeReaders.forEach((reader) => {
      void reader.cancel();
    });
    this.activeReaders.clear();

    if (this.fetchHook) {
      window.fetch = detachGlobalHook(window.fetch, this.fetchHook);
      this.fetchHook = null;
    }
  }

  private shouldIgnore(url: string, method: string): boolean {
    for (const rule of this.ignoreRules) {
      try {
        if (rule(url, method)) return true;
      } catch {
        // 不让一个插件的匹配异常影响业务 fetch。
      }
    }
    return false;
  }

  /** 响应刚返回时立即克隆，用副本异步读取预览，避免影响业务侧消费。 */
  private startBodyCapture(response: Response, entry: NetworkEntry, method: string): void {
    let clone: Response;
    try {
      clone = response.clone();
    } catch {
      entry.responseBody = '[Unable to read body]';
      this.sink.emitUpdate(entry);
      return;
    }

    void this.captureBody(clone, entry, method);
  }

  private async captureBody(response: Response, entry: NetworkEntry, method: string): Promise<void> {
    const skipReason = this.getBodySkipReason(response, method);
    if (skipReason === null || !this.active) return;
    if (skipReason) {
      entry.responseBody = skipReason;
      this.sink.emitUpdate(entry);
      return;
    }

    try {
      const contentType = response.headers.get('content-type')?.toLowerCase() || '';
      if (isStreamingContentType(contentType)) {
        await this.captureStream(response, entry);
        return;
      }

      const preview = await this.readTextPreview(response, MAX_BODY_PREVIEW_CHARS);
      if (!this.active) return;
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
      if (!this.active) return;
      entry.responseBody = '[Unable to read body]';
    }

    this.sink.emitUpdate(entry);
  }

  /** null 表示没有响应体，字符串表示跳过原因，undefined 表示允许读取。 */
  private getBodySkipReason(response: Response, method: string): string | null | undefined {
    if (method === 'HEAD' || [204, 205, 304].includes(response.status) || !response.body) return null;
    if (response.bodyUsed || response.body.locked) return '[Response body consumed by page]';

    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (isStreamingContentType(contentType)) return undefined;
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
    if (contentLength === null) return '[Response body preview skipped: unknown size]';
    if (contentLength === 0) return null;
    if (contentLength > MAX_BODY_PREVIEW_BYTES) return `[Response body omitted: ${contentLength} bytes]`;
    return undefined;
  }

  /** 逐块解码普通响应，达到上限后主动取消读取。 */
  private async readTextPreview(
    response: Response,
    maxChars: number,
  ): Promise<{ text: string; truncated: boolean }> {
    if (!response.body) return { text: '', truncated: false };

    const reader = response.body.getReader();
    this.activeReaders.add(reader);
    const decoder = new TextDecoder();
    let text = '';
    let truncated = false;

    try {
      while (this.active) {
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

      if (!truncated && this.active) text += decoder.decode();
    } finally {
      this.activeReaders.delete(reader);
      try {
        reader.releaseLock();
      } catch {
        // 某些浏览器在取消读取后已自动释放锁。
      }
    }

    return { text, truncated };
  }

  /** 实时读取流式响应并持续更新同一请求条目。 */
  private async captureStream(response: Response, entry: NetworkEntry): Promise<void> {
    if (!response.body) return;

    const reader = response.body.getReader();
    this.activeReaders.add(reader);
    const decoder = new TextDecoder();
    const configuredLimit = this.options.maxFetchStreamResponseChars ?? 1_000_000;
    const maxChars = Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : 1_000_000;
    let text = '';
    let truncated = false;

    entry.streaming = true;
    entry.responseBody = '';
    this.sink.emitUpdate(entry);

    try {
      while (this.active) {
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
        this.sink.scheduleUpdate(entry);
      }

      if (!truncated && this.active) text += decoder.decode();
      if (this.active) entry.responseBody = truncated ? `${text}...(truncated)` : text;
    } catch {
      if (this.active) entry.responseBody = text || '[Unable to read body]';
    } finally {
      this.activeReaders.delete(reader);
      entry.streaming = false;
      try {
        reader.releaseLock();
      } catch {
        // 某些浏览器在取消读取后已自动释放锁。
      }
    }

    if (this.active) this.sink.emitUpdate(entry);
  }
}
