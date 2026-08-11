import type {
  LogEntry,
  NetworkEntry,
  NconsoleCoreConfig,
  NconsolePlugin,
} from '../types';
import { MainPanel } from '../ui/main-panel';

/** Track the mounted UI instance to prevent competing global hooks. */
let instance: Nconsole | null = null;

/**
 * Plugin-free Nconsole UI runtime used by the Lite entry.
 *
 * Optional plugins are deliberately provided as constructor inputs instead of
 * static imports so Lite consumers do not pay for plugins they do not use.
 */
export class Nconsole {
  private panel: MainPanel;

  constructor(config: NconsoleCoreConfig = {}, initialPlugins: NconsolePlugin[] = []) {
    if (instance) {
      instance.destroy();
    }
    instance = this;

    this.panel = new MainPanel(config);
    for (const plugin of initialPlugins) {
      this.panel.use(plugin);
    }
    this.panel.init();
  }

  show(): void {
    this.panel.show();
  }

  hide(): void {
    this.panel.hide();
  }

  toggle(): void {
    this.panel.toggle();
  }

  get isVisible(): boolean {
    return this.panel.isVisible();
  }

  appendStream(streamId: string, chunk: string): void {
    this.panel.getConsoleCore().appendStream(streamId, chunk);
  }

  endStream(streamId: string): void {
    this.panel.getConsoleCore().endStream(streamId);
  }

  setTheme(theme: 'dark' | 'light'): void {
    this.panel.setTheme(theme);
  }

  clearConsole(): void {
    this.panel.getConsoleCore().clear();
  }

  clearNetwork(): void {
    this.panel.getNetworkCore().clear();
  }

  exportLogs(): string {
    return this.panel.getConsoleCore().exportJSON();
  }

  exportForAI(): string {
    return this.panel.exportForAI();
  }

  copyForAI(): Promise<boolean> {
    return this.panel.copyForAI();
  }

  getLogEntries(): LogEntry[] {
    return this.panel.getConsoleCore().getEntries();
  }

  getNetworkEntries(): NetworkEntry[] {
    return this.panel.getNetworkCore().getEntries();
  }

  use(plugin: NconsolePlugin): this {
    this.panel.use(plugin);
    return this;
  }

  destroy(): void {
    if (instance === this) {
      instance = null;
    }
    this.panel.destroy();
  }
}
