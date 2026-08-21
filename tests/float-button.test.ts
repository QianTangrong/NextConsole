import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FloatButton } from '../src/ui/float-button';

class TestElement extends EventTarget {
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  removed = false;

  get offsetLeft(): number {
    return Number.parseFloat(this.style.left || '0');
  }

  get offsetTop(): number {
    return Number.parseFloat(this.style.top || '0');
  }

  setAttribute(): void {}

  remove(): void {
    this.removed = true;
  }
}

class TestWindow extends EventTarget {
  innerWidth = 1280;
  innerHeight = 720;
}

function pointerEvent(type: string, clientX: number, clientY: number): Event {
  return Object.assign(new Event(type, { cancelable: true }), { clientX, clientY });
}

describe('FloatButton', () => {
  let button: TestElement;
  let testWindow: TestWindow;

  beforeEach(() => {
    button = new TestElement();
    testWindow = new TestWindow();
    vi.stubGlobal('window', testWindow);
    vi.stubGlobal('document', {
      createElement: () => button,
    });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waits for click before opening so the same gesture cannot hit the new backdrop', () => {
    const onClick = vi.fn();
    const container = {
      appendChild: vi.fn(),
    } as unknown as ShadowRoot;
    const floatButton = new FloatButton(container, onClick);

    button.dispatchEvent(pointerEvent('pointerdown', 1240, 644));
    testWindow.dispatchEvent(pointerEvent('pointerup', 1240, 644));
    expect(onClick).not.toHaveBeenCalled();

    button.dispatchEvent(new Event('click', { cancelable: true }));
    expect(onClick).toHaveBeenCalledOnce();

    floatButton.destroy();
  });

  it('does not treat a completed drag as a click', () => {
    const onClick = vi.fn();
    const container = {
      appendChild: vi.fn(),
    } as unknown as ShadowRoot;
    const floatButton = new FloatButton(container, onClick);

    button.dispatchEvent(pointerEvent('pointerdown', 1240, 644));
    testWindow.dispatchEvent(pointerEvent('pointermove', 1220, 644));
    testWindow.dispatchEvent(pointerEvent('pointerup', 1220, 644));
    button.dispatchEvent(new Event('click', { cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();

    button.dispatchEvent(pointerEvent('pointerdown', 1220, 644));
    testWindow.dispatchEvent(pointerEvent('pointerup', 1220, 644));
    button.dispatchEvent(new Event('click', { cancelable: true }));
    expect(onClick).toHaveBeenCalledOnce();

    floatButton.destroy();
  });
});
