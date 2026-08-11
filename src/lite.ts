/**
 * Lightweight browser UI entry: all built-in debugging tabs, no optional
 * plugin code. Import optional features from `nconsole/plugins/*` and call
 * `console.use(plugin)` when they are needed.
 */
export { NextConsole as default, NextConsole } from './runtime/next-console';
export type {
  NextConsoleCoreConfig,
  NextConsoleLiteConfig,
  NextConsoleLiteConfig as NextConsoleConfig,
  PanelTab,
  LogLevel,
  LogEntry,
  NetworkEntry,
  ConsoleOptions,
  LogSource,
  NetworkOptions,
  StorageOptions,
  StorageType,
  StorageEntry,
  HttpMethod,
  RequestType,
  SSEEvent,
  SystemInfo,
  PerformanceMetrics,
  NextConsolePlugin,
  PluginAPI,
  PluginTab,
} from './types';
