/** Log level types */
export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

/** 日志条目的来源。 */
export type LogSource = 'console' | 'window-error' | 'unhandled-rejection';

/** A single log entry */
export interface LogEntry {
  id: number;
  level: LogLevel;
  args: unknown[];
  timestamp: number;
  stack?: string;
  /** 来自 console.*、window.error 或 unhandledrejection */
  source?: LogSource;
  /** For streaming logs: the stream ID this entry belongs to */
  streamId?: string;
  /** Whether this entry is still being streamed */
  streaming?: boolean;
}

/** Console panel options */
export interface ConsoleOptions {
  /** Maximum number of logs to keep in memory */
  maxLogs: number;
  /** Whether to override native console methods */
  hookConsole: boolean;
  /** 是否捕获未处理的运行时异常和 Promise 拒绝 */
  captureGlobalErrors: boolean;
}
