/**
 * 控制台日志采集核心：接管浏览器日志、全局异常和流式消息，并维护内存中的日志条目。
 */
import type { LogEntry, LogLevel, LogSource, ConsoleOptions } from '../types';
import { EventEmitter } from '../utils/event-emitter';
import { nextId } from '../utils/time';

type ConsoleEvents = {
  entry: (entry: LogEntry) => void;
  clear: () => void;
  streamUpdate: (entry: LogEntry) => void;
};

const DEFAULT_OPTIONS: ConsoleOptions = {
  maxLogs: 10000,
  hookConsole: true,
  captureGlobalErrors: true,
};

/** 所有被接管的方法都在此白名单中，销毁时按同一列表精确恢复。 */
const LOG_LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

/**
   * 接管 window.console 并采集日志条目，同时支持 AI 流式日志的原地追加。
 */
export class ConsoleCore extends EventEmitter<ConsoleEvents> {
  private entries: LogEntry[] = [];
  private options: ConsoleOptions;
  /** 保存已绑定 this 的原始 console 方法，确保销毁后不遗留代理。 */
  private originals = new Map<LogLevel, (...args: unknown[]) => void>();
  private hooked = false;
  private globalErrorsBound = false;
  /** 以业务流 ID 合并分块消息，避免每个 token 都成为单独的日志条目。 */
  private streamBuffers = new Map<string, LogEntry>();
  private flushTimer: ReturnType<typeof requestAnimationFrame> | null = null;
  private pendingStreamEntries = new Set<LogEntry>();

  constructor(options?: Partial<ConsoleOptions>) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 开始拦截 console 方法及浏览器原生运行时异常 */
  init(): void {
    if (this.hooked) return;

    if (this.options.hookConsole) {
      for (const level of LOG_LEVELS) {
        const original = console[level].bind(console);
        this.originals.set(level, original);

        console[level] = (...args: unknown[]) => {
          // 先调用原方法，保证浏览器 DevTools 的可观测性不因采集而改变。
          original(...args);
          this.addEntry(level, args);
        };
      }
    }

    if (this.options.captureGlobalErrors) {
      this.bindGlobalErrorListeners();
    }

    this.hooked = true;
  }

  /** 规范化并写入日志条目，同时维持配置的内存上限。 */
  private addEntry(
    level: LogLevel,
    args: unknown[],
    options: { source?: LogSource; stack?: string } = {},
  ): void {
    // 若调用方没有提供栈，警告与错误在这里补充调用栈以便定位。
    let stack = options.stack;
    if (!stack && (level === 'error' || level === 'warn')) {
      const err = new Error();
      stack = err.stack?.split('\n').slice(3).join('\n');
    }

    const entry: LogEntry = {
      id: nextId(),
      level,
      args: this.cloneArgs(args),
      timestamp: Date.now(),
      stack,
      source: options.source ?? 'console',
    };

    this.entries.push(entry);
    this.trimEntries();

    this.emit('entry', entry);
  }

  /** 注册原生错误监听，不阻止浏览器继续在 DevTools 中报告异常。 */
  private bindGlobalErrorListeners(): void {
    if (this.globalErrorsBound) return;
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
    this.globalErrorsBound = true;
  }

  /** 销毁控制台时移除全局监听。 */
  private unbindGlobalErrorListeners(): void {
    if (!this.globalErrorsBound) return;
    window.removeEventListener('error', this.handleWindowError);
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
    this.globalErrorsBound = false;
  }

  /** 把未捕获的 window 错误写入与 console.error 相同的错误流。 */
  private handleWindowError = (event: ErrorEvent): void => {
    const error = getErrorDetails(event.error, 'Error', event.message || 'Uncaught error');
    this.addEntry(
      'error',
      [{
        ...error,
        filename: event.filename || undefined,
        line: event.lineno || undefined,
        column: event.colno || undefined,
      }],
      { source: 'window-error', stack: error.stack },
    );
  };

  /** 把没有处理器的 Promise 拒绝写入同一错误流。 */
  private handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const error = getErrorDetails(
      event.reason,
      'UnhandledPromiseRejection',
      'Promise rejected without an Error message',
    );
    this.addEntry(
      'error',
      [{
        ...error,
        reason: event.reason instanceof Error ? undefined : event.reason,
      }],
      { source: 'unhandled-rejection', stack: error.stack },
    );
  };

  /**
   * 新建或更新 AI 流式日志；相同 streamId 始终原地追加到同一条记录。
   */
  appendStream(streamId: string, chunk: string): void {
    let entry = this.streamBuffers.get(streamId);
    if (!entry) {
      entry = {
        id: nextId(),
        level: 'log',
        args: [chunk],
        timestamp: Date.now(),
        streamId,
        streaming: true,
        source: 'console',
      };
      this.streamBuffers.set(streamId, entry);
      this.entries.push(entry);
      this.trimEntries();
      this.emit('entry', entry);
    } else {
      // 同一流只更新首个参数，渲染层可据此稳定复用既有 DOM 行。
      entry.args = [(entry.args[0] as string) + chunk];
      this.scheduleStreamFlush(entry);
    }
  }

  /** 标记流式日志结束并通知视图移除“进行中”状态。 */
  endStream(streamId: string): void {
    const entry = this.streamBuffers.get(streamId);
    if (entry) {
      entry.streaming = false;
      this.streamBuffers.delete(streamId);
      this.cancelPendingStreamUpdate(entry);
      this.emit('streamUpdate', entry);
    }
  }

  /** 按动画帧批量发出流式更新，避免高频 token 导致主线程反复重排。 */
  private scheduleStreamFlush(entry: LogEntry): void {
    this.pendingStreamEntries.add(entry);
    if (this.flushTimer !== null) return;
    this.flushTimer = requestAnimationFrame(() => {
      this.flushTimer = null;
      for (const e of this.pendingStreamEntries) {
        this.emit('streamUpdate', e);
      }
      this.pendingStreamEntries.clear();
    });
  }

  /** 记录参数快照而非可变对象引用，保证历史日志不会随业务对象变化而失真。 */
  private cloneArgs(args: unknown[]): unknown[] {
    return args.map((arg) => {
      if (arg instanceof Error) {
        return { message: arg.message, stack: arg.stack, name: arg.name };
      }
      if (arg instanceof HTMLElement) {
        return `<${arg.tagName.toLowerCase()}>`;
      }
      if (arg instanceof Date) {
        return arg.toISOString();
      }
      if (arg instanceof RegExp) {
        return arg.toString();
      }
      if (arg instanceof Map) {
        try {
          return { __type: 'Map', entries: JSON.parse(JSON.stringify([...arg])) };
        } catch {
          return `Map(${arg.size})`;
        }
      }
      if (arg instanceof Set) {
        try {
          return { __type: 'Set', values: JSON.parse(JSON.stringify([...arg])) };
        } catch {
          return `Set(${arg.size})`;
        }
      }
      if (typeof arg === 'symbol') {
        return arg.toString();
      }
      if (typeof arg === 'function') {
        return `ƒ ${arg.name || 'anonymous'}()`;
      }
      // 普通对象使用 JSON 快照；无法序列化时退回字符串，采集流程不能因此中断。
      if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.parse(JSON.stringify(arg));
        } catch {
          return String(arg);
        }
      }
      return arg;
    });
  }

  /** 返回当前采集的日志条目。 */
  getEntries(): LogEntry[] {
    return this.entries;
  }

  /** 按级别与关键词筛选日志，供控制台面板直接消费。 */
  getFilteredEntries(levels?: LogLevel[], search?: string): LogEntry[] {
    let result = this.entries;
    if (levels && levels.length > 0) {
      result = result.filter((e) => levels.includes(e.level));
    }
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((e) =>
        e.args.some((arg) => String(arg).toLowerCase().includes(lower)),
      );
    }
    return result;
  }

  /** 清空普通与流式日志状态，并同步通知订阅者刷新。 */
  clear(): void {
    this.entries.length = 0;
    this.streamBuffers.clear();
    this.cancelPendingStreamUpdate();
    this.emit('clear');
  }

  /** 将当前日志导出为格式化 JSON。 */
  exportJSON(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  /** 恢复所有原生监听与 console 方法，释放调试器运行期资源。 */
  destroy(): void {
    if (!this.hooked) return;
    this.unbindGlobalErrorListeners();
    for (const level of LOG_LEVELS) {
      const original = this.originals.get(level);
      if (original) {
        console[level] = original as typeof console.log;
      }
    }
    this.originals.clear();
    this.hooked = false;
    this.cancelPendingStreamUpdate();
    this.removeAllListeners();
  }

  /** 统一执行容量淘汰，并同步释放已经不可见的流式状态。 */
  private trimEntries(): void {
    const overflow = this.entries.length - this.options.maxLogs;
    if (overflow <= 0) return;

    const removed = this.entries.splice(0, overflow);
    for (const entry of removed) {
      if (entry.streamId && this.streamBuffers.get(entry.streamId) === entry) {
        this.streamBuffers.delete(entry.streamId);
      }
      this.pendingStreamEntries.delete(entry);
    }
    if (this.pendingStreamEntries.size === 0) this.cancelPendingStreamUpdate();
  }

  /** 取消单条或全部待刷新流，防止 clear/end/destroy 后继续派发陈旧更新。 */
  private cancelPendingStreamUpdate(entry?: LogEntry): void {
    if (entry) {
      this.pendingStreamEntries.delete(entry);
    } else {
      this.pendingStreamEntries.clear();
    }
    if (this.pendingStreamEntries.size === 0 && this.flushTimer !== null) {
      cancelAnimationFrame(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/** 从浏览器错误载荷中提取稳定、可序列化的错误描述。 */
function getErrorDetails(
  value: unknown,
  fallbackName: string,
  fallbackMessage: string,
): { name: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      name: value.name || fallbackName,
      message: value.message || fallbackMessage,
      stack: value.stack,
    };
  }

  if (typeof value === 'string' && value) {
    return { name: fallbackName, message: value };
  }

  if (isErrorLike(value)) {
    return {
      name: value.name || fallbackName,
      message: value.message || fallbackMessage,
      stack: value.stack,
    };
  }

  return { name: fallbackName, message: fallbackMessage };
}

function isErrorLike(value: unknown): value is { name?: string; message?: string; stack?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (typeof candidate.name === 'string' || typeof candidate.message === 'string') &&
    (candidate.stack === undefined || typeof candidate.stack === 'string')
  );
}
