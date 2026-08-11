import { afterEach, describe, expect, it, vi } from 'vitest';

const panelState = vi.hoisted(() => ({
  constructorError: undefined as Error | undefined,
  initError: undefined as Error | undefined,
  instances: [] as Array<{
    init: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    notifyFatalError: (error: unknown) => void;
  }>,
}));

vi.mock('../src/ui/main-panel', () => ({
  MainPanel: class MainPanelMock {
    private onFatalError?: (error: unknown) => void;

    init = vi.fn((onFatalError?: (error: unknown) => void) => {
      this.onFatalError = onFatalError;
      if (panelState.initError) throw panelState.initError;
    });

    destroy = vi.fn();

    notifyFatalError(error: unknown): void {
      this.onFatalError?.(error);
    }

    constructor() {
      if (panelState.constructorError) throw panelState.constructorError;
      panelState.instances.push(this);
    }

    show(): void {}
    hide(): void {}
    toggle(): void {}
    isVisible(): boolean { return false; }
    setTheme(): void {}
    use(): void {}
    exportForAI(): string { return ''; }
    copyForAI(): Promise<boolean> { return Promise.resolve(true); }
    getConsoleCore(): never { throw new Error('not used'); }
    getNetworkCore(): never { throw new Error('not used'); }
  },
}));

import { Nconsole } from '../src/runtime/nconsole';

afterEach(() => {
  panelState.constructorError = undefined;
  panelState.initError = undefined;
  panelState.instances.length = 0;
});

describe('Nconsole runtime lifecycle', () => {
  it('does not poison the singleton when MainPanel construction fails', () => {
    panelState.constructorError = new Error('constructor failed');
    expect(() => new Nconsole()).toThrow('constructor failed');

    panelState.constructorError = undefined;
    const instance = new Nconsole();
    expect(panelState.instances).toHaveLength(1);
    expect(panelState.instances[0].init).toHaveBeenCalledOnce();
    instance.destroy();
  });

  it('destroys partial state and allows retry when initialization fails', () => {
    panelState.initError = new Error('init failed');
    expect(() => new Nconsole()).toThrow('init failed');
    expect(panelState.instances).toHaveLength(1);
    expect(panelState.instances[0].destroy).toHaveBeenCalledOnce();

    panelState.initError = undefined;
    const instance = new Nconsole();
    expect(panelState.instances).toHaveLength(2);
    expect(panelState.instances[1].init).toHaveBeenCalledOnce();
    instance.destroy();
  });

  it('releases the singleton when deferred mounting later fails', () => {
    new Nconsole();
    const failedPanel = panelState.instances[0];

    // 真实 MainPanel 会先完成自身清理，再通知运行时撤销单例引用。
    failedPanel.destroy();
    failedPanel.notifyFatalError(new Error('deferred mount failed'));

    const retry = new Nconsole();
    expect(panelState.instances).toHaveLength(2);
    expect(failedPanel.destroy).toHaveBeenCalledOnce();
    retry.destroy();
  });
});
