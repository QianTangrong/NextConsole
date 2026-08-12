/**
 * 固定容量缓冲区。通过游标批量回收旧值，避免每次淘汰都移动整个数组。
 */
export class BoundedBuffer<T> {
  private items: T[] = [];
  private start = 0;

  constructor(readonly limit: number) {}

  push(value: T): T | undefined {
    if (this.limit === 0) return value;
    this.items.push(value);
    if (this.size <= this.limit) return undefined;

    const removed = this.items[this.start++];
    if (this.start >= this.limit) {
      this.items = this.items.slice(this.start);
      this.start = 0;
    }
    return removed;
  }

  toArray(): T[] {
    return this.items.slice(this.start);
  }

  get size(): number {
    return this.items.length - this.start;
  }

  clear(): void {
    this.items.length = 0;
    this.start = 0;
  }
}

/** 将外部容量配置收敛为有限非负整数，非法值回退到安全默认值。 */
export function normalizeRetentionLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : fallback;
}
