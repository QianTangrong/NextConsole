/**
 * 性能插件：聚合浏览器性能指标和资源加载数据，提供面向排障的性能面板。
 */
import type { NconsolePlugin, PluginAPI } from '../types/plugin';
import { escapeHTML } from '../utils/dom';
import {
  formatBytes,
  formatMilliseconds,
  formatPerformanceMetric,
  PerformanceSnapshotCollector,
} from './performance-snapshot';

const MAX_CUSTOM_MARKS = 100;
const MAX_RENDERED_MARKS = 100;

const PERF_CSS = `
.nc-perf-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.nc-perf-scroll {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 8px;
}
.nc-perf-section {
  margin-bottom: 12px;
}
.nc-perf-section-title {
  font-size: 12px;
  font-weight: bold;
  color: var(--nc-text);
  padding: 6px 0 4px;
  border-bottom: 1px solid var(--nc-border);
  margin-bottom: 6px;
}
.nc-perf-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 6px;
}
.nc-perf-card {
  background: var(--nc-bg-secondary);
  border: 1px solid var(--nc-border);
  border-radius: var(--nc-radius);
  padding: 8px 10px;
  border-left: 3px solid var(--nc-border);
}
.nc-perf-card-good { border-left-color: #3dc9b0; }
.nc-perf-card-needs-improvement { border-left-color: #cca700; }
.nc-perf-card-poor { border-left-color: #f14c4c; }
.nc-perf-card-unrated { border-left-color: var(--nc-border); }
.nc-perf-card-name {
  font-size: 10px;
  color: var(--nc-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.nc-perf-card-value {
  font-size: 18px;
  font-weight: bold;
  color: var(--nc-text);
  margin: 2px 0;
}
.nc-perf-card-unit {
  font-size: 11px;
  color: var(--nc-text-secondary);
  font-weight: normal;
}
.nc-perf-bar-wrap {
  display: flex;
  align-items: center;
  padding: 3px 0;
  font-size: 11px;
  gap: 6px;
}
.nc-perf-bar-label {
  flex-shrink: 0;
  width: 100px;
  color: var(--nc-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-perf-bar-track {
  flex: 1;
  height: 14px;
  background: var(--nc-bg-secondary);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}
.nc-perf-bar-fill {
  height: 100%;
  border-radius: 2px;
  min-width: 1px;
}
.nc-perf-bar-fill-script { background: #2b5b84; }
.nc-perf-bar-fill-css { background: #5b3a84; }
.nc-perf-bar-fill-img { background: #3a845b; }
.nc-perf-bar-fill-font { background: #845b3a; }
.nc-perf-bar-fill-other { background: #555; }
.nc-perf-bar-value {
  flex-shrink: 0;
  width: 60px;
  text-align: right;
  color: var(--nc-text-muted);
}
.nc-perf-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.nc-perf-table th {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--nc-border);
  color: var(--nc-text-muted);
  font-weight: normal;
  text-transform: uppercase;
  font-size: 10px;
  position: sticky;
  top: 0;
  background: var(--nc-bg);
}
.nc-perf-table td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--nc-border);
  color: var(--nc-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}
.nc-perf-table tr:hover td {
  background: var(--nc-bg-hover);
}
.nc-perf-empty {
  text-align: center;
  color: var(--nc-text-muted);
  padding: 16px;
}
.nc-perf-note {
  color: var(--nc-text-muted);
  font-size: 10px;
  line-height: 1.5;
  margin: 6px 0;
}
.nc-perf-mark-btn {
  padding: 2px 8px;
  background: var(--nc-bg);
  border: 1px solid var(--nc-border);
  color: var(--nc-text);
  cursor: pointer;
  border-radius: var(--nc-radius);
  font-size: 11px;
  margin-left: 6px;
}
.nc-perf-mark-btn:hover { background: var(--nc-bg-hover); }
`;

/** 创建性能插件，并在可用时订阅长任务以补充资源时间线无法覆盖的卡顿。 */
export function createPerformancePlugin(): NconsolePlugin {
  let container: HTMLElement;
  let pluginApi: PluginAPI | undefined;
  const collector = new PerformanceSnapshotCollector();
  let customMarks: string[] = [];
  let nextCustomMarkId = 0;

  function runActivity<T>(callback: () => T): T {
    return pluginApi ? pluginApi.networkCore.getPerformanceIsolation().runActivity(callback) : callback();
  }

  function render() {
    runActivity(() => {
      const snapshot = collector.getSnapshot();
      const { metrics, navigation } = snapshot;
      const resources = snapshot.resources.slowest;
      const sortedLT = snapshot.longTasks.entries;

    // Resource summary
    const summary = new Map(snapshot.resources.byType.map((item) => [item.type, item]));

    // Core metrics cards
    const metricsHTML = metrics.length > 0
      ? metrics.map((m) => `
        <div class="nc-perf-card nc-perf-card-${m.rating}">
          <div class="nc-perf-card-name">${escapeHTML(m.label)}</div>
          <div class="nc-perf-card-value">${escapeHTML(formatPerformanceMetric(m))}</div>
        </div>`).join('')
      : '<div class="nc-perf-empty">No metrics available yet</div>';

    const navigationRows = navigation
      ? [
        ['Redirect', navigation.redirectMs],
        ['DNS', navigation.dnsMs],
        ['TCP', navigation.tcpMs],
        ['TLS', navigation.tlsMs],
        ['Request / TTFB', navigation.requestMs],
        ['Download', navigation.downloadMs],
      ].filter((item): item is [string, number] => typeof item[1] === 'number')
        .map(([label, duration]) => `<tr><td>${label}</td><td>${formatMilliseconds(duration)}</td></tr>`)
        .join('')
      : '';

    // Resource summary bars
    const typeOrder = ['script', 'css', 'img', 'font', 'other'] as const;
    const totalSize = snapshot.resources.totalTransferSize;
    const summaryHTML = typeOrder
      .filter((t) => summary.has(t))
      .map((t) => {
        const s = summary.get(t)!;
        const pct = totalSize > 0 ? (s.transferSize / totalSize * 100) : 0;
        return `<div class="nc-perf-bar-wrap">
          <span class="nc-perf-bar-label">${t} (${s.count})</span>
          <div class="nc-perf-bar-track"><div class="nc-perf-bar-fill nc-perf-bar-fill-${t}" style="width:${Math.max(pct, 1)}%"></div></div>
          <span class="nc-perf-bar-value">${formatBytes(s.transferSize)}</span>
        </div>`;
      }).join('');

    // Top resources table
    const topResources = resources.slice(0, 30);
    const resourceRows = topResources.map((r) => `
      <tr>
        <td title="${escapeHTML(r.url)}">${escapeHTML(r.displayName)}</td>
        <td>${r.type}</td>
        <td>${formatMilliseconds(r.durationMs)}</td>
        <td>${formatBytes(r.transferSize)}</td>
      </tr>`).join('');

    // Long tasks
    const longTaskHTML = sortedLT.length > 0
      ? sortedLT.slice(0, 20).map((lt) => `
        <tr>
          <td>${formatMilliseconds(lt.startTimeMs)}</td>
          <td style="color:${lt.durationMs > 100 ? 'var(--nc-error)' : 'var(--nc-warn)'}">${formatMilliseconds(lt.durationMs)}</td>
        </tr>`).join('')
      : '';

    // Custom marks
    const marks = performance.getEntriesByType('mark').slice(-MAX_RENDERED_MARKS);
    const marksHTML = marks.length > 0
      ? marks.map((m) => `
        <tr>
          <td>${escapeHTML(m.name)}</td>
          <td>${formatMilliseconds(m.startTime)}</td>
        </tr>`).join('')
      : '';

    container.innerHTML = `
      <div class="nc-perf-view">
        <div class="nc-toolbar">
          <button class="nc-toolbar-btn nc-perf-refresh">Refresh</button>
          <button class="nc-perf-mark-btn nc-perf-mark">+ Mark</button>
        </div>
        <div class="nc-perf-scroll">
          <div class="nc-perf-section">
            <div class="nc-perf-section-title">Core Metrics</div>
            <div class="nc-perf-metrics">${metricsHTML}</div>
            <div class="nc-perf-note">当前会话样本；Core Web Vitals 的正式结论应以真实用户第 75 百分位为准。</div>
            <div class="nc-perf-note">已隔离 ${snapshot.dataQuality.selfIsolation.excludedResourceCount} 个 Nconsole 内部资源，并从 ${snapshot.dataQuality.selfIsolation.adjustedLongTaskCount} 个长任务中扣除 ${formatMilliseconds(snapshot.dataQuality.selfIsolation.excludedLongTaskDurationMs)} 工具耗时。</div>
          </div>

          ${navigationRows ? `
          <div class="nc-perf-section">
            <div class="nc-perf-section-title">Navigation Breakdown</div>
            <table class="nc-perf-table"><tr><th>Phase</th><th>Duration</th></tr>${navigationRows}</table>
          </div>` : ''}

          ${summaryHTML ? `
          <div class="nc-perf-section">
            <div class="nc-perf-section-title">Resource Breakdown (${snapshot.resources.count} resources, ${formatBytes(totalSize)} total)</div>
            ${summaryHTML}
          </div>` : ''}

          ${resourceRows ? `
          <div class="nc-perf-section">
            <div class="nc-perf-section-title">Slowest Resources</div>
            <table class="nc-perf-table">
              <tr><th>Name</th><th>Type</th><th>Duration</th><th>Size</th></tr>
              ${resourceRows}
            </table>
          </div>` : ''}

          ${longTaskHTML ? `
          <div class="nc-perf-section">
            <div class="nc-perf-section-title">Long Tasks (${sortedLT.length})</div>
            <table class="nc-perf-table">
              <tr><th>Start</th><th>Duration</th></tr>
              ${longTaskHTML}
            </table>
          </div>` : ''}

          ${marksHTML ? `
          <div class="nc-perf-section">
            <div class="nc-perf-section-title">Performance Marks</div>
            <table class="nc-perf-table">
              <tr><th>Name</th><th>Time</th></tr>
              ${marksHTML}
            </table>
          </div>` : ''}
        </div>
      </div>`;

      container.querySelector('.nc-perf-refresh')!.addEventListener('click', render);
      container.querySelector('.nc-perf-mark')!.addEventListener('click', () => {
        const name = `nc-mark-${++nextCustomMarkId}`;
        performance.mark(name);
        customMarks.push(name);
        if (customMarks.length > MAX_CUSTOM_MARKS) {
          const expiredMarks = customMarks.splice(0, customMarks.length - MAX_CUSTOM_MARKS);
          for (const expiredMark of expiredMarks) performance.clearMarks(expiredMark);
        }
        render();
      });
    });
  }

  return {
    name: 'performance',
    version: '1.0.0',
    init(api) {
      pluginApi = api;
      collector.setPerformanceIsolation(api.networkCore.getPerformanceIsolation());
      collector.start();
    },
    tab: {
      label: 'Perf',
      render(el, api) {
        container = el;
        api.addStyle(PERF_CSS);
        render();
      },
      destroy() {
        container.innerHTML = '';
      },
    },
    destroy() {
      collector.destroy();
      pluginApi = undefined;
      // Clean up custom marks
      for (const name of customMarks) {
        try { performance.clearMarks(name); } catch { /* noop */ }
      }
      customMarks = [];
    },
  };
}
