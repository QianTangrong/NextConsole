/**
 * REPL 运行核心：在隔离的执行入口中保存命令、输出和错误历史，并向面板发出更新事件。
 */
import { EventEmitter } from '../utils/event-emitter';

export interface ReplEntry {
  id: number;
  type: 'input' | 'output' | 'error';
  content: string;
  timestamp: number;
}

type ReplEvents = {
  entry: (entry: ReplEntry) => void;
  clear: () => void;
};

let _replId = 0;

/**
 * 在页面上下文执行 JavaScript，并将输入、输出和异常统一保存为可渲染条目。
 */
export class ReplCore extends EventEmitter<ReplEvents> {
  /** 执行记录与命令历史分开保存，清空输出不会影响方向键回溯。 */
  private entries: ReplEntry[] = [];
  private history: string[] = [];
  private maxHistory = 100;

  /** 创建条目并立即通知面板，保证同步执行结果也能按时间顺序显示。 */
  private addEntry(type: ReplEntry['type'], content: string): ReplEntry {
    const entry: ReplEntry = {
      id: ++_replId,
      type,
      content,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    this.emit('entry', entry);
    return entry;
  }

  /** 执行非空代码并捕获同步异常；REPL 有意运行在宿主页上下文，仅限调试场景使用。 */
  execute(code: string): void {
    if (!code.trim()) return;

    // Record input
    this.addEntry('input', code);

    // Save to history
    this.history.push(code);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Execute in global scope
    try {
      // Use indirect eval to execute in global scope
      const indirectEval = eval;
      const result = indirectEval(code);
      this.addEntry('output', this.formatResult(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addEntry('error', msg);
    }
  }

  /** 尽量保留对象结构，序列化失败时安全回退为字符串描述。 */
  private formatResult(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'function') return `ƒ ${value.name || 'anonymous'}()`;
    if (typeof value === 'symbol') return value.toString();
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value instanceof HTMLElement) return `<${value.tagName.toLowerCase()}>`;
    if (value instanceof NodeList) return `NodeList(${value.length})`;
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  getEntries(): ReplEntry[] {
    return this.entries;
  }

  getHistory(): string[] {
    return this.history;
  }

  clear(): void {
    this.entries.length = 0;
    this.emit('clear');
  }

  destroy(): void {
    this.removeAllListeners();
  }
}
