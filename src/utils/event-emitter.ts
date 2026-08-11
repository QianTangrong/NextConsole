/**
 * 类型化事件发布器：隔离单个监听器异常，确保其他订阅者仍能收到后续事件。
 */
let reportingListenerError = false;

/**
 * 监听器异常只记录一次且不再递归派发，防止错误处理本身造成无限循环。
 */
function reportListenerError(error: unknown): void {
  if (reportingListenerError) return;

  reportingListenerError = true;
  try {
    console.error('[Nconsole] event listener error', error);
  } finally {
    reportingListenerError = false;
  }
}

export class EventEmitter<Events extends Record<string, (...args: any[]) => void>> {
  /** 以事件名分组保存监听器，允许同一事件拥有多个订阅者。 */
  private listeners = new Map<keyof Events, Set<Function>>();

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(fn);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Events[K]): void {
    this.listeners.get(event)?.delete(fn);
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {
        reportListenerError(e);
      }
    });
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
