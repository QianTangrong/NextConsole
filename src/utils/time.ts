/** 时间与标识工具：统一面板展示的时间格式，并生成会话内递增标识。 */

/** 将时间戳格式化为 HH:MM:SS.mmm。 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/** 将毫秒时长转为适合面板阅读的文本。 */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 为同一页面会话中的调试条目生成单调递增 ID。 */
let _idCounter = 0;
export function nextId(): number {
  return ++_idCounter;
}
