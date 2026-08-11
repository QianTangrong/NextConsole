/**
 * Headless capture primitives. This entry has no Shadow DOM UI and no plugin
 * implementations, for integrations that render captured data themselves.
 */
export { ConsoleCore } from './core/console-core';
export { NetworkCore } from './core/network-core';
export { StorageCore } from './core/storage-core';
export type {
  ConsoleOptions,
  LogEntry,
  LogLevel,
  LogSource,
  NetworkEntry,
  NetworkOptions,
  SSEEvent,
  StorageEntry,
  StorageOptions,
  StorageType,
} from './types';
