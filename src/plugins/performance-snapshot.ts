/**
 * 当前页面性能快照：统一收集加载、Core Web Vitals、资源与主线程证据。
 * 所有 URL 在离开本模块前都会移除查询参数和片段，避免诊断数据夹带凭据。
 */

import type { NconsolePerformanceIsolation } from '../utils/performance-isolation';

export type PerformanceRating = 'good' | 'needs-improvement' | 'poor' | 'unrated';
export type PerformanceMetricUnit = 'ms' | 'score' | 'MB';
export type PerformanceResourceType = 'script' | 'css' | 'img' | 'font' | 'other';

export interface PerformanceMetricSnapshot {
  key: string;
  label: string;
  value: number;
  unit: PerformanceMetricUnit;
  rating: PerformanceRating;
  coreWebVital?: boolean;
}

export interface NavigationPerformanceSnapshot {
  type?: string;
  redirectMs?: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  requestMs?: number;
  downloadMs?: number;
  ttfbMs?: number;
  domInteractiveMs?: number;
  domContentLoadedMs?: number;
  loadMs?: number;
}

export interface PerformanceResourceSnapshot {
  url: string;
  displayName: string;
  type: PerformanceResourceType;
  startTimeMs: number;
  durationMs: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  protocol?: string;
  renderBlockingStatus?: string;
}

export interface PerformanceResourceTypeSummary {
  type: PerformanceResourceType;
  count: number;
  transferSize: number;
  decodedBodySize: number;
}

export interface PerformanceLongTaskSnapshot {
  startTimeMs: number;
  durationMs: number;
}

export interface PerformanceSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  page: {
    url: string;
    title: string;
    readyState: DocumentReadyState;
    visibilityState: DocumentVisibilityState;
    navigationType?: string;
  };
  environment: {
    userAgent: string;
    viewport: { width: number; height: number; devicePixelRatio: number };
    connection?: { effectiveType?: string; downlinkMbps?: number; rttMs?: number; saveData?: boolean };
    deviceMemoryGB?: number;
    hardwareConcurrency?: number;
  };
  metrics: PerformanceMetricSnapshot[];
  navigation?: NavigationPerformanceSnapshot;
  lcpElement?: {
    selector: string;
    url?: string;
    size?: number;
  };
  slowestInteraction?: {
    name: string;
    target?: string;
    durationMs: number;
  };
  resources: {
    count: number;
    totalTransferSize: number;
    totalDecodedBodySize: number;
    byType: PerformanceResourceTypeSummary[];
    slowest: PerformanceResourceSnapshot[];
    largest: PerformanceResourceSnapshot[];
  };
  longTasks: {
    count: number;
    totalDurationMs: number;
    totalBlockingTimeMs: number;
    longestDurationMs: number;
    entries: PerformanceLongTaskSnapshot[];
  };
  dataQuality: {
    sampleType: 'current-session';
    collectionStartedAtMs: number;
    pageWasHidden: boolean;
    unsupportedEntryTypes: string[];
    missingMetrics: string[];
    notes: string[];
    selfIsolation: {
      excludedResourceCount: number;
      adjustedLongTaskCount: number;
      excludedLongTaskDurationMs: number;
    };
  };
}

export interface LocalPerformanceFinding {
  area: '加载' | '交互' | '稳定性' | '主线程' | '资源';
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: string;
  suggestion: string;
}

interface LargestContentfulPaintEntry extends PerformanceEntry {
  element?: Element | null;
  renderTime?: number;
  loadTime?: number;
  size?: number;
  url?: string;
}

interface LayoutShiftEntry extends PerformanceEntry {
  value?: number;
  hadRecentInput?: boolean;
  sources?: Array<{ node?: Node | null }>;
}

interface EventTimingEntry extends PerformanceEntry {
  duration: number;
  interactionId?: number;
  target?: Node | null;
}

interface MemoryPerformance {
  usedJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

interface NetworkInformation {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

const MAX_LONG_TASKS = 200;
const MAX_INTERACTIONS = 200;
const MAX_RESOURCE_ENTRIES = 30;
const PERFORMANCE_HOST_ID = 'nconsole-host';

/** 基于公开阈值给单次调试样本评级；unrated 表示仅展示、不作达标判断。 */
export function ratePerformanceMetric(key: string, value: number): PerformanceRating {
  switch (key) {
    case 'FCP': return value <= 1_800 ? 'good' : value <= 3_000 ? 'needs-improvement' : 'poor';
    case 'LCP': return value <= 2_500 ? 'good' : value <= 4_000 ? 'needs-improvement' : 'poor';
    case 'CLS': return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor';
    case 'TTFB': return value <= 800 ? 'good' : value <= 1_800 ? 'needs-improvement' : 'poor';
    case 'INP': return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor';
    default: return 'unrated';
  }
}

/** 创建有界的 PerformanceObserver 会话；destroy 后不再保留页面节点或观察器。 */
export class PerformanceSnapshotCollector {
  private observers: PerformanceObserver[] = [];
  private collectionStartedAtMs = 0;
  private started = false;
  private pageWasHidden = false;
  private firstHiddenTime = Number.POSITIVE_INFINITY;
  private unsupportedEntryTypes = new Set<string>();
  private lcpEntry?: LargestContentfulPaintEntry;
  private clsValue = 0;
  private clsSessionValue = 0;
  private clsSessionStart = 0;
  private clsLastEntryTime = 0;
  private interactions = new Map<number, EventTimingEntry>();
  private fallbackInteractionId = -1;
  private longTasks: PerformanceLongTaskSnapshot[] = [];
  private removeVisibilityListener?: () => void;

  constructor(private performanceIsolation?: NconsolePerformanceIsolation) {}

  /** 必须在 start 前接入当前 NetworkCore 的共享隔离状态。 */
  setPerformanceIsolation(performanceIsolation: NconsolePerformanceIsolation): void {
    if (this.started) return;
    this.performanceIsolation = performanceIsolation;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.collectionStartedAtMs = getPerformanceNow();

    if (typeof document !== 'undefined') {
      this.pageWasHidden = document.visibilityState !== 'visible';
      if (this.pageWasHidden) this.firstHiddenTime = 0;
      const onVisibilityChange = (): void => {
        if (document.visibilityState !== 'visible') {
          this.pageWasHidden = true;
          this.firstHiddenTime = Math.min(this.firstHiddenTime, getPerformanceNow());
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange, true);
      this.removeVisibilityListener = () => document.removeEventListener('visibilitychange', onVisibilityChange, true);
    }

    this.observe('largest-contentful-paint', (entry) => this.recordLCP(entry as LargestContentfulPaintEntry));
    this.observe('layout-shift', (entry) => this.recordLayoutShift(entry as LayoutShiftEntry));
    this.observe('event', (entry) => this.recordInteraction(entry as EventTimingEntry), { durationThreshold: 40 });
    this.observe('longtask', (entry) => this.recordLongTask(entry));
  }

  getSnapshot(): PerformanceSnapshot {
    const finishActivity = this.performanceIsolation?.beginActivity();
    try {
      const navigationEntry = getEntries<PerformanceNavigationTiming>('navigation')[0];
      const navigation = navigationEntry ? createNavigationSnapshot(navigationEntry) : undefined;
      const resourceCollection = collectResources(this.performanceIsolation?.isResourceTiming);
      const resources = resourceCollection.entries;
      const longTaskCollection = summarizeLongTasks(
        this.longTasks,
        this.performanceIsolation?.getActivityOverlap,
      );
      const metrics = this.collectMetrics(navigation);
      const slowestInteraction = this.getSlowestInteraction();
      const missingMetrics: string[] = [];
      const metricKeys = new Set(metrics.map((metric) => metric.key));

      if (!metricKeys.has('LCP')) missingMetrics.push('LCP：当前会话尚无有效候选元素。');
      if (!metricKeys.has('CLS')) missingMetrics.push('CLS：当前浏览器不支持布局偏移采集。');
      if (!metricKeys.has('INP')) missingMetrics.push('INP：当前会话尚未发生可计量的点击、触摸或键盘交互。');

      const notes = [
        '这是当前设备、网络与缓存状态下的单次会话样本，不能替代真实用户数据的第 75 百分位。',
        '已剔除可识别的 Nconsole 资源、内部请求、界面交互和已登记主线程耗时。',
      ];
      if (this.pageWasHidden) notes.push('页面曾进入后台，LCP 等加载指标可能不完整。');
      if (resources.some((resource) => resource.transferSize === 0)) {
        notes.push('transferSize 为 0 可能表示缓存命中、跨域 Timing-Allow-Origin 限制或浏览器未提供体积。');
      }
      if (resourceCollection.excludedCount > 0 || longTaskCollection.adjustedCount > 0) {
        notes.push(
          `本次已隔离 ${resourceCollection.excludedCount} 个内部资源，并从 ${longTaskCollection.adjustedCount} 个长任务中扣除 ${Math.round(longTaskCollection.excludedDurationMs)} ms 自身耗时。`,
        );
      }
      notes.push('若 Nconsole 与业务代码被打入同一个首屏 Bundle，浏览器无法把共享文件的解析和执行成本按模块拆分。');

      return {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        page: {
          url: sanitizePerformanceUrl(typeof location === 'undefined' ? '' : location.href),
          title: redactPerformanceText(typeof document === 'undefined' ? '' : document.title, 300),
          readyState: typeof document === 'undefined' ? 'loading' : document.readyState,
          visibilityState: typeof document === 'undefined' ? 'hidden' : document.visibilityState,
          navigationType: navigation?.type,
        },
        environment: collectEnvironment(),
        metrics,
        navigation,
        lcpElement: this.lcpEntry
          ? {
            selector: describeTarget(this.lcpEntry.element) || '(unknown)',
            url: this.lcpEntry.url ? sanitizePerformanceUrl(this.lcpEntry.url) : undefined,
            size: finiteNumber(this.lcpEntry.size),
          }
          : undefined,
        slowestInteraction,
        resources: summarizeResources(resources),
        longTasks: longTaskCollection.summary,
        dataQuality: {
          sampleType: 'current-session',
          collectionStartedAtMs: round(this.collectionStartedAtMs),
          pageWasHidden: this.pageWasHidden,
          unsupportedEntryTypes: [...this.unsupportedEntryTypes].sort(),
          missingMetrics,
          notes,
          selfIsolation: {
            excludedResourceCount: resourceCollection.excludedCount,
            adjustedLongTaskCount: longTaskCollection.adjustedCount,
            excludedLongTaskDurationMs: round(longTaskCollection.excludedDurationMs),
          },
        },
      };
    } finally {
      // 快照生成本身也属于工具开销，供下一次诊断扣除，但不会反向改写本次冻结结果。
      finishActivity?.();
    }
  }

  destroy(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    this.removeVisibilityListener?.();
    this.removeVisibilityListener = undefined;
    this.interactions.clear();
    this.longTasks = [];
    this.lcpEntry = undefined;
    this.started = false;
  }

  private observe(
    type: string,
    onEntry: (entry: PerformanceEntry) => void,
    extraOptions: Record<string, unknown> = {},
  ): void {
    if (typeof PerformanceObserver === 'undefined') {
      this.unsupportedEntryTypes.add(type);
      return;
    }
    const supported = PerformanceObserver.supportedEntryTypes;
    if (Array.isArray(supported) && supported.length > 0 && !supported.includes(type)) {
      this.unsupportedEntryTypes.add(type);
      return;
    }
    try {
      const observer = new PerformanceObserver((list) => {
        const processEntries = (): void => {
          for (const entry of list.getEntries()) onEntry(entry);
        };
        if (this.performanceIsolation) this.performanceIsolation.runActivity(processEntries);
        else processEntries();
      });
      observer.observe({ type, buffered: true, ...extraOptions } as PerformanceObserverInit);
      this.observers.push(observer);
    } catch {
      this.unsupportedEntryTypes.add(type);
    }
  }

  private recordLCP(entry: LargestContentfulPaintEntry): void {
    if (entry.startTime >= this.firstHiddenTime || isNconsoleTarget(entry.element)) return;
    this.lcpEntry = entry;
  }

  private recordLayoutShift(entry: LayoutShiftEntry): void {
    if (entry.hadRecentInput || !Number.isFinite(entry.value) || isNconsoleLayoutShift(entry)) return;
    const value = entry.value || 0;
    if (entry.startTime - this.clsLastEntryTime < 1_000 && entry.startTime - this.clsSessionStart < 5_000) {
      this.clsSessionValue += value;
    } else {
      this.clsSessionValue = value;
      this.clsSessionStart = entry.startTime;
    }
    this.clsLastEntryTime = entry.startTime;
    this.clsValue = Math.max(this.clsValue, this.clsSessionValue);
  }

  private recordInteraction(entry: EventTimingEntry): void {
    if (!Number.isFinite(entry.duration) || entry.duration <= 0 || isNconsoleTarget(entry.target)) return;
    const interactionId = entry.interactionId && entry.interactionId > 0
      ? entry.interactionId
      : this.fallbackInteractionId--;
    const current = this.interactions.get(interactionId);
    if (!current || entry.duration > current.duration) this.interactions.set(interactionId, entry);
    while (this.interactions.size > MAX_INTERACTIONS) {
      const oldestKey = this.interactions.keys().next().value as number | undefined;
      if (oldestKey === undefined) break;
      this.interactions.delete(oldestKey);
    }
  }

  private recordLongTask(entry: PerformanceEntry): void {
    if (!Number.isFinite(entry.duration) || entry.duration < 50) return;
    this.longTasks.push({ startTimeMs: round(entry.startTime), durationMs: round(entry.duration) });
    if (this.longTasks.length > MAX_LONG_TASKS) {
      this.longTasks.splice(0, this.longTasks.length - MAX_LONG_TASKS);
    }
  }

  private collectMetrics(navigation?: NavigationPerformanceSnapshot): PerformanceMetricSnapshot[] {
    const metrics: PerformanceMetricSnapshot[] = [];
    if (navigation?.ttfbMs !== undefined) pushMetric(metrics, 'TTFB', 'TTFB', navigation.ttfbMs, 'ms');

    for (const entry of getEntries<PerformanceEntry>('paint')) {
      if (entry.name === 'first-paint') pushMetric(metrics, 'FP', 'FP', entry.startTime, 'ms');
      if (entry.name === 'first-contentful-paint') pushMetric(metrics, 'FCP', 'FCP', entry.startTime, 'ms');
    }
    if (this.lcpEntry) {
      const lcpTime = this.lcpEntry.renderTime || this.lcpEntry.loadTime || this.lcpEntry.startTime;
      pushMetric(metrics, 'LCP', 'LCP', lcpTime, 'ms', true);
    }
    if (!this.unsupportedEntryTypes.has('layout-shift')) {
      pushMetric(metrics, 'CLS', 'CLS', this.clsValue, 'score', true);
    }
    const slowestInteraction = this.getSlowestInteraction();
    if (slowestInteraction) pushMetric(metrics, 'INP', 'INP', slowestInteraction.durationMs, 'ms', true);
    if (navigation?.domContentLoadedMs !== undefined) {
      pushMetric(metrics, 'DCL', 'DOM Ready', navigation.domContentLoadedMs, 'ms');
    }
    if (navigation?.loadMs !== undefined) pushMetric(metrics, 'LOAD', 'Load', navigation.loadMs, 'ms');

    const memory = typeof performance === 'undefined'
      ? undefined
      : (performance as Performance & { memory?: MemoryPerformance }).memory;
    if (memory?.usedJSHeapSize && memory.jsHeapSizeLimit) {
      const heapMB = memory.usedJSHeapSize / 1024 / 1024;
      const rating: PerformanceRating = memory.usedJSHeapSize / memory.jsHeapSizeLimit > 0.9 ? 'poor' : 'unrated';
      metrics.push({ key: 'JS_HEAP', label: 'JS Heap', value: round(heapMB), unit: 'MB', rating });
    }
    return metrics;
  }

  private getSlowestInteraction(): PerformanceSnapshot['slowestInteraction'] {
    const interactions = [...this.interactions.values()].sort((left, right) => right.duration - left.duration);
    if (interactions.length === 0) return undefined;
    // INP 每 50 次交互忽略一个最高离群值；多数调试会话仍取最慢交互。
    const index = Math.min(interactions.length - 1, Math.floor(interactions.length / 50));
    const entry = interactions[index];
    return {
      name: truncateText(entry.name || 'interaction', 80),
      target: describeTarget(entry.target),
      durationMs: round(entry.duration),
    };
  }
}

/** 本地规则只引用可复核证据，AI 不可用时仍能提供基础优化方向。 */
export function createLocalPerformanceFindings(snapshot: PerformanceSnapshot): LocalPerformanceFinding[] {
  const findings: LocalPerformanceFinding[] = [];
  const metrics = new Map(snapshot.metrics.map((metric) => [metric.key, metric]));
  addMetricFinding(findings, metrics.get('TTFB'), '加载', '服务端响应或连接链路偏慢', '检查 CDN、缓存、重定向和服务端响应时间。');
  addMetricFinding(findings, metrics.get('FCP'), '加载', '首批内容出现较晚', '减少阻塞 CSS/JavaScript，并优先下发首屏必需资源。');
  addMetricFinding(findings, metrics.get('LCP'), '加载', '最大内容元素渲染较慢', '优先发现和加载 LCP 资源，并缩短资源下载与元素渲染延迟。');
  addMetricFinding(findings, metrics.get('CLS'), '稳定性', '页面存在明显布局偏移', '为图片、广告和异步区域预留尺寸，避免首屏后插入未占位内容。');
  addMetricFinding(findings, metrics.get('INP'), '交互', '页面交互响应偏慢', '拆分长事件处理，减少同步渲染工作，并在重任务间主动让出主线程。');

  if (snapshot.longTasks.totalBlockingTimeMs > 200) {
    findings.push({
      area: '主线程',
      severity: snapshot.longTasks.totalBlockingTimeMs > 600 ? 'high' : 'medium',
      title: '主线程长任务阻塞明显',
      evidence: `${snapshot.longTasks.count} 个长任务，TBT 近似值 ${Math.round(snapshot.longTasks.totalBlockingTimeMs)} ms。`,
      suggestion: '拆分大型 JavaScript 任务、延迟非首屏初始化，并减少重复计算和同步 DOM 工作。',
    });
  }

  const scriptSummary = snapshot.resources.byType.find((item) => item.type === 'script');
  if (scriptSummary && scriptSummary.transferSize > 1024 * 1024) {
    findings.push({
      area: '资源',
      severity: scriptSummary.transferSize > 2 * 1024 * 1024 ? 'high' : 'medium',
      title: 'JavaScript 传输体积较大',
      evidence: `${scriptSummary.count} 个脚本共传输 ${formatBytes(scriptSummary.transferSize)}。`,
      suggestion: '按路由或功能拆包，延迟加载非首屏模块，并检查重复依赖。',
    });
  }
  if (snapshot.resources.count > 100) {
    findings.push({
      area: '资源',
      severity: snapshot.resources.count > 180 ? 'high' : 'medium',
      title: '页面请求数量较多',
      evidence: `当前资源时间线包含 ${snapshot.resources.count} 个请求。`,
      suggestion: '合并碎片化资源、移除无效预加载，并延迟非关键第三方资源。',
    });
  }
  const slowest = snapshot.resources.slowest[0];
  if (slowest && slowest.durationMs > 1_000) {
    findings.push({
      area: '资源',
      severity: slowest.durationMs > 2_500 ? 'high' : 'medium',
      title: '存在加载缓慢的关键候选资源',
      evidence: `${slowest.displayName} 耗时 ${Math.round(slowest.durationMs)} ms。`,
      suggestion: '确认资源是否属于首屏关键路径，再检查缓存、压缩、优先级和源站延迟。',
    });
  }
  return findings.slice(0, 12);
}

export function formatPerformanceMetric(metric: PerformanceMetricSnapshot): string {
  if (metric.unit === 'score') return metric.value.toFixed(3);
  if (metric.unit === 'MB') return `${metric.value.toFixed(1)} MB`;
  return formatMilliseconds(metric.value);
}

export function formatMilliseconds(value: number): string {
  if (value < 1) return `${Math.round(value * 1_000)} μs`;
  if (value < 1_000) return `${value.toFixed(1)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

export function formatBytes(value: number): string {
  if (value <= 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function sanitizePerformanceUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const base = typeof location === 'undefined' ? 'https://invalid.local/' : location.href;
    const url = new URL(rawUrl, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `[${url.protocol || 'unknown'} resource omitted]`;
    return redactPerformanceText(`${url.origin}${url.pathname}`, 500);
  } catch {
    return redactPerformanceText(rawUrl.split(/[?#]/, 1)[0], 500);
  }
}

function pushMetric(
  metrics: PerformanceMetricSnapshot[],
  key: string,
  label: string,
  rawValue: number,
  unit: PerformanceMetricUnit,
  coreWebVital = false,
): void {
  if (!Number.isFinite(rawValue) || rawValue < 0) return;
  const value = round(rawValue, unit === 'score' ? 4 : 1);
  metrics.push({ key, label, value, unit, rating: ratePerformanceMetric(key, value), coreWebVital });
}

function createNavigationSnapshot(entry: PerformanceNavigationTiming): NavigationPerformanceSnapshot {
  return {
    type: entry.type,
    redirectMs: positiveDuration(entry.redirectStart, entry.redirectEnd),
    dnsMs: positiveDuration(entry.domainLookupStart, entry.domainLookupEnd),
    tcpMs: positiveDuration(entry.connectStart, entry.connectEnd),
    tlsMs: entry.secureConnectionStart > 0 ? positiveDuration(entry.secureConnectionStart, entry.connectEnd) : undefined,
    requestMs: positiveDuration(entry.requestStart, entry.responseStart),
    downloadMs: positiveDuration(entry.responseStart, entry.responseEnd),
    ttfbMs: entry.responseStart > 0 ? round(entry.responseStart - entry.startTime) : undefined,
    domInteractiveMs: entry.domInteractive > 0 ? round(entry.domInteractive - entry.startTime) : undefined,
    domContentLoadedMs: entry.domContentLoadedEventEnd > 0
      ? round(entry.domContentLoadedEventEnd - entry.startTime)
      : undefined,
    loadMs: entry.loadEventEnd > 0 ? round(entry.loadEventEnd - entry.startTime) : undefined,
  };
}

function collectResources(
  isInternal?: NconsolePerformanceIsolation['isResourceTiming'],
): { entries: PerformanceResourceSnapshot[]; excludedCount: number } {
  const entries: PerformanceResourceSnapshot[] = [];
  let excludedCount = 0;
  for (const entry of getEntries<PerformanceResourceTiming>('resource')) {
    if (isInternal?.(entry)) {
      excludedCount += 1;
      continue;
    }
    const safeUrl = sanitizePerformanceUrl(entry.name);
    const extended = entry as PerformanceResourceTiming & { renderBlockingStatus?: string };
    entries.push({
      url: safeUrl,
      displayName: getShortName(safeUrl),
      type: getResourceType(entry),
      startTimeMs: round(entry.startTime),
      durationMs: round(entry.duration),
      transferSize: finiteNumber(entry.transferSize) || 0,
      encodedBodySize: finiteNumber(entry.encodedBodySize) || 0,
      decodedBodySize: finiteNumber(entry.decodedBodySize) || 0,
      protocol: truncateText(entry.nextHopProtocol || '', 30) || undefined,
      renderBlockingStatus: truncateText(extended.renderBlockingStatus || '', 30) || undefined,
    });
  }
  return { entries, excludedCount };
}

function summarizeResources(entries: PerformanceResourceSnapshot[]): PerformanceSnapshot['resources'] {
  const summary = new Map<PerformanceResourceType, PerformanceResourceTypeSummary>();
  for (const entry of entries) {
    const current = summary.get(entry.type) || { type: entry.type, count: 0, transferSize: 0, decodedBodySize: 0 };
    current.count += 1;
    current.transferSize += entry.transferSize;
    current.decodedBodySize += entry.decodedBodySize;
    summary.set(entry.type, current);
  }
  return {
    count: entries.length,
    totalTransferSize: entries.reduce((total, entry) => total + entry.transferSize, 0),
    totalDecodedBodySize: entries.reduce((total, entry) => total + entry.decodedBodySize, 0),
    byType: [...summary.values()].sort((left, right) => right.transferSize - left.transferSize),
    slowest: [...entries].sort((left, right) => right.durationMs - left.durationMs).slice(0, MAX_RESOURCE_ENTRIES),
    largest: [...entries].sort((left, right) => right.transferSize - left.transferSize).slice(0, MAX_RESOURCE_ENTRIES),
  };
}

function summarizeLongTasks(
  entries: PerformanceLongTaskSnapshot[],
  getActivityOverlap?: NconsolePerformanceIsolation['getActivityOverlap'],
): {
  summary: PerformanceSnapshot['longTasks'];
  adjustedCount: number;
  excludedDurationMs: number;
} {
  const adjusted: PerformanceLongTaskSnapshot[] = [];
  let adjustedCount = 0;
  let excludedDurationMs = 0;
  for (const entry of entries) {
    const overlap = getActivityOverlap?.(entry.startTimeMs, entry.durationMs) || 0;
    if (overlap > 0) {
      adjustedCount += 1;
      excludedDurationMs += overlap;
    }
    const durationMs = round(Math.max(0, entry.durationMs - overlap));
    if (durationMs >= 50) adjusted.push({ startTimeMs: entry.startTimeMs, durationMs });
  }
  const sorted = adjusted.sort((left, right) => right.durationMs - left.durationMs);
  return {
    summary: {
      count: adjusted.length,
      totalDurationMs: round(adjusted.reduce((total, entry) => total + entry.durationMs, 0)),
      totalBlockingTimeMs: round(adjusted.reduce((total, entry) => total + Math.max(0, entry.durationMs - 50), 0)),
      longestDurationMs: sorted[0]?.durationMs || 0,
      entries: sorted.slice(0, 20),
    },
    adjustedCount,
    excludedDurationMs,
  };
}

function collectEnvironment(): PerformanceSnapshot['environment'] {
  const nav = typeof navigator === 'undefined'
    ? undefined
    : navigator as Navigator & { connection?: NetworkInformation; deviceMemory?: number };
  return {
    userAgent: truncateText(nav?.userAgent || '', 500),
    viewport: {
      width: typeof window === 'undefined' ? 0 : window.innerWidth,
      height: typeof window === 'undefined' ? 0 : window.innerHeight,
      devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    },
    connection: nav?.connection
      ? {
        effectiveType: nav.connection.effectiveType,
        downlinkMbps: finiteNumber(nav.connection.downlink),
        rttMs: finiteNumber(nav.connection.rtt),
        saveData: nav.connection.saveData,
      }
      : undefined,
    deviceMemoryGB: finiteNumber(nav?.deviceMemory),
    hardwareConcurrency: finiteNumber(nav?.hardwareConcurrency),
  };
}

function addMetricFinding(
  findings: LocalPerformanceFinding[],
  metric: PerformanceMetricSnapshot | undefined,
  area: LocalPerformanceFinding['area'],
  title: string,
  suggestion: string,
): void {
  if (!metric || metric.rating === 'good' || metric.rating === 'unrated') return;
  findings.push({
    area,
    severity: metric.rating === 'poor' ? 'high' : 'medium',
    title,
    evidence: `${metric.label} 为 ${formatPerformanceMetric(metric)}（${metric.rating === 'poor' ? '较差' : '需要改进'}）。`,
    suggestion,
  });
}

function getEntries<T extends PerformanceEntry>(type: string): T[] {
  if (typeof performance === 'undefined') return [];
  try {
    return performance.getEntriesByType(type) as T[];
  } catch {
    return [];
  }
}

function getResourceType(entry: PerformanceResourceTiming): PerformanceResourceType {
  const path = entry.name.split(/[?#]/, 1)[0];
  const extension = path.split('.').pop()?.toLowerCase() || '';
  if (['js', 'mjs'].includes(extension) || entry.initiatorType === 'script') return 'script';
  if (extension === 'css' || entry.initiatorType === 'css' || entry.initiatorType === 'link') return 'css';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(extension) || entry.initiatorType === 'img') return 'img';
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) return 'font';
  return 'other';
}

function getShortName(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.split('/').pop() || parsed.pathname || parsed.hostname;
    return truncateText(pathname, 50);
  } catch {
    return truncateText(url, 50);
  }
}

function isNconsoleLayoutShift(entry: LayoutShiftEntry): boolean {
  const nodes = entry.sources?.map((source) => source.node).filter((node): node is Node => Boolean(node)) || [];
  return nodes.length > 0 && nodes.every(isNconsoleTarget);
}

function isNconsoleTarget(target?: Node | Element | null): boolean {
  if (!target || typeof Node === 'undefined' || !(target instanceof Node)) return false;
  if (target instanceof Element && (target.id === PERFORMANCE_HOST_ID || target.closest(`#${PERFORMANCE_HOST_ID}`))) return true;
  const root = target.getRootNode?.();
  return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot && root.host.id === PERFORMANCE_HOST_ID;
}

function describeTarget(target?: Node | Element | null): string | undefined {
  if (!target || typeof Element === 'undefined' || !(target instanceof Element)) return undefined;
  const id = target.id ? `#${redactPerformanceText(target.id, 60)}` : '';
  const classes = [...target.classList].slice(0, 3).map((item) => `.${redactPerformanceText(item, 40)}`).join('');
  return redactPerformanceText(`${target.tagName.toLowerCase()}${id}${classes}`, 180);
}

function positiveDuration(start: number, end: number): number | undefined {
  const duration = end - start;
  return Number.isFinite(duration) && duration > 0 ? round(duration) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function redactPerformanceText(value: string, maxLength: number): string {
  return truncateText(
    value
      .replace(/\b([\w.-]*?(?:api[-_ ]?key|token|secret|password|cookie|credential|session)[\w.-]*)\s*[:=]\s*([^\s,;}&"']+)/gi, '$1=[REDACTED]')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\-/=]+/gi, '$1[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/\b(?:\+?\d[\d -]{7,}\d)\b/g, '[REDACTED_PHONE]'),
    maxLength,
  );
}

function getPerformanceNow(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}
