/**
 * Lightweight browser UI entry: all built-in debugging tabs, no optional
 * plugin code. Import optional features from `nconsole/plugins/*` and call
 * `console.use(plugin)` when they are needed.
 */
export { Nconsole as default, Nconsole } from './runtime/nconsole';
export type {
  NconsoleCoreConfig,
  NconsoleLiteConfig,
  NconsoleLiteConfig as NconsoleConfig,
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
  NconsolePlugin,
  PluginAPI,
  PluginTab,
} from './types';
