/**
 * 全局函数 Hook 的链路元数据。使用全局 Symbol，让同页的多个 Nconsole bundle
 * 也能识别彼此创建的包装器，并在乱序销毁时安全摘除失效节点。
 */
const GLOBAL_HOOK_LINK = Symbol.for('nconsole.global-hook-link');

export interface GlobalHookLink<T extends Function> {
  previous: T;
  active: boolean;
}

export interface GlobalHookHandle<T extends Function> {
  hook: T;
  link: GlobalHookLink<T>;
}

/** 创建调用方自定义的包装器，并附加不可枚举的 Hook 链路信息。 */
export function createGlobalHook<T extends Function>(
  previous: T,
  createHook: (link: GlobalHookLink<T>) => T,
): GlobalHookHandle<T> {
  const link: GlobalHookLink<T> = { previous, active: true };
  const hook = createHook(link);
  Object.defineProperty(hook, GLOBAL_HOOK_LINK, { value: link });
  return { hook, link };
}

/**
 * 将指定包装器从仍可识别的 Hook 链中摘除。
 * 遇到后装的第三方包装器时保持其全局引用不变；失效节点自身必须负责无副作用透传。
 */
export function detachGlobalHook<T extends Function>(
  current: T,
  handle: GlobalHookHandle<T>,
): T {
  handle.link.active = false;

  const top = skipInactiveHooks(current);
  const visited = new Set<Function>();
  let cursor = top;

  while (!visited.has(cursor)) {
    visited.add(cursor);
    const link = getGlobalHookLink(cursor);
    if (!link) break;

    link.previous = skipInactiveHooks(link.previous);
    cursor = link.previous;
  }

  return top;
}

/** 跳过连续的失效包装器，并用环检测防御异常的第三方链路元数据。 */
function skipInactiveHooks<T extends Function>(hook: T): T {
  const visited = new Set<Function>();
  let current = hook;

  while (!visited.has(current)) {
    visited.add(current);
    const link = getGlobalHookLink(current);
    if (!link || link.active) return current;
    current = link.previous;
  }

  return current;
}

function getGlobalHookLink<T extends Function>(hook: T): GlobalHookLink<T> | undefined {
  return (hook as T & Record<symbol, unknown>)[GLOBAL_HOOK_LINK] as
    | GlobalHookLink<T>
    | undefined;
}
