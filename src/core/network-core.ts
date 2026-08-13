/**
 * 网络采集核心：对外保持统一 API，对内只编排各协议拦截器与请求记录。
 */
import type { NetworkEntry, NetworkOptions } from '../types';
import { EventEmitter } from '../utils/event-emitter';
import { normalizeRetentionLimit } from '../utils/bounded-buffer';
import {
  getNconsolePerformanceIsolation,
  markNconsoleResourceRequest,
  type NconsolePerformanceIsolation,
} from '../utils/performance-isolation';
import { FetchInterceptor, markFetchAsNconsoleInternal } from './network/fetch-interceptor';
import { NetworkCaptureStore } from './network/network-capture';
import { SSEInterceptor } from './network/sse-interceptor';
import { WebSocketInterceptor } from './network/websocket-interceptor';
import { XHRInterceptor } from './network/xhr-interceptor';

type NetworkEvents = {
  request: (entry: NetworkEntry) => void;
  update: (entry: NetworkEntry, requiresTableRebuild: boolean) => void;
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

/**
 * NetworkCore 是稳定的公共外观；协议代理分别拥有各自的安装、采集和恢复生命周期。
 */
export class NetworkCore extends EventEmitter<NetworkEvents> {
  private readonly options: NetworkOptions;
  private readonly captureStore: NetworkCaptureStore;
  private readonly fetchInterceptor: FetchInterceptor;
  private readonly xhrInterceptor: XHRInterceptor;
  private readonly sseInterceptor: SSEInterceptor;
  private readonly webSocketInterceptor: WebSocketInterceptor;
  private readonly performanceIsolation = getNconsolePerformanceIsolation();
  private hooked = false;

  constructor(options?: Partial<NetworkOptions>) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.options.maxRequests = normalizeRetentionLimit(this.options.maxRequests, DEFAULT_OPTIONS.maxRequests);
    this.captureStore = new NetworkCaptureStore(
      this.options.maxRequests,
      (entry) => this.emit('request', entry),
      (entry, requiresTableRebuild) => this.emit('update', entry, requiresTableRebuild),
      () => this.emit('clear'),
    );
    this.fetchInterceptor = new FetchInterceptor(this.options, this.captureStore);
    this.xhrInterceptor = new XHRInterceptor(this.captureStore);
    this.sseInterceptor = new SSEInterceptor(this.captureStore);
    this.webSocketInterceptor = new WebSocketInterceptor(this.captureStore);
  }

  init(): void {
    if (this.hooked) return;

    try {
      if (this.options.hookFetch !== false) this.fetchInterceptor.install();
      if (this.options.hookXHR !== false) this.xhrInterceptor.install();
      if (this.options.hookSSE !== false) this.sseInterceptor.install();
      if (this.options.hookWebSocket !== false) this.webSocketInterceptor.install();
      this.hooked = true;
    } catch (error) {
      // 任一全局代理安装失败时回滚此前代理，避免留下半初始化状态。
      this.restoreInterceptors();
      throw error;
    }
  }

  /**
   * 为可信插件注册精确的 fetch 排除规则。
   * 规则只影响 Network 面板展示，不会修改或阻断真实网络请求。
   */
  addFetchIgnoreRule(rule: FetchIgnoreRule): () => void {
    return this.fetchInterceptor.addIgnoreRule(rule);
  }

  /**
   * 供可信插件发起内部 fetch：不进入 Network 面板，并同步登记到性能隔离层。
   * 标记随 RequestInit 穿过嵌套 Hook，不依赖易误伤业务请求的长期 URL 黑名单。
   */
  fetchInternal(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    markNconsoleResourceRequest(getRequestUrl(input));
    return window.fetch(input, markFetchAsNconsoleInternal(init));
  }

  /** 让独立插件复用当前 Core 的自身噪声登记表，避免各分包产生互不相识的隔离状态。 */
  getPerformanceIsolation(): NconsolePerformanceIsolation {
    return this.performanceIsolation;
  }

  getEntries(): NetworkEntry[] {
    return this.captureStore.getEntries();
  }

  clear(): void {
    this.captureStore.clear();
  }

  destroy(): void {
    if (!this.hooked) return;

    this.restoreInterceptors();
    this.captureStore.destroy();
    this.hooked = false;
    this.removeAllListeners();
  }

  private restoreInterceptors(): void {
    this.webSocketInterceptor.restore();
    this.sseInterceptor.restore();
    this.xhrInterceptor.restore();
    this.fetchInterceptor.restore();
  }
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
