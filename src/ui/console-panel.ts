/**
 * 控制台面板视图：负责日志筛选、增量渲染、流式日志更新与用户交互。
 */
import type { LogEntry, LogLevel } from '../types';
import type { ConsoleCore } from '../core/console-core';
import { formatTime } from '../utils/time';
import { highlightJSON } from '../utils/json';
import { escapeHTML } from '../utils/dom';

const MAX_RENDER = 500;

/**
 * 控制台面板：渲染可换行日志行，并处理筛选、搜索、流式刷新和 AI 导出交互。
 */
export class ConsolePanel {
  private container: HTMLElement;
  private listEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private core: ConsoleCore;
  private filteredEntries: LogEntry[] = [];
  private activeFilters = new Set<LogLevel>();
  private searchText = '';
  private scrollLocked = true;
  /** 高频日志更新合并到动画帧中，非可见面板仅标记待刷新状态。 */
  private renderRAF: number | null = null;
  private needsRefresh = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private feedbackTimer: number | null = null;
  private cleanups: (() => void)[] = [];

  constructor(
    container: HTMLElement,
    core: ConsoleCore,
    private copyForAI: () => Promise<boolean>,
  ) {
    this.container = container;
    this.core = core;
    this.render();
    this.bindEvents();
  }

  private render(): void {
    // 工具栏与列表分离，刷新日志时无需重建筛选和操作控件。
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'nc-toolbar nc-console-toolbar';
    this.toolbarEl.innerHTML = `
      <div class="nc-toolbar-group nc-console-filter-group">
        <button class="nc-toolbar-btn" data-nc-filter="log">Log</button>
        <button class="nc-toolbar-btn" data-nc-filter="info">Info</button>
        <button class="nc-toolbar-btn" data-nc-filter="warn">Warn</button>
        <button class="nc-toolbar-btn" data-nc-filter="error">Error</button>
        <button class="nc-toolbar-btn" data-nc-filter="debug">Debug</button>
      </div>
      <input type="text" placeholder="Filter logs..." class="nc-console-search" />
      <div class="nc-toolbar-group nc-console-action-group">
        <button class="nc-toolbar-btn nc-console-clear">Clear</button>
        <button class="nc-toolbar-btn nc-console-export">Export</button>
        <button class="nc-toolbar-btn nc-console-copy-ai" title="Copy structured, redacted diagnostic context as Markdown">Copy for AI</button>
      </div>
    `;
    this.container.appendChild(this.toolbarEl);

    // Scrollable list container
    this.listEl = document.createElement('div');
    this.listEl.className = 'nc-console-list';
    this.container.appendChild(this.listEl);

    this.refreshEntries();
  }

  private bindEvents(): void {
    // 筛选按钮委托给工具栏，避免为每种日志级别分别绑定监听器。
    this.toolbarEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-nc-filter]') as HTMLElement;
      if (btn) {
        const level = btn.getAttribute('data-nc-filter') as LogLevel;
        if (this.activeFilters.has(level)) {
          this.activeFilters.delete(level);
          btn.classList.remove('nc-active');
        } else {
          this.activeFilters.add(level);
          btn.classList.add('nc-active');
        }
        this.refreshEntries();
      }
    });

    // Search
    const searchInput = this.toolbarEl.querySelector('.nc-console-search') as HTMLInputElement;
    searchInput.addEventListener('input', () => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null;
        this.searchText = searchInput.value;
        this.refreshEntries();
      }, 150);
    });

    // Clear
    this.toolbarEl.querySelector('.nc-console-clear')!.addEventListener('click', () => {
      this.core.clear();
    });

    // Export
    this.toolbarEl.querySelector('.nc-console-export')!.addEventListener('click', () => {
      const data = this.core.exportJSON();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nextconsole-logs-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    this.toolbarEl.querySelector('.nc-console-copy-ai')!.addEventListener('click', (event) => {
      void this.handleCopyForAI(event.currentTarget as HTMLButtonElement);
    });

    // Scroll: detect if user scrolled away from bottom
    this.listEl.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.listEl;
      this.scrollLocked = scrollTop + clientHeight >= scrollHeight - 40;
    });

    // Core events
    const unsub1 = this.core.on('entry', () => {
      this.scheduleRefresh();
    });
    const unsub2 = this.core.on('streamUpdate', () => {
      this.scheduleRefresh();
    });
    const unsub3 = this.core.on('clear', () => {
      this.scheduleRefresh();
    });

    this.cleanups.push(unsub1, unsub2, unsub3);
  }

  /** 面板不可见时延迟刷新，重新激活后再渲染，避免后台标签持续创建 DOM。 */
  private scheduleRefresh(): void {
    if (!this.isRenderable()) {
      this.needsRefresh = true;
      return;
    }
    if (this.renderRAF !== null) return;
    this.renderRAF = requestAnimationFrame(() => {
      this.renderRAF = null;
      this.refreshEntries();
    });
  }

  refresh(): void {
    if (this.renderRAF !== null) {
      cancelAnimationFrame(this.renderRAF);
      this.renderRAF = null;
    }
    this.needsRefresh = false;
    this.refreshEntries();
  }

  private isRenderable(): boolean {
    return this.container.classList.contains('nc-tab-pane-active')
      && this.container.closest('.nc-panel-visible') !== null;
  }

  private refreshEntries(): void {
    if (!this.isRenderable() && this.needsRefresh) return;
    const levels = this.activeFilters.size > 0 ? Array.from(this.activeFilters) : undefined;
    this.filteredEntries = this.core.getFilteredEntries(levels, this.searchText || undefined);
    this.renderList();
  }

  private renderList(): void {
    const entries = this.filteredEntries;
    // 只渲染最新记录，内存中的完整日志仍由 ConsoleCore 保留并可导出。
    const start = Math.max(0, entries.length - MAX_RENDER);

    let html = '';
    if (start > 0) {
      html += `<div class="nc-log-entry" style="justify-content:center;color:var(--nc-text-muted);font-size:11px">... 省略了 ${start} 条更早的日志 ...</div>`;
    }
    for (let i = start; i < entries.length; i++) {
      const entry = entries[i];
      const streamClass = entry.streaming ? ' nc-log-streaming' : '';
      html += `<div class="nc-log-entry nc-log-level-${entry.level}${streamClass}">`;
      html += `<span class="nc-log-time">${formatTime(entry.timestamp)}</span>`;
      html += `<span class="nc-log-body">${this.renderArgs(entry.args)}</span>`;
      html += `</div>`;
    }
    this.listEl.innerHTML = html;

    // Auto-scroll to bottom
    if (this.scrollLocked && entries.length > 0) {
      this.listEl.scrollTop = this.listEl.scrollHeight;
    }
  }

  private renderArgs(args: unknown[]): string {
    return args
      .map((arg) => {
        if (typeof arg === 'string') return escapeHTML(arg);
        if (typeof arg === 'number' || typeof arg === 'boolean' || arg === null || arg === undefined) {
          return `<span style="color:#b5cea8">${String(arg)}</span>`;
        }
        if (typeof arg === 'object') {
          return highlightJSON(arg);
        }
        return escapeHTML(String(arg));
      })
      .join(' ');
  }

  private async handleCopyForAI(button: HTMLButtonElement): Promise<void> {
    const originalLabel = button.textContent || 'Copy for AI';
    button.disabled = true;
    const copied = await this.copyForAI();
    button.textContent = copied ? 'Copied' : 'Copy failed';
    if (this.feedbackTimer !== null) window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = window.setTimeout(() => {
      this.feedbackTimer = null;
      button.disabled = false;
      button.textContent = originalLabel;
    }, 1_500);
  }

  destroy(): void {
    if (this.renderRAF !== null) {
      cancelAnimationFrame(this.renderRAF);
    }
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.feedbackTimer !== null) {
      window.clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
    }
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    this.container.innerHTML = '';
  }
}
