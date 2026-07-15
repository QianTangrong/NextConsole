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

const LOG_LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

/**
 * ConsoleCore hooks into window.console and captures log entries.
 * Supports AI streaming log buffering.
 */
export class ConsoleCore extends EventEmitter<ConsoleEvents> {
  private entries: LogEntry[] = [];
  private options: ConsoleOptions;
  private originals = new Map<LogLevel, (...args: unknown[]) => void>();
  private hooked = false;
  private globalErrorsBound = false;
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
          // Call original first so dev tools still work
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

  /** Add a log entry */
  private addEntry(
    level: LogLevel,
    args: unknown[],
    options: { source?: LogSource; stack?: string } = {},
  ): void {
    // Capture stack trace for error logs
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

    // Enforce max logs limit
    if (this.entries.length > this.options.maxLogs) {
      this.entries.splice(0, this.entries.length - this.options.maxLogs);
    }

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
   * Start or update a streaming log entry (for AI streaming responses).
   * Call with the same streamId to update the entry in-place.
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
      this.emit('entry', entry);
    } else {
      // Append chunk to existing entry
      entry.args = [(entry.args[0] as string) + chunk];
      this.scheduleStreamFlush(entry);
    }
  }

  /** Mark a stream as complete */
  endStream(streamId: string): void {
    const entry = this.streamBuffers.get(streamId);
    if (entry) {
      entry.streaming = false;
      this.streamBuffers.delete(streamId);
      this.emit('streamUpdate', entry);
    }
  }

  /** Schedule a batched UI update for stream entries (avoids UI freeze) */
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

  /** Clone arguments to avoid holding references to mutable objects */
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
      // For objects, store a snapshot
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

  /** Get all log entries */
  getEntries(): LogEntry[] {
    return this.entries;
  }

  /** Get entries filtered by level */
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

  /** Clear all logs */
  clear(): void {
    this.entries.length = 0;
    this.streamBuffers.clear();
    this.emit('clear');
  }

  /** Export logs as JSON string */
  exportJSON(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  /** Restore original console methods */
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
    if (this.flushTimer !== null) {
      cancelAnimationFrame(this.flushTimer);
    }
    this.pendingStreamEntries.clear();
    this.removeAllListeners();
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
