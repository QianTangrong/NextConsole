import { describe, expect, it } from 'vitest';
import {
  createPerformanceNetworkContext,
  normalizePerformanceDiagnosis,
  serializePerformanceSnapshot,
} from '../src/plugins/mimo-performance-diagnosis';
import type { NetworkEntry } from '../src/types';
import type { PerformanceSnapshot } from '../src/plugins/performance-snapshot';

describe('normalizePerformanceDiagnosis', () => {
  it('validates, bounds and redacts structured model output', () => {
    const result = normalizePerformanceDiagnosis(JSON.stringify({
      summary: 'token=secret test@example.com 页面偏慢',
      dataQuality: ['单次样本'],
      findings: [{
        area: '加载',
        severity: 'high',
        problem: 'LCP 偏慢',
        evidence: ['LCP 4.2s'],
        impact: '首屏等待',
      }],
      recommendations: [{
        priority: 'P0',
        title: '优化首屏图',
        actions: ['预加载 LCP 图片'],
        verification: ['重新采样'],
      }],
      needMoreContext: [],
    }));

    expect(result).toMatchObject({
      summary: 'token=[REDACTED] [REDACTED_EMAIL] 页面偏慢',
      findings: [{ severity: 'high', problem: 'LCP 偏慢' }],
      recommendations: [{ priority: 'P0', title: '优化首屏图' }],
    });
  });

  it('rejects incomplete model output', () => {
    expect(normalizePerformanceDiagnosis('{"summary":"missing arrays"}')).toBeUndefined();
    expect(normalizePerformanceDiagnosis('not json')).toBeUndefined();
  });
});

describe('performance diagnosis snapshot boundary', () => {
  it('keeps only sanitized network summaries without request or response bodies', () => {
    const entry: NetworkEntry = {
      id: 1,
      type: 'fetch',
      method: 'GET',
      url: 'https://api.example.com/orders?id=secret',
      requestHeaders: { Authorization: 'Bearer secret' },
      requestBody: { token: 'secret' },
      status: 500,
      statusText: 'Internal Error',
      responseHeaders: { 'Set-Cookie': 'secret' },
      responseBody: { private: true },
      startTime: 100,
      endTime: 1_300,
      duration: 1_200,
      pending: false,
      error: 'token=secret',
    };

    const context = createPerformanceNetworkContext([entry], 10);
    const serialized = JSON.stringify(context);

    expect(context).toMatchObject({ capturedRequestCount: 1, failedRequestCount: 1 });
    expect(serialized).toContain('https://api.example.com/orders');
    expect(serialized).not.toContain('?id=secret');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('requestBody');
    expect(serialized).not.toContain('responseBody');
    expect(serialized).toContain('token=[REDACTED]');
  });

  it('caps detailed resource and long-task arrays before sending', () => {
    const performance = createPerformanceSnapshot();
    const serialized = serializePerformanceSnapshot({
      schemaVersion: 1,
      performance,
      localFindings: [],
      network: {},
      recentErrors: [],
    }, 100_000);
    const parsed = JSON.parse(serialized) as { performance: PerformanceSnapshot };

    expect(parsed.performance.resources.slowest).toHaveLength(12);
    expect(parsed.performance.resources.largest).toHaveLength(12);
    expect(parsed.performance.longTasks.entries).toHaveLength(12);
  });
});

function createPerformanceSnapshot(): PerformanceSnapshot {
  const resources = Array.from({ length: 20 }, (_, index) => ({
    url: `https://cdn.example.com/${index}.js`,
    displayName: `${index}.js`,
    type: 'script' as const,
    startTimeMs: index,
    durationMs: 100 + index,
    transferSize: 1_000,
    encodedBodySize: 900,
    decodedBodySize: 2_000,
  }));
  const longTasks = Array.from({ length: 20 }, (_, index) => ({ startTimeMs: index, durationMs: 60 + index }));
  return {
    schemaVersion: 1,
    capturedAt: new Date(0).toISOString(),
    page: {
      url: 'https://example.com/',
      title: 'Example',
      readyState: 'complete',
      visibilityState: 'visible',
    },
    environment: {
      userAgent: 'test',
      viewport: { width: 390, height: 844, devicePixelRatio: 3 },
    },
    metrics: [],
    resources: {
      count: resources.length,
      totalTransferSize: 20_000,
      totalDecodedBodySize: 40_000,
      byType: [{ type: 'script', count: 20, transferSize: 20_000, decodedBodySize: 40_000 }],
      slowest: resources,
      largest: resources,
    },
    longTasks: {
      count: longTasks.length,
      totalDurationMs: 1_390,
      totalBlockingTimeMs: 390,
      longestDurationMs: 79,
      entries: longTasks,
    },
    dataQuality: {
      sampleType: 'current-session',
      collectionStartedAtMs: 0,
      pageWasHidden: false,
      unsupportedEntryTypes: [],
      missingMetrics: [],
      notes: [],
      selfIsolation: {
        excludedResourceCount: 0,
        adjustedLongTaskCount: 0,
        excludedLongTaskDurationMs: 0,
      },
    },
  };
}
