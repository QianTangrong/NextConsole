import type { NetworkEntry, SSEEvent, StreamMessage } from '../../types';
import { BoundedBuffer } from '../../utils/bounded-buffer';

/** 面板内单个实时通道最多保留的消息数，避免长连接无限增长。 */
const MAX_MESSAGES = 1000;
const MAX_MESSAGE_CHARS = 980;

/** 统一完成请求计时，减少各协议重复的状态收尾逻辑。 */
export function finishNetworkEntry(entry: NetworkEntry): void {
  entry.duration = (entry.endTime = performance.now()) - entry.startTime;
  entry.pending = false;
}

/** 协议拦截器只依赖这组写入能力，不直接感知 NetworkCore 的事件实现。 */
export interface NetworkCaptureSink {
  addEntry(entry: NetworkEntry): void;
  emitUpdate(entry: NetworkEntry): void;
  scheduleUpdate(entry: NetworkEntry): void;
  pushSSEEvent(entry: NetworkEntry, event: SSEEvent): void;
  pushStreamMessage(entry: NetworkEntry, message: StreamMessage): void;
}

/**
 * 统一管理请求记录、消息限流和流式刷新调度，让各协议只处理自己的浏览器 API 生命周期。
 */
export class NetworkCaptureStore implements NetworkCaptureSink {
  private entries: BoundedBuffer<NetworkEntry>;
  private activeEntries = new Set<NetworkEntry>();
  private scheduledUpdates = new Map<number, number>();

  constructor(
    private readonly retentionLimit: number,
    private readonly onRequest: (entry: NetworkEntry) => void,
    private readonly onUpdate: (entry: NetworkEntry, requiresTableRebuild: boolean) => void,
    private readonly onClear: () => void,
  ) {
    this.entries = new BoundedBuffer(retentionLimit);
  }

  addEntry(entry: NetworkEntry): void {
    const removed = this.entries.push(entry);
    this.activeEntries.add(entry);
    if (removed) {
      this.activeEntries.delete(removed);
      this.cancelScheduledUpdate(removed);
    }
    this.onRequest(entry);
  }

  emitUpdate(entry: NetworkEntry): void {
    this.cancelScheduledUpdate(entry);
    if (this.isActive(entry)) this.onUpdate(entry, true);
  }

  pushSSEEvent(entry: NetworkEntry, event: SSEEvent): void {
    if (!this.isActive(entry)) return;
    const events = entry.sseEvents;
    if (!events) return;
    pushBoundedMessage(events, event);
  }

  pushStreamMessage(entry: NetworkEntry, message: StreamMessage): void {
    if (!this.isActive(entry)) return;
    const messages = entry.messages;
    if (!messages) return;
    pushBoundedMessage(messages, message);
    this.scheduleUpdate(entry);
  }

  /** 浏览器可用时按动画帧合并更新，非可视环境退回短定时器。 */
  scheduleUpdate(entry: NetworkEntry): void {
    if (!this.isActive(entry) || this.scheduledUpdates.has(entry.id)) return;

    const flush = () => {
      this.scheduledUpdates.delete(entry.id);
      if (this.isActive(entry)) this.onUpdate(entry, false);
    };

    this.scheduledUpdates.set(entry.id, window.requestAnimationFrame(flush));
  }

  getEntries(): NetworkEntry[] {
    return this.entries.toArray();
  }

  clear(): void {
    this.cancelAllScheduledUpdates();
    this.entries.clear();
    this.activeEntries.clear();
    this.onClear();
  }

  destroy(): void {
    this.cancelAllScheduledUpdates();
    this.activeEntries.clear();
  }

  private isActive(entry: NetworkEntry): boolean {
    return this.activeEntries.has(entry);
  }

  private cancelAllScheduledUpdates(): void {
    this.scheduledUpdates.forEach((handle) => window.cancelAnimationFrame(handle));
    this.scheduledUpdates.clear();
  }

  private cancelScheduledUpdate(entry: NetworkEntry): void {
    const scheduled = this.scheduledUpdates.get(entry.id);
    if (!scheduled) return;

    window.cancelAnimationFrame(scheduled);
    this.scheduledUpdates.delete(entry.id);
  }
}

function truncateMessageData(data: string): string {
  return data.length > MAX_MESSAGE_CHARS
    ? `${data.slice(0, MAX_MESSAGE_CHARS)}...(truncated)`
    : data;
}

function pushBoundedMessage<T extends { data: string }>(items: T[], item: T): void {
  items.push({ ...item, data: truncateMessageData(item.data) });
  if (items.length > MAX_MESSAGES) items.splice(0, items.length - MAX_MESSAGES);
}
