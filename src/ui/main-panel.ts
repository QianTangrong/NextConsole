import type { PanelTab, NextConsoleConfig, NextConsolePlugin, PluginAPI } from '../types';
import { ConsoleCore } from '../core/console-core';
import { NetworkCore } from '../core/network-core';
import { StorageCore } from '../core/storage-core';
import { ElementCore } from '../core/element-core';
import { ReplCore } from '../core/repl-core';
import { FloatButton } from './float-button';
import { ConsolePanel } from './console-panel';
import { NetworkPanel } from './network-panel';
import { StoragePanel } from './storage-panel';
import { ElementPanel } from './element-panel';
import { SystemPanel } from './system-panel';
import { ReplPanel } from './repl-panel';
import { createMimoAIDiagnosisPlugin } from '../plugins/mimo-ai-diagnosis-plugin';
import { THEME_CSS } from '../styles/theme';
import { on, clamp } from '../utils/dom';

const TABS: { key: PanelTab; label: string }[] = [
  { key: 'console', label: 'Console' },
  { key: 'network', label: 'Network' },
  { key: 'storage', label: 'Storage' },
  { key: 'element', label: 'Element' },
  { key: 'system', label: 'System' },
  { key: 'repl', label: 'REPL' },
];

/**
 * Main panel shell: manages shadow DOM, tabs, resizing, and sub-panels.
 */
export class MainPanel {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private backdropEl!: HTMLElement;
  private panelEl!: HTMLElement;
  private tabContentEl!: HTMLElement;
  private activeTab: string;
  private visible = false;
  private mounted = false;
  private destroyed = false;
  private cleanups: (() => void)[] = [];

  // Core modules
  private consoleCore: ConsoleCore;
  private networkCore: NetworkCore;
  private storageCore: StorageCore;
  private elementCore: ElementCore;
  private replCore: ReplCore;

  // UI modules
  private floatButton!: FloatButton;
  private consolePanel?: ConsolePanel;
  private networkPanel?: NetworkPanel;
  private storagePanel?: StoragePanel;
  private elementPanel?: ElementPanel;
  private systemPanel?: SystemPanel;
  private replPanel?: ReplPanel;

  // Plugins
  private plugins: NextConsolePlugin[] = [];
  private pluginTabs: { key: string; label: string }[] = [];
  private pluginPanelsRendered = new Set<string>();
  private pluginAPI?: PluginAPI;
  private initialized = false;

  // Config
  private config: NextConsoleConfig;

  constructor(config: NextConsoleConfig = {}) {
    this.config = config;
    this.activeTab = config.defaultTab || 'console';

    // Create isolated host element with Shadow DOM
    this.host = document.createElement('div');
    this.host.id = 'nextconsole-host';
    this.shadow = this.host.attachShadow({ mode: 'closed' });

    // Core modules
    this.consoleCore = new ConsoleCore(config.console);
    this.networkCore = new NetworkCore(config.network);
    this.storageCore = new StorageCore(config.storage);
    this.elementCore = new ElementCore();
    this.replCore = new ReplCore();

    // 默认不加载，避免未启用时出现额外 Tab、监听或诊断数据收集。
    if (config.mimoDiagnosis?.enabled) {
      this.plugins.push(createMimoAIDiagnosisPlugin(config.mimoDiagnosis));
    }
  }

  /** Initialize everything */
  init(): void {
    const mount = () => {
      if (this.destroyed || this.mounted) return;

      const target = this.config.target || document.body;
      target.appendChild(this.host);

      // Inject styles
      const style = document.createElement('style');
      style.textContent = THEME_CSS;
      this.shadow.appendChild(style);

      // Apply theme
      this.applyTheme(this.config.theme || 'dark');

      // Create float button
      this.floatButton = new FloatButton(
        this.shadow,
        () => this.toggle(),
        this.config.buttonPosition,
      );

      // Create panel
      this.createPanel();

      // Init cores
      this.consoleCore.init();
      this.networkCore.init();
      this.storageCore.init();
      this.elementCore.init();

      // Apply initial panel height
      if (this.config.panelHeight) {
        const h = clamp(this.config.panelHeight, 0.1, 0.9);
        this.panelEl.style.setProperty('--nc-panel-height', `${h * 100}vh`);
      }

      this.initialized = true;
      this.mounted = true;

      // Initialize pending plugins
      for (const plugin of this.plugins) {
        this.initPlugin(plugin);
      }

      this.applyVisibility();
      this.config.onReady?.();
    };

    // Ensure DOM is ready before mounting
    if (document.body) {
      mount();
    } else {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      this.cleanups.push(() => document.removeEventListener('DOMContentLoaded', mount));
    }
  }

  private createPanel(): void {
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'nc-backdrop';
    this.backdropEl.addEventListener('click', () => this.hide());
    this.shadow.appendChild(this.backdropEl);

    this.panelEl = document.createElement('div');
    this.panelEl.className = 'nc-panel';

    // Resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'nc-resize-handle';
    this.panelEl.appendChild(resizeHandle);
    this.bindResize(resizeHandle);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'nc-tab-bar';

    // Close button stays fixed on the left, outside the scrollable tabs.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'nc-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close NextConsole');
    closeBtn.addEventListener('click', () => this.hide());
    tabBar.appendChild(closeBtn);

    // 关闭按钮固定在左侧，标签列表可横向滚动。
    const tabsScroll = document.createElement('div');
    tabsScroll.className = 'nc-tabs-scroll';

    for (const tab of TABS) {
      const tabEl = document.createElement('div');
      tabEl.className = `nc-tab${tab.key === this.activeTab ? ' nc-tab-active' : ''}`;
      tabEl.textContent = tab.label;
      tabEl.dataset.ncTab = tab.key;
      tabsScroll.appendChild(tabEl);
    }

    tabBar.appendChild(tabsScroll);
    this.panelEl.appendChild(tabBar);

    // Tab content area
    this.tabContentEl = document.createElement('div');
    this.tabContentEl.className = 'nc-tab-content';

    for (const tab of TABS) {
      const pane = document.createElement('div');
      pane.className = `nc-tab-pane${tab.key === this.activeTab ? ' nc-tab-pane-active' : ''}`;
      pane.dataset.ncPane = tab.key;
      this.tabContentEl.appendChild(pane);
    }
    this.panelEl.appendChild(this.tabContentEl);

    this.shadow.appendChild(this.panelEl);

    // Bind tab switching
    tabBar.addEventListener('click', (e) => {
      const tabEl = (e.target as HTMLElement).closest('[data-nc-tab]') as HTMLElement;
      if (tabEl) {
        this.switchTab(tabEl.dataset.ncTab as string);
      }
    });

    // Initialize active tab's panel
    this.activatePanel(this.activeTab);
  }

  private switchTab(tab: string): void {
    if (tab === this.activeTab) return;
    this.activeTab = tab;

    // Update tab bar
    this.shadow.querySelectorAll('.nc-tab').forEach((el) => {
      (el as HTMLElement).classList.toggle('nc-tab-active', (el as HTMLElement).dataset.ncTab === tab);
    });

    // Update panes (CSS handles display via nc-tab-pane-active class)
    this.shadow.querySelectorAll('.nc-tab-pane').forEach((el) => {
      (el as HTMLElement).classList.toggle('nc-tab-pane-active', (el as HTMLElement).dataset.ncPane === tab);
    });

    this.activatePanel(tab);
  }

  private activatePanel(tab: string): void {
    const pane = this.shadow.querySelector(`[data-nc-pane="${tab}"]`) as HTMLElement;
    if (!pane) return;

    switch (tab) {
      case 'console':
        if (!this.consolePanel) {
          this.consolePanel = new ConsolePanel(pane, this.consoleCore);
        } else {
          this.consolePanel.refresh();
        }
        break;
      case 'network':
        if (!this.networkPanel) {
          this.networkPanel = new NetworkPanel(pane, this.networkCore);
        } else {
          this.networkPanel.refresh();
        }
        break;
      case 'storage':
        if (!this.storagePanel) {
          this.storagePanel = new StoragePanel(pane, this.storageCore);
        } else {
          this.storagePanel.refreshTable();
        }
        break;
      case 'element':
        if (!this.elementPanel) {
          this.elementPanel = new ElementPanel(pane, this.elementCore);
        }
        break;
      case 'system':
        if (!this.systemPanel) {
          this.systemPanel = new SystemPanel(pane);
        }
        break;
      case 'repl':
        if (!this.replPanel) {
          this.replPanel = new ReplPanel(pane, this.replCore);
        }
        break;
      default:
        // Plugin tabs
        if (tab.startsWith('plugin-') && !this.pluginPanelsRendered.has(tab)) {
          const pluginName = tab.slice(7);
          const plugin = this.plugins.find((p) => p.name === pluginName);
          if (plugin?.tab) {
            plugin.tab.render(pane, this.getPluginAPI());
            this.pluginPanelsRendered.add(tab);
          }
        }
        break;
    }
  }

  private bindResize(handle: HTMLElement): void {
    let startY = 0;
    let startHeight = 0;
    let dragging = false;

    const onMove = (clientY: number) => {
      if (!dragging) return;
      const delta = startY - clientY;
      const newHeight = clamp(startHeight + delta, 100, window.innerHeight - 60);
      this.panelEl.style.height = `${newHeight}px`;
    };

    const onEnd = () => {
      dragging = false;
    };

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startHeight = this.panelEl.offsetHeight;
    });

    handle.addEventListener('touchstart', (e) => {
      dragging = true;
      startY = e.touches[0].clientY;
      startHeight = this.panelEl.offsetHeight;
    }, { passive: true });

    this.cleanups.push(
      on(window as any, 'mousemove', (e: MouseEvent) => onMove(e.clientY)),
      on(window as any, 'mouseup', onEnd),
      on(window as any, 'touchmove', (e: TouchEvent) => onMove(e.touches[0].clientY)),
      on(window as any, 'touchend', onEnd),
    );
  }

  /** Show the panel */
  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.applyVisibility();
  }

  /** Hide the panel */
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    if (!this.mounted) return;

    this.backdropEl.classList.toggle('nc-backdrop-visible', this.visible);
    this.panelEl.classList.toggle('nc-panel-visible', this.visible);
    if (this.visible) {
      this.floatButton.hide();
      this.activatePanel(this.activeTab);
    } else {
      this.floatButton.show();
    }
  }

  /** Toggle panel visibility */
  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /** Check if panel is visible */
  isVisible(): boolean {
    return this.visible;
  }

  /** Get the console core for API access */
  getConsoleCore(): ConsoleCore {
    return this.consoleCore;
  }

  /** Get the network core for API access */
  getNetworkCore(): NetworkCore {
    return this.networkCore;
  }

  /** Get the storage core for API access */
  getStorageCore(): StorageCore {
    return this.storageCore;
  }

  /** Set theme */
  setTheme(theme: 'dark' | 'light'): void {
    this.applyTheme(theme);
  }

  private applyTheme(theme: 'dark' | 'light'): void {
    if (theme === 'light') {
      this.host.classList.add('nc-theme-light');
    } else {
      this.host.classList.remove('nc-theme-light');
    }
  }

  /** Register a plugin */
  use(plugin: NextConsolePlugin): void {
    // Deduplicate by name
    if (this.plugins.some((p) => p.name === plugin.name)) return;
    this.plugins.push(plugin);

    if (this.initialized) {
      this.initPlugin(plugin);
    }
  }

  private getPluginAPI(): PluginAPI {
    if (!this.pluginAPI) {
      this.pluginAPI = {
        consoleCore: this.consoleCore,
        networkCore: this.networkCore,
        storageCore: this.storageCore,
        addStyle: (css: string) => {
          const style = document.createElement('style');
          style.textContent = css;
          this.shadow.appendChild(style);
        },
        log: (...args: unknown[]) => {
          console.log('[NextConsole Plugin]', ...args);
        },
        show: () => this.show(),
        hide: () => this.hide(),
      };
    }
    return this.pluginAPI;
  }

  private initPlugin(plugin: NextConsolePlugin): void {
    const api = this.getPluginAPI();

    // Add tab if plugin defines one
    if (plugin.tab) {
      const key = `plugin-${plugin.name}`;
      this.pluginTabs.push({ key, label: plugin.tab.label });

      // Add tab button
      const tabsScroll = this.shadow.querySelector('.nc-tabs-scroll') as HTMLElement;
      if (tabsScroll) {
        const tabEl = document.createElement('div');
        tabEl.className = 'nc-tab';
        tabEl.textContent = plugin.tab.label;
        tabEl.dataset.ncTab = key;
        tabsScroll.appendChild(tabEl);
      }

      // Add tab pane
      if (this.tabContentEl) {
        const pane = document.createElement('div');
        pane.className = 'nc-tab-pane';
        pane.dataset.ncPane = key;
        this.tabContentEl.appendChild(pane);
      }
    }

    plugin.init?.(api);
  }

  private destroyPlugin(plugin: NextConsolePlugin): void {
    const tabKey = `plugin-${plugin.name}`;
    if (plugin.tab && this.pluginPanelsRendered.has(tabKey)) {
      try {
        plugin.tab.destroy?.();
      } catch (err) {
        console.error('[NextConsole Plugin] tab destroy failed', plugin.name, err);
      }
    }

    try {
      plugin.destroy?.();
    } catch (err) {
      console.error('[NextConsole Plugin] destroy failed', plugin.name, err);
    }
  }

  /** Completely destroy and clean up */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.consolePanel?.destroy();
    this.networkPanel?.destroy();
    this.storagePanel?.destroy();
    this.elementPanel?.destroy();
    this.systemPanel?.destroy();
    this.replPanel?.destroy();
    this.floatButton?.destroy();
    for (const plugin of this.plugins) {
      this.destroyPlugin(plugin);
    }
    this.consoleCore.destroy();
    this.networkCore.destroy();
    this.storageCore.destroy();
    this.elementCore.destroy();
    this.replCore.destroy();
    this.plugins.length = 0;
    this.pluginTabs.length = 0;
    this.pluginPanelsRendered.clear();
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    this.host.remove();
    this.mounted = false;
  }
}
