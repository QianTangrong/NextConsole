/**
 * 悬浮入口按钮：处理拖拽、边缘吸附和显示/隐藏面板的点击行为。
 */
import { clamp, on } from '../utils/dom';

/**
 * 可拖拽的悬浮入口：区分点击与拖拽，并在拖拽结束后吸附到最近的水平边缘。
 */
export class FloatButton {
  private el: HTMLElement;
  private cleanups: (() => void)[] = [];
  private isDragging = false;
  private dragStarted = false;
  private startX = 0;
  private startY = 0;
  private offsetX = 0;
  private offsetY = 0;
  private currentX = 0;
  private currentY = 0;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private moveFrame: number | null = null;
  private pendingPosition: { x: number; y: number } | null = null;
  private suppressNextClick = false;

  constructor(
    private container: ShadowRoot,
    private onClick: () => void,
    position?: { x: number; y: number },
  ) {
    this.el = document.createElement('button');
    this.el.className = 'nc-float-btn';
    this.el.textContent = 'NC';
    this.el.setAttribute('aria-label', 'Toggle Nconsole');

    // Default position: bottom-right
    const x = position?.x ?? window.innerWidth - 64;
    const y = position?.y ?? window.innerHeight - 100;
    this.setPosition(x, y);

    container.appendChild(this.el);
    this.bindEvents();
  }

  /** 位置始终限制在可视区域，防止缩放或旋转后按钮完全移出屏幕。 */
  private setPosition(x: number, y: number): void {
    const maxX = window.innerWidth - 48;
    const maxY = window.innerHeight - 48;
    this.currentX = clamp(x, 0, maxX);
    this.currentY = clamp(y, 0, maxY);
    this.el.style.left = `${this.currentX}px`;
    this.el.style.top = `${this.currentY}px`;
  }

  /** 合并同一动画帧内的连续指针事件，避免拖动时反复触发布局。 */
  private schedulePosition(x: number, y: number): void {
    this.pendingPosition = { x, y };
    if (this.moveFrame !== null) return;
    this.moveFrame = requestAnimationFrame(() => {
      this.moveFrame = null;
      this.flushPosition();
    });
  }

  private flushPosition(): void {
    if (!this.pendingPosition) return;
    const { x, y } = this.pendingPosition;
    this.pendingPosition = null;
    this.setPosition(x, y);
  }

  private bindEvents(): void {
    // Pointer Events 统一鼠标、触摸与触控笔，避免为同一拖动链路维护两套监听器。
    const onEnd = () => {
      if (!this.isDragging) return;
      if (this.dragStarted) {
        this.flushPosition();
        this.snapToEdge();
        this.suppressNextClick = true;
      }
      this.isDragging = false;
      this.dragStarted = false;
    };

    this.cleanups.push(
      on(this.el, 'pointerdown', (event: PointerEvent) => {
        event.preventDefault();
        this.isDragging = true;
        this.dragStarted = false;
        this.suppressNextClick = false;
        this.startX = event.clientX;
        this.startY = event.clientY;
        this.offsetX = this.el.offsetLeft;
        this.offsetY = this.el.offsetTop;
      }),
      on(window as any, 'pointermove', (event: PointerEvent) => {
        if (!this.isDragging) return;
        const dx = event.clientX - this.startX;
        const dy = event.clientY - this.startY;
        if (!this.dragStarted && Math.abs(dx) + Math.abs(dy) > 5) this.dragStarted = true;
        if (this.dragStarted) this.schedulePosition(this.offsetX + dx, this.offsetY + dy);
      }),
      on(window as any, 'pointerup', onEnd),
      on(window as any, 'pointercancel', () => {
        this.isDragging = false;
        this.dragStarted = false;
        this.pendingPosition = null;
      }),
      // 普通点击必须等 click 到达按钮后再切换层级，避免 pointerup 后续 click 命中新出现的遮罩。
      on(this.el, 'click', (event: MouseEvent) => {
        event.preventDefault();
        if (this.suppressNextClick) {
          this.suppressNextClick = false;
          return;
        }
        this.onClick();
      }),
    );

    const keepInViewport = () => {
      this.setPosition(this.currentX, this.currentY);
    };

    this.cleanups.push(
      on(window as any, 'resize', keepInViewport),
      on(window as any, 'orientationchange' as any, keepInViewport),
    );
  }

  /** 根据当前位置与视口中线将按钮吸附到最近的水平边缘。 */
  private snapToEdge(): void {
    const x = this.el.offsetLeft;
    const midX = window.innerWidth / 2;
    const targetX = clamp(x < midX ? 8 : window.innerWidth - 56, 0, window.innerWidth - 48);
    this.currentX = targetX;
    this.el.style.transition = 'left 0.2s ease';
    this.el.style.left = `${targetX}px`;
    if (this.snapTimer !== null) {
      clearTimeout(this.snapTimer);
    }
    this.snapTimer = setTimeout(() => {
      this.el.style.transition = '';
      this.snapTimer = null;
    }, 200);
  }

  show(): void {
    this.el.style.display = 'flex';
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  destroy(): void {
    if (this.moveFrame !== null) {
      cancelAnimationFrame(this.moveFrame);
      this.moveFrame = null;
    }
    this.pendingPosition = null;
    if (this.snapTimer !== null) {
      clearTimeout(this.snapTimer);
      this.snapTimer = null;
    }
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    this.el.remove();
  }
}
