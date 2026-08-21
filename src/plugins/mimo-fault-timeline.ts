/**
 * AI 故障时间线：把控制台告警/错误、失败或缓慢的网络请求、主线程长任务
 * 归并成有界、按时间升序、已脱敏的快照，供 UI 展示和 AI 诊断复用。
 * 纯函数模块：不访问 DOM、存储或网络；不读取请求/响应头与正文。
 */
import type { LogEntry, NetworkEntry } from '../types';
import { sanitizePerformanceUrl, type PerformanceLongTaskSnapshot } from './performance-snapshot';

export type FaultTimelineEventType = 'console' | 'network' | 'long-task';
export type FaultTimelineSeverity = 'error' | 'warning';

export interface FaultTimelineEvent {
  type: FaultTimelineEventType;
  severity: FaultTimelineSeverity;
  /** Unix 毫秒时间戳；网络与长任务的相对时间已用 timeOrigin 换算为绝对时间。 */
  timestamp: number;
  timestampIso: string;
  summary: string;
}

export interface FaultTimelineSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  events: FaultTimelineEvent[];
}

export interface FaultTimelineInput {
  logs: LogEntry[];
  network: NetworkEntry[];
  longTasks?: PerformanceLongTaskSnapshot[];
  /** performance.now 相对时间换算为绝对时间的基准；缺省使用安全回退。 */
  timeOrigin?: number;
}

/** 时间线只保留最近 30 条信号，避免长会话把完整历史发给外部服务或 UI。 */
export const MAX_TIMELINE_EVENTS = 30;
/** 完成耗时达到该阈值的网络请求视为缓慢信号。 */
export const SLOW_NETWORK_DURATION_MS = 1_000;
/** 主线程长任务阈值，与 PerformanceObserver longtask 语义保持一致。 */
export const LONG_TASK_DURATION_MS = 50;
const MAX_SUMMARY_CHARS = 160;
const MAX_TIMELINE_CHARS = 12_000;
const MAX_LOG_ARGS = 3;

/** 与现有网络上下文一致的 timeOrigin 安全回退。 */
export function getPerformanceTimeOrigin(): number {
  if (typeof performance !== 'undefined') {
    if (typeof performance.timeOrigin === 'number' && Number.isFinite(performance.timeOrigin)) {
      return performance.timeOrigin;
    }
    try {
      return Date.now() - performance.now();
    } catch {
      // performance.now 不可用时退回当前时间。
    }
  }
  return Date.now();
}

export function buildFaultTimeline(input: FaultTimelineInput): FaultTimelineSnapshot {
  const timeOrigin = input.timeOrigin ?? getPerformanceTimeOrigin();
  const events: FaultTimelineEvent[] = [];

  for (const entry of input.logs) {
    if (entry.level !== 'warn' && entry.level !== 'error') continue;
    if (!Number.isFinite(entry.timestamp)) continue;
    events.push(createEvent(
      'console',
      entry.level === 'error' ? 'error' : 'warning',
      entry.timestamp,
      describeLogArgs(entry.args),
    ));
  }

  for (const entry of input.network) {
    // 失败信号不要求请求完成（例如被中止的 pending 请求也带 error）；缓慢信号必须已完成。
    const failed = Boolean(entry.error) || (!entry.pending && entry.status >= 400);
    const slow = !failed && !entry.pending && Number.isFinite(entry.duration)
      && entry.duration >= SLOW_NETWORK_DURATION_MS;
    if (!failed && !slow) continue;
    const startTime = Number.isFinite(entry.startTime) ? entry.startTime : 0;
    events.push(createEvent(
      'network',
      failed ? 'error' : 'warning',
      timeOrigin + startTime,
      describeNetworkEntry(entry),
    ));
  }

  for (const task of input.longTasks ?? []) {
    if (!Number.isFinite(task.durationMs) || task.durationMs < LONG_TASK_DURATION_MS) continue;
    const startTime = Number.isFinite(task.startTimeMs) ? task.startTimeMs : 0;
    events.push(createEvent(
      'long-task',
      'warning',
      timeOrigin + startTime,
      `主线程长任务阻塞约 ${Math.round(task.durationMs)} ms`,
    ));
  }

  events.sort((left, right) => left.timestamp - right.timestamp);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    events: events.slice(-MAX_TIMELINE_EVENTS),
  };
}

/** 序列化后仍做长度兜底；超预算时从最旧事件开始丢弃，优先保留最近的故障证据。 */
export function serializeFaultTimeline(snapshot: FaultTimelineSnapshot, maxChars: number = MAX_TIMELINE_CHARS): string {
  let bounded = snapshot;
  let serialized = JSON.stringify(bounded);
  while (serialized.length > maxChars && bounded.events.length > 0) {
    bounded = { ...bounded, events: bounded.events.slice(Math.ceil(bounded.events.length / 2)) };
    serialized = JSON.stringify(bounded);
  }
  return serialized;
}

function createEvent(
  type: FaultTimelineEventType,
  severity: FaultTimelineSeverity,
  timestamp: number,
  summary: string,
): FaultTimelineEvent {
  return {
    type,
    severity,
    timestamp: Math.round(timestamp),
    timestampIso: new Date(Math.round(timestamp)).toISOString(),
    summary: redactTimelineText(summary),
  };
}

/** 只抽取有限的文本线索；不序列化原始用户对象，未知类型仅报告形状。 */
function describeLogArgs(args: unknown[]): string {
  const parts: string[] = [];
  for (const arg of args.slice(0, MAX_LOG_ARGS)) {
    if (typeof arg === 'string') parts.push(arg);
    else if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') parts.push(String(arg));
    else if (arg instanceof Error) parts.push(`${arg.name}: ${arg.message}`);
    else if (isRecord(arg) && typeof arg.message === 'string') {
      parts.push(typeof arg.name === 'string' ? `${arg.name}: ${arg.message}` : arg.message);
    } else if (typeof arg === 'function') parts.push('[Function]');
    else if (arg === null || arg === undefined) parts.push(String(arg));
    else parts.push(`[${typeof arg}]`);
    if (parts.join(' ').length >= MAX_SUMMARY_CHARS) break;
  }
  return parts.join(' ') || '(无文本)';
}

function describeNetworkEntry(entry: NetworkEntry): string {
  const url = sanitizePerformanceUrl(entry.url);
  if (entry.error) return `${entry.method} ${url} 失败：${entry.error}`;
  if (!entry.pending && entry.status >= 400) {
    return `${entry.method} ${url} 返回 HTTP ${entry.status}`;
  }
  return `${entry.method} ${url} 完成，耗时 ${Math.round(entry.duration)} ms`;
}

/** 时间线文本的最后一道脱敏：凭据键值、Bearer/JWT、邮箱和 URL 查询参数一律遮蔽。 */
function redactTimelineText(value: string): string {
  const redacted = value
    .replace(/\b([\w.-]*?(?:api[-_ ]?key|token|secret|password|cookie|credential)[\w.-]*)\s*[:=]\s*([^\s,;}&"']+)/gi, '$1=[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\-/=]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s)]+/gi, '$1?[REDACTED_QUERY]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
  return redacted.length > MAX_SUMMARY_CHARS
    ? `${redacted.slice(0, MAX_SUMMARY_CHARS)}…(已截断)`
    : redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
