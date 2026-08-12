/**
 * 控制台日志采集核心：接管浏览器日志、全局异常和流式消息，并维护内存中的日志条目。
 */
import type { LogEntry, LogLevel, LogSource, ConsoleOptions } from '../types';
import { EventEmitter } from '../utils/event-emitter';
import { nextId } from '../utils/time';
import { BoundedBuffer, normalizeRetentionLimit } from '../utils/bounded-buffer';
import { snapshotValue } from '../utils/snapshot';
import {
  createGlobalHook,
  detachGlobalHook,
  type GlobalHookHandle,
} from './global-hook';

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
const MAX_STREAM_CHARS = 100_000;

/** 所有被接管的方法都在此白名单中，销毁时按同一列表精确恢复。 */
const LOG_LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
type ConsoleMethod = (...args: unknown[]) => void;

/**
   * 接管 window.console 并采集日志条目，同时支持 AI 流式日志的原地追加。
 */
export class ConsoleCore extends EventEmitter<ConsoleEvents> {
  private entries: BoundedBuffer<LogEntry>;
  private options: ConsoleOptions;
  /** 保存每个 console 包装器的链路句柄，支持多个 Core 乱序销毁。 */
  private consoleHooks = new Map<LogLevel, GlobalHookHandle<ConsoleMethod>>();
  private hooked = false;
  private globalErrorsBound = false;
  /** 以业务流 ID 合并分块消息，避免每个 token 都成为单独的日志条目。 */
  private streamBuffers = new Map<string, LogEntry>();
  private flushTimer: ReturnType<typeof requestAnimationFrame> | null = null;
  private pendingStreamEntries = new Set<LogEntry>();

  constructor(options?: Partial<ConsoleOptions>) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.options.maxLogs = normalizeRetentionLimit(this.options.maxLogs, DEFAULT_OPTIONS.maxLogs);
    this.entries = new BoundedBuffer(this.options.maxLogs);
  }

  /** 开始拦截 console 方法及浏览器原生运行时异常 */
  init(): void {
    if (this.hooked) return;

    try {
      if (this.options.hookConsole !== false) {
        for (const level of LOG_LEVELS) {
          const hook = createGlobalHook(console[level] as ConsoleMethod, (link) => (...args: unknown[]) => {
            // 先调用原方法，保证浏览器 DevTools 的可观测性不因采集而改变。
            Reflect.apply(link.previous, console, args);
            if (link.active) this.addEntry(level, args);
          });
          this.consoleHooks.set(level, hook);
          console[level] = hook.hook as typeof console.log;
        }
      }

      if (this.options.captureGlobalErrors !== false) {
        this.bindGlobalErrorListeners();
      }

      this.hooked = true;
    } catch (error) {
      // 任一安装步骤失败时立即撤销已经完成的 Hook，避免留下半初始化的全局状态。
      this.unbindGlobalErrorListeners();
      this.restoreConsoleHooks();
      throw error;
    }
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

    this.storeEntry(entry);

    this.emit('entry', entry);
  }

  /** 注册原生错误监听，不阻止浏览器继续在 DevTools 中报告异常。 */
  private bindGlobalErrorListeners(): void {
    if (this.globalErrorsBound) return;
    window.addEventListener('error', this.handleWindowError);
    try {
      window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
    } catch (error) {
      window.removeEventListener('error', this.handleWindowError);
      throw error;
    }
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
        args: [truncateStreamText(chunk)],
        timestamp: Date.now(),
        streamId,
        streaming: true,
        source: 'console',
      };
      this.streamBuffers.set(streamId, entry);
      this.storeEntry(entry);
      this.emit('entry', entry);
    } else {
      // 同一流只更新首个参数，渲染层可据此稳定复用既有 DOM 行。
      const current = entry.args[0] as string;
      if (current.length <= MAX_STREAM_CHARS && chunk.length > 0) {
        const next = truncateStreamText(current + chunk);
        entry.args = [next];
        this.scheduleStreamFlush(entry);
      }
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
    return snapshotValue(args.map((arg) => arg instanceof Error
      ? getErrorDetails(arg, 'Error', 'Unknown error')
      : arg)) as unknown[];
  }

  /** 返回当前采集的日志条目。 */
  getEntries(): LogEntry[] {
    return this.entries.toArray();
  }

  getEntryCount(): number {
    return this.entries.size;
  }

  /** 按级别与关键词筛选日志，供控制台面板直接消费。 */
  getFilteredEntries(levels?: LogLevel[], search?: string): LogEntry[] {
    let result = this.entries.toArray();
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
    this.entries.clear();
    this.streamBuffers.clear();
    this.cancelPendingStreamUpdate();
    this.emit('clear');
  }

  /** 将当前日志导出为格式化 JSON。 */
  exportJSON(): string {
    return JSON.stringify(this.entries.toArray(), null, 2);
  }

  /** 恢复所有原生监听与 console 方法，释放调试器运行期资源。 */
  destroy(): void {
    if (!this.hooked && this.consoleHooks.size === 0 && !this.globalErrorsBound) return;
    this.unbindGlobalErrorListeners();
    this.restoreConsoleHooks();
    this.hooked = false;
    this.cancelPendingStreamUpdate();
    this.streamBuffers.clear();
    this.removeAllListeners();
  }

  /** 按当前全局链路逐个摘除本实例安装的 console 包装器。 */
  private restoreConsoleHooks(): void {
    for (const level of LOG_LEVELS) {
      const hook = this.consoleHooks.get(level);
      if (hook) {
        const current = console[level] as ConsoleMethod;
        const restored = detachGlobalHook(current, hook);
        if (restored !== current) {
          try {
            console[level] = restored as typeof console.log;
          } catch {
            // 属性被外部冻结时无法换回引用；包装器已失效，仍会无副作用透传。
          }
        }
      }
    }
    this.consoleHooks.clear();
  }

  /** 写入环形缓冲并同步释放被淘汰日志关联的流式状态。 */
  private storeEntry(entry: LogEntry): void {
    const removed = this.entries.push(entry);
    if (!removed) return;
    if (removed.streamId && this.streamBuffers.get(removed.streamId) === removed) {
      this.streamBuffers.delete(removed.streamId);
    }
    this.pendingStreamEntries.delete(removed);
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

function truncateStreamText(value: string): string {
  return value.length > MAX_STREAM_CHARS
    ? `${value.slice(0, MAX_STREAM_CHARS)}...(truncated)`
    : value;
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
