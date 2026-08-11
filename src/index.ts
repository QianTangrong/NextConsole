/**
 * Full package entry. It retains the convenience Mimo configuration and
 * plugin factory re-exports. New integrations should prefer `nconsole/lite`,
 * `nconsole/core`, and `nconsole/plugins/*` to import only what they use.
 */
import type { NconsoleConfig } from './types';
import { createMimoAIDiagnosisPlugin } from './plugins/mimo-ai-diagnosis-plugin';
import { Nconsole as LiteNconsole } from './runtime/nconsole';

export type { NconsoleConfig, PanelTab, LogLevel, LogEntry, NetworkEntry, NconsolePlugin } from './types';
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
 * Full Nconsole runtime. This preserves the existing `mimoDiagnosis`
 * convenience option while delegating the plugin-free UI to the Lite runtime.
 */
export class Nconsole extends LiteNconsole {
  constructor(config: NconsoleConfig = {}) {
    const { mimoDiagnosis, ...coreConfig } = config;
    const initialPlugins = mimoDiagnosis?.enabled
      ? [createMimoAIDiagnosisPlugin(mimoDiagnosis)]
      : [];

    super(coreConfig, initialPlugins);
  }
}

export default Nconsole;
