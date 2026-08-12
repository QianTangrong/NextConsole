/** 为日志和 REPL 生成有深度、节点、条目和文本预算的不可变快照。 */
export function snapshotValue(value: unknown): unknown {
  let nodes = 500;
  let chars = 20_000;
  const seen = new WeakSet<object>();

  /** 单个属性失败不能破坏整组日志参数，失败值保留稳定占位符。 */
  const visit = (input: unknown, depth: number): unknown => {
    try {
      if (typeof input === 'string') {
        const length = Math.min(input.length, 10_000, chars);
        chars -= length;
        return length < input.length ? `${input.slice(0, length)}...` : input;
      }
      if (input == null || typeof input !== 'object') {
        return typeof input === 'function' ? '[fn]' : typeof input === 'symbol' ? String(input) : input;
      }
      if (seen.has(input)) return '[...]';
      if (depth >= 4 || nodes-- <= 0) return '[...]';
      seen.add(input);
      depth += 1;
      if (Array.isArray(input)) return input.slice(0, 100).map((item) => visit(item, depth));
      // 普通对象（含 Object.create(null)）逐字段容错；其他宿主对象只保留稳定描述。
      const constructor = (input as { constructor?: unknown }).constructor;
      if (constructor && constructor !== Object) return visit(String(input), depth);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(input).slice(0, 100)) {
        output[key] = visit((input as Record<string, unknown>)[key], depth);
      }
      return output;
    } catch {
      return '[...]';
    }
  };

  return visit(value, 0);
}
