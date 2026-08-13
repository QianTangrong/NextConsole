/**
 * Nconsole 自身性能噪声登记表。
 * 全局 Symbol 让主包与独立插件子路径共享有界状态，避免分包后隔离信息失联。
 */

interface InternalResourceRecord {
  url: string;
  start: number;
}

interface InternalActivityInterval {
  start: number;
  end: number;
}

interface PerformanceIsolationState {
  resources: InternalResourceRecord[];
  activities: InternalActivityInterval[];
}

/** 性能插件只依赖该适配器，不直接打包全局登记表实现。 */
export interface NconsolePerformanceIsolation {
  beginActivity(): () => void;
  runActivity<T>(callback: () => T): T;
  getActivityOverlap(start: number, duration: number): number;
  isResourceTiming(entry: Pick<PerformanceResourceTiming, 'name' | 'startTime'>): boolean;
}

const STATE_KEY = Symbol.for('nconsole.performance-isolation.v1');
const MAX_RECORDS = 1_000;
const RESOURCE_START_TOLERANCE_MS = 50;
const ARTIFACT_PATTERN = /(?:^|\/)(?:nconsole(?:\.es)?\.mjs|nconsole\.umd\.js|nconsole(?:\.lite)?\.min\.js|lite\.mjs|core\.mjs|plugins\/(?:source|performance|mimo-ai-diagnosis)\.mjs)$/i;

type GlobalWithIsolationState = typeof globalThis & {
  [STATE_KEY]?: PerformanceIsolationState;
};

/** 登记一次内部请求；URL 与发起时间共同匹配，避免误删页面早先加载的同名资源。 */
export function markNconsoleResourceRequest(rawUrl: string): void {
  const url = normalizeResourceUrl(rawUrl);
  if (!url) return;
  const resources = getState().resources;
  resources.push({ url, start: now() });
  trim(resources, 300);
}

/** 判断资源条目是否为发布产物或已登记的 AI/Source 等内部请求。 */
export function isNconsoleResourceTiming(entry: Pick<PerformanceResourceTiming, 'name' | 'startTime'>): boolean {
  const url = normalizeResourceUrl(entry.name);
  if (!url) return false;
  if (ARTIFACT_PATTERN.test(new URL(url).pathname)) return true;
  return getState().resources.some((record) => (
    record.url === url && Math.abs(record.start - entry.startTime) <= RESOURCE_START_TOLERANCE_MS
  ));
}

/** 开始记录同步工具工作；结束函数幂等，异常路径也可安全调用。 */
export function beginNconsoleActivity(): () => void {
  const start = now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const end = now();
    if (end <= start) return;
    const activities = getState().activities;
    activities.push({ start, end });
    trim(activities, MAX_RECORDS);
  };
}

export function runNconsoleActivity<T>(callback: () => T): T {
  const end = beginNconsoleActivity();
  try {
    return callback();
  } finally {
    end();
  }
}

/** 返回无状态方法适配器，供通过 PluginAPI 安装的独立插件复用 Core 隔离状态。 */
export function getNconsolePerformanceIsolation(): NconsolePerformanceIsolation {
  return {
    beginActivity: beginNconsoleActivity,
    runActivity: runNconsoleActivity,
    getActivityOverlap: getNconsoleActivityOverlap,
    isResourceTiming: isNconsoleResourceTiming,
  };
}

/** 计算长任务与工具工作区间的并集重叠，嵌套记录不会重复扣除。 */
export function getNconsoleActivityOverlap(start: number, duration: number): number {
  if (duration <= 0) return 0;
  const end = start + duration;
  const overlaps = getState().activities
    .filter((item) => item.end > start && item.start < end)
    .map((item) => [Math.max(start, item.start), Math.min(end, item.end)] as const)
    .sort((left, right) => left[0] - right[0]);

  let total = 0;
  let mergedStart = 0;
  let mergedEnd = 0;
  for (const [itemStart, itemEnd] of overlaps) {
    if (mergedEnd === 0) {
      mergedStart = itemStart;
      mergedEnd = itemEnd;
    } else if (itemStart <= mergedEnd) {
      mergedEnd = Math.max(mergedEnd, itemEnd);
    } else {
      total += mergedEnd - mergedStart;
      mergedStart = itemStart;
      mergedEnd = itemEnd;
    }
  }
  if (mergedEnd > 0) total += mergedEnd - mergedStart;
  return Math.min(duration, total);
}

/** 测试隔离以及同页运行时显式重置使用。 */
export function clearNconsolePerformanceIsolation(): void {
  const state = getState();
  state.resources.length = 0;
  state.activities.length = 0;
}

function getState(): PerformanceIsolationState {
  const target = globalThis as GlobalWithIsolationState;
  let state = target[STATE_KEY];
  if (!state) {
    state = { resources: [], activities: [] };
    target[STATE_KEY] = state;
  }
  return state;
}

function normalizeResourceUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const base = typeof location === 'undefined' ? 'https://invalid.local/' : location.href;
    const url = new URL(rawUrl, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : '';
  } catch {
    return '';
  }
}

function now(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

function trim<T>(items: T[], limit: number): void {
  if (items.length > limit) items.splice(0, items.length - limit);
}
