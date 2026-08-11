/**
 * DOM 元素检查核心：生成安全的节点树，并在页面上高亮当前查看的元素。
 */
import { escapeHTML, ncClass } from '../utils/dom';

const MAX_RENDERED_NODES = 2_000;

type RenderBudget = {
  remaining: number;
  nextId: number;
};

/**
 * 生成可折叠 DOM 树，并在用户悬停节点时以独立遮罩高亮对应页面元素。
 */
export class ElementCore {
  /** 高亮层独立于被检查元素，避免向宿主 DOM 注入临时样式或属性。 */
  private highlightOverlay: HTMLElement | null = null;

  init(): void {
    // 遮罩使用 fixed 定位，滚动页面时仍可准确贴合视口内的目标元素。
    this.highlightOverlay = document.createElement('div');
    Object.assign(this.highlightOverlay.style, {
      position: 'fixed',
      zIndex: '2147483646',
      pointerEvents: 'none',
      border: '2px solid #61dafb',
      backgroundColor: 'rgba(97, 218, 251, 0.1)',
      display: 'none',
    });
    document.body.appendChild(this.highlightOverlay);
  }

  /** 从指定根节点生成受最大深度限制的可折叠 DOM 树。 */
  renderTree(root: Element = document.documentElement, maxDepth = 8): string {
    return this.renderNode(root, 0, maxDepth, {
      remaining: MAX_RENDERED_NODES,
      nextId: 0,
    });
  }

  /** 递归输出节点 HTML；深度与总节点双上限共同防止超大页面阻塞主线程。 */
  private renderNode(node: Element, depth: number, maxDepth: number, budget: RenderBudget): string {
    if (depth >= maxDepth) {
      return `<div class="${ncClass('dom-node')}" style="padding-left:${depth * 16}px">...</div>`;
    }
    budget.remaining -= 1;

    const tag = node.tagName.toLowerCase();
    const attrs = this.renderAttributes(node);
    const hasChildren = node.children.length > 0;
    const id = `nc-dom-${budget.nextId++}`;
    const selector = escapeHTML(this.getSelector(node));

    let html = '';

    if (hasChildren) {
      html += `<div class="${ncClass('dom-node', 'dom-collapsible')}" style="padding-left:${depth * 16}px">`;
      html += `<span class="${ncClass('dom-toggle')}" data-nc-toggle="${id}">▶</span> `;
      html += `<span class="${ncClass('dom-tag')}" data-nc-highlight="${selector}">&lt;${escapeHTML(tag)}</span>`;
      html += attrs;
      html += `<span class="${ncClass('dom-tag')}">&gt;</span>`;
      html += `</div>`;
      html += `<div class="${ncClass('dom-children')}" id="${id}" style="display:none">`;
      for (let i = 0; i < node.children.length; i++) {
        if (budget.remaining <= 0) {
          html += `<div class="${ncClass('dom-node')}" style="padding-left:${(depth + 1) * 16}px">... DOM tree truncated ...</div>`;
          break;
        }
        html += this.renderNode(node.children[i], depth + 1, maxDepth, budget);
      }
      html += `<div class="${ncClass('dom-node')}" style="padding-left:${depth * 16}px">`;
      html += `<span class="${ncClass('dom-tag')}">&lt;/${escapeHTML(tag)}&gt;</span>`;
      html += `</div>`;
      html += `</div>`;
    } else {
      const text = node.textContent?.trim();
      const textPreview = text && text.length > 0 ? escapeHTML(text.slice(0, 60)) : '';
      html += `<div class="${ncClass('dom-node')}" style="padding-left:${depth * 16}px">`;
      html += `<span class="${ncClass('dom-tag')}" data-nc-highlight="${selector}">&lt;${escapeHTML(tag)}</span>`;
      html += attrs;
      if (textPreview) {
        html += `<span class="${ncClass('dom-tag')}">&gt;</span>`;
        html += `<span class="${ncClass('dom-text')}">${textPreview}</span>`;
        html += `<span class="${ncClass('dom-tag')}">&lt;/${escapeHTML(tag)}&gt;</span>`;
      } else {
        html += `<span class="${ncClass('dom-tag')}">/&gt;</span>`;
      }
      html += `</div>`;
    }

    return html;
  }

  private renderAttributes(node: Element): string {
    let html = '';
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes[i];
      html += ` <span class="${ncClass('dom-attr')}">${escapeHTML(attr.name)}</span>`;
      html += `=<span class="${ncClass('dom-attr-val')}">"${escapeHTML(attr.value.slice(0, 80))}"</span>`;
    }
    return html;
  }

  private getSelector(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.split(' ').filter(Boolean).map(c => CSS.escape(c)).join('.');
      return classes ? `${tag}.${classes}` : tag;
    }
    return tag;
  }

  /** 根据内部生成的选择器定位元素，并同步遮罩的实际边界。 */
  highlight(selector: string): void {
    if (!this.highlightOverlay) return;
    try {
      // Skip NextConsole's own elements
      const el = document.querySelector(selector);
      if (!el) {
        this.clearHighlight();
        return;
      }
      const rect = el.getBoundingClientRect();
      Object.assign(this.highlightOverlay.style, {
        display: 'block',
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    } catch {
      this.clearHighlight();
    }
  }

  clearHighlight(): void {
    if (this.highlightOverlay) {
      this.highlightOverlay.style.display = 'none';
    }
  }

  destroy(): void {
    if (this.highlightOverlay && this.highlightOverlay.parentNode) {
      this.highlightOverlay.parentNode.removeChild(this.highlightOverlay);
    }
    this.highlightOverlay = null;
  }
}
