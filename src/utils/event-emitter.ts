/**
 * Simple typed event emitter.
 */
let reportingListenerError = false;

function reportListenerError(error: unknown): void {
  if (reportingListenerError) return;

  reportingListenerError = true;
  try {
    console.error('[NextConsole] event listener error', error);
  } finally {
    reportingListenerError = false;
  }
}

export class EventEmitter<Events extends Record<string, (...args: any[]) => void>> {
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
