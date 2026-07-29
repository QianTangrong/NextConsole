/**
 * DOM 通用工具：统一类名前缀、节点创建、事件清理和 HTML 转义，降低跨面板实现差异。
 */
const NC_PREFIX = 'nc-';

/** 根据标签、属性与子节点创建 DOM 元素，字符串子节点始终以文本节点插入。 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'className') {
        el.className = value;
      } else {
        el.setAttribute(key, value);
      }
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else {
        el.appendChild(child);
      }
    }
  }
  return el;
}

/** 为样式类添加 NextConsole 前缀，避免与宿主页面类名冲突。 */
export function ncClass(...names: string[]): string {
  return names.map((n) => `${NC_PREFIX}${n}`).join(' ');
}

/** 在受控的 Shadow DOM 容器中写入已由调用方构造的 HTML。 */
export function setHTML(el: HTMLElement, html: string): void {
  el.innerHTML = html;
}

/** 在指定容器内查询首个匹配元素。 */
export function $(selector: string, container: ParentNode = document): HTMLElement | null {
  return container.querySelector(selector);
}

/** 在指定容器内查询全部匹配元素。 */
export function $$(selector: string, container: ParentNode = document): HTMLElement[] {
  return Array.from(container.querySelectorAll(selector));
}

/** 绑定事件并返回对应的清理函数，便于组件销毁时统一释放。 */
export function on<K extends keyof HTMLElementEventMap>(
  el: EventTarget,
  event: K,
  handler: (e: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  el.addEventListener(event, handler as EventListener, options);
  return () => el.removeEventListener(event, handler as EventListener, options);
}

/** 将数值限制在闭区间内，用于拖拽坐标等边界敏感值。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 转义 HTML 特殊字符，避免不可信文本被当作标签或属性解析。 */
export function escapeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
