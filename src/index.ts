/**
 * Full compatibility entry. It retains the convenience Mimo configuration and
 * plugin factory re-exports. New integrations should prefer `nconsole/lite`,
 * `nconsole/core`, and `nconsole/plugins/*` to import only what they use.
 */
import type { NextConsoleConfig } from './types';
import { createMimoAIDiagnosisPlugin } from './plugins/mimo-ai-diagnosis-plugin';
import { NextConsole as LiteNextConsole } from './runtime/next-console';

export type { NextConsoleConfig, PanelTab, LogLevel, LogEntry, NetworkEntry, NextConsolePlugin } from './types';
export type {
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
  PluginAPI,
  PluginTab,
  MimoAIDiagnosisOptions,
  MimoDiagnosisContext,
  MimoDiagnosisContextProviderInput,
  MimoDiagnosisErrorContext,
  MimoDiagnosisRuntimeContext,
} from './types';

export { createSourcePlugin } from './plugins/source-plugin';
export { createPerformancePlugin } from './plugins/performance-plugin';
export { createMimoAIDiagnosisPlugin } from './plugins/mimo-ai-diagnosis-plugin';

/**
 * Full NextConsole runtime. This preserves the existing `mimoDiagnosis`
 * convenience option while delegating the plugin-free UI to the Lite runtime.
 */
export class NextConsole extends LiteNextConsole {
  constructor(config: NextConsoleConfig = {}) {
    const { mimoDiagnosis, ...coreConfig } = config;
    const initialPlugins = mimoDiagnosis?.enabled
      ? [createMimoAIDiagnosisPlugin(mimoDiagnosis)]
      : [];

    super(coreConfig, initialPlugins);
  }
}

export default NextConsole;
