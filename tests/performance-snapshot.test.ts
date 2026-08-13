import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalPerformanceFindings,
  PerformanceSnapshotCollector,
  sanitizePerformanceUrl,
} from '../src/plugins/performance-snapshot';
import {
  beginNconsoleActivity,
  clearNconsolePerformanceIsolation,
  getNconsolePerformanceIsolation,
  markNconsoleResourceRequest,
} from '../src/utils/performance-isolation';

class MockPerformanceObserver {
  static supportedEntryTypes = ['largest-contentful-paint', 'layout-shift', 'event', 'longtask'];
  static instances: MockPerformanceObserver[] = [];

  readonly disconnect = vi.fn();
  readonly observe = vi.fn((options: PerformanceObserverInit) => {
    this.type = options.type;
  });
  type?: string;

  constructor(private readonly callback: PerformanceObserverCallback) {
    MockPerformanceObserver.instances.push(this);
  }

  emit(entries: PerformanceEntry[]): void {
    this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
  }
}

const navigationEntry = {
  entryType: 'navigation',
  name: 'https://example.com/',
  startTime: 0,
  duration: 2_100,
  type: 'navigate',
  redirectStart: 0,
  redirectEnd: 0,
  domainLookupStart: 20,
  domainLookupEnd: 50,
  connectStart: 50,
  secureConnectionStart: 70,
  connectEnd: 150,
  requestStart: 180,
  responseStart: 900,
  responseEnd: 1_100,
  domInteractive: 1_300,
  domContentLoadedEventEnd: 1_500,
  loadEventEnd: 2_100,
} as PerformanceNavigationTiming;

const resourceEntry = {
  entryType: 'resource',
  name: 'https://cdn.example.com/app.js?token=secret#hash',
  startTime: 100,
  duration: 1_200,
  initiatorType: 'script',
  transferSize: 1_200_000,
  encodedBodySize: 1_100_000,
  decodedBodySize: 2_000_000,
  nextHopProtocol: 'h2',
} as PerformanceResourceTiming;

beforeEach(() => {
  clearNconsolePerformanceIsolation();
  MockPerformanceObserver.instances = [];
  MockPerformanceObserver.supportedEntryTypes = ['largest-contentful-paint', 'layout-shift', 'event', 'longtask'];
  vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
  vi.stubGlobal('location', { href: 'https://example.com/order?id=42#detail' });
  vi.stubGlobal('window', { innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 });
  vi.stubGlobal('navigator', {
    userAgent: 'Test Browser',
    hardwareConcurrency: 8,
    deviceMemory: 4,
    connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
  });
  vi.stubGlobal('document', {
    title: 'Order detail',
    readyState: 'complete',
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('performance', {
    now: vi.fn(() => 500),
    getEntriesByType: vi.fn((type: string) => {
      if (type === 'navigation') return [navigationEntry];
      if (type === 'paint') return [
        { entryType: 'paint', name: 'first-paint', startTime: 1_000, duration: 0 },
        { entryType: 'paint', name: 'first-contentful-paint', startTime: 1_900, duration: 0 },
      ];
      if (type === 'resource') return [resourceEntry];
      return [];
    }),
    memory: { usedJSHeapSize: 40 * 1024 * 1024, jsHeapSizeLimit: 100 * 1024 * 1024 },
  });
});

afterEach(() => {
  clearNconsolePerformanceIsolation();
  vi.unstubAllGlobals();
});

describe('PerformanceSnapshotCollector', () => {
  it('collects bounded front-end performance evidence and removes URL queries', () => {
    const collector = new PerformanceSnapshotCollector(getNconsolePerformanceIsolation());
    collector.start();

    observer('largest-contentful-paint').emit([
      { entryType: 'largest-contentful-paint', name: '', startTime: 2_600, duration: 0, renderTime: 2_600, size: 800 } as unknown as PerformanceEntry,
    ]);
    observer('layout-shift').emit([
      { entryType: 'layout-shift', name: '', startTime: 2_700, duration: 0, value: 0.12, hadRecentInput: false } as unknown as PerformanceEntry,
    ]);
    observer('event').emit([
      { entryType: 'event', name: 'click', startTime: 3_000, duration: 240, interactionId: 1 } as unknown as PerformanceEntry,
    ]);
    observer('longtask').emit([
      { entryType: 'longtask', name: 'self', startTime: 500, duration: 120 } as PerformanceEntry,
    ]);

    const snapshot = collector.getSnapshot();
    const metrics = new Map(snapshot.metrics.map((metric) => [metric.key, metric]));

    expect(snapshot.page.url).toBe('https://example.com/order');
    expect(metrics.get('TTFB')?.value).toBe(900);
    expect(metrics.get('LCP')).toMatchObject({ value: 2_600, rating: 'needs-improvement' });
    expect(metrics.get('CLS')).toMatchObject({ value: 0.12, rating: 'needs-improvement' });
    expect(metrics.get('INP')).toMatchObject({ value: 240, rating: 'needs-improvement' });
    expect(snapshot.resources.slowest[0]).toMatchObject({
      url: 'https://cdn.example.com/app.js',
      type: 'script',
      transferSize: 1_200_000,
    });
    expect(snapshot.longTasks).toMatchObject({ count: 1, totalBlockingTimeMs: 70, longestDurationMs: 120 });
    expect(createLocalPerformanceFindings(snapshot).map((item) => item.area)).toEqual(
      expect.arrayContaining(['加载', '交互', '稳定性', '资源']),
    );

    collector.destroy();
    expect(MockPerformanceObserver.instances.every((item) => item.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('reports unsupported metrics instead of treating missing data as zero', () => {
    MockPerformanceObserver.supportedEntryTypes = ['longtask'];
    const collector = new PerformanceSnapshotCollector();
    collector.start();

    const snapshot = collector.getSnapshot();

    expect(snapshot.metrics.some((metric) => metric.key === 'LCP')).toBe(false);
    expect(snapshot.metrics.some((metric) => metric.key === 'CLS')).toBe(false);
    expect(snapshot.metrics.some((metric) => metric.key === 'INP')).toBe(false);
    expect(snapshot.dataQuality.unsupportedEntryTypes).toEqual(
      expect.arrayContaining(['largest-contentful-paint', 'layout-shift', 'event']),
    );
    expect(snapshot.dataQuality.missingMetrics.join(' ')).toContain('当前浏览器不支持');
  });

  it('isolates repeated plugin resources and subtracts only Nconsole work from mixed long tasks', () => {
    let now = 500;
    vi.mocked(performance.now).mockImplementation(() => now);
    const internalRefetch = {
      ...resourceEntry,
      name: 'https://cdn.example.com/app.js?plugin-refetch=1',
      startTime: 500,
      duration: 300,
    } as PerformanceResourceTiming;
    const pluginArtifact = {
      ...resourceEntry,
      name: 'https://cdn.example.com/nconsole/plugins/mimo-ai-diagnosis.mjs',
      startTime: 200,
      duration: 100,
    } as PerformanceResourceTiming;
    vi.mocked(performance.getEntriesByType).mockImplementation((type: string) => {
      if (type === 'navigation') return [navigationEntry];
      if (type === 'paint') return [];
      if (type === 'resource') return [resourceEntry, internalRefetch, pluginArtifact];
      return [];
    });

    const collector = new PerformanceSnapshotCollector(getNconsolePerformanceIsolation());
    collector.start();
    markNconsoleResourceRequest(internalRefetch.name);
    now = 520;
    const finishActivity = beginNconsoleActivity();
    now = 600;
    finishActivity();
    observer('longtask').emit([
      { entryType: 'longtask', name: 'self', startTime: 500, duration: 160 } as PerformanceEntry,
    ]);

    const snapshot = collector.getSnapshot();

    expect(snapshot.resources).toMatchObject({ count: 1, totalTransferSize: 1_200_000 });
    expect(snapshot.resources.slowest[0].url).toBe('https://cdn.example.com/app.js');
    expect(snapshot.longTasks).toMatchObject({ count: 1, longestDurationMs: 80, totalBlockingTimeMs: 30 });
    expect(snapshot.dataQuality.selfIsolation).toEqual({
      excludedResourceCount: 2,
      adjustedLongTaskCount: 1,
      excludedLongTaskDurationMs: 80,
    });
    expect(snapshot.dataQuality.notes.join(' ')).toContain('已隔离 2 个内部资源');
  });
});

describe('sanitizePerformanceUrl', () => {
  it('keeps only http(s) origin and pathname', () => {
    expect(sanitizePerformanceUrl('https://example.com/a.js?apiKey=secret#x')).toBe('https://example.com/a.js');
    expect(sanitizePerformanceUrl('https://example.com/users/test@example.com')).toBe('https://example.com/users/[REDACTED_EMAIL]');
    expect(sanitizePerformanceUrl('data:text/plain,secret')).toBe('[data: resource omitted]');
  });
});

function observer(type: string): MockPerformanceObserver {
  const instance = MockPerformanceObserver.instances.find((item) => item.type === type);
  if (!instance) throw new Error(`Missing observer: ${type}`);
  return instance;
}
