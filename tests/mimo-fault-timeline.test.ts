import { describe, expect, it } from 'vitest';
import {
  buildFaultTimeline,
  serializeFaultTimeline,
  LONG_TASK_DURATION_MS,
  MAX_TIMELINE_EVENTS,
  SLOW_NETWORK_DURATION_MS,
} from '../src/plugins/mimo-fault-timeline';
import type { LogEntry, NetworkEntry } from '../src/types';

const TIME_ORIGIN = 1_700_000_000_000;

function createLog(overrides: Partial<LogEntry>): LogEntry {
  return { id: 1, level: 'log', args: [], timestamp: TIME_ORIGIN, ...overrides };
}

function createNetwork(overrides: Partial<NetworkEntry>): NetworkEntry {
  return {
    id: 1,
    type: 'fetch',
    method: 'GET',
    url: 'https://api.example.com/data',
    requestHeaders: {},
    requestBody: undefined,
    status: 200,
    statusText: 'OK',
    responseHeaders: {},
    responseBody: undefined,
    startTime: 0,
    endTime: 0,
    duration: 0,
    pending: false,
    ...overrides,
  };
}

describe('buildFaultTimeline', () => {
  it('merges console, network and long-task signals into ascending chronological order', () => {
    const timeline = buildFaultTimeline({
      logs: [createLog({ level: 'error', args: ['late failure'], timestamp: TIME_ORIGIN + 5_000 })],
      network: [createNetwork({ error: 'timeout', startTime: 1_000 })],
      longTasks: [{ startTimeMs: 3_000, durationMs: 80 }],
      timeOrigin: TIME_ORIGIN,
    });

    expect(timeline.events.map((event) => event.type)).toEqual(['network', 'long-task', 'console']);
    expect(timeline.events.map((event) => event.timestamp)).toEqual([
      TIME_ORIGIN + 1_000,
      TIME_ORIGIN + 3_000,
      TIME_ORIGIN + 5_000,
    ]);
    for (const event of timeline.events) {
      expect(event.timestampIso).toBe(new Date(event.timestamp).toISOString());
    }
  });

  it('keeps only the most recent 30 events in ascending order', () => {
    const logs = Array.from({ length: MAX_TIMELINE_EVENTS + 10 }, (_, index) => createLog({
      id: index,
      level: 'error',
      args: [`failure ${index}`],
      timestamp: TIME_ORIGIN + index * 1_000,
    }));

    const timeline = buildFaultTimeline({ logs, network: [], timeOrigin: TIME_ORIGIN });

    expect(timeline.events).toHaveLength(MAX_TIMELINE_EVENTS);
    expect(timeline.events[0].timestamp).toBe(TIME_ORIGIN + 10_000);
    expect(timeline.events[MAX_TIMELINE_EVENTS - 1].timestamp).toBe(TIME_ORIGIN + 39_000);
    for (let index = 1; index < timeline.events.length; index += 1) {
      expect(timeline.events[index].timestamp).toBeGreaterThanOrEqual(timeline.events[index - 1].timestamp);
    }
  });

  it('classifies console levels and ignores non-warning levels', () => {
    const timeline = buildFaultTimeline({
      logs: [
        createLog({ id: 1, level: 'log', args: ['plain'], timestamp: TIME_ORIGIN }),
        createLog({ id: 2, level: 'info', args: ['info'], timestamp: TIME_ORIGIN + 1 }),
        createLog({ id: 3, level: 'debug', args: ['debug'], timestamp: TIME_ORIGIN + 2 }),
        createLog({ id: 4, level: 'warn', args: ['warned'], timestamp: TIME_ORIGIN + 3 }),
        createLog({ id: 5, level: 'error', args: ['failed'], timestamp: TIME_ORIGIN + 4 }),
      ],
      network: [],
      timeOrigin: TIME_ORIGIN,
    });

    expect(timeline.events).toHaveLength(2);
    expect(timeline.events[0]).toMatchObject({ type: 'console', severity: 'warning' });
    expect(timeline.events[1]).toMatchObject({ type: 'console', severity: 'error' });
  });

  it('classifies failed and slow network requests', () => {
    const timeline = buildFaultTimeline({
      logs: [],
      network: [
        createNetwork({ id: 1, error: 'network down', pending: true, startTime: 10 }),
        createNetwork({ id: 2, status: 500, pending: false, startTime: 20 }),
        createNetwork({ id: 3, status: 404, pending: false, startTime: 30 }),
        createNetwork({ id: 4, status: 200, duration: SLOW_NETWORK_DURATION_MS + 500, pending: false, startTime: 40 }),
        createNetwork({ id: 5, status: 200, duration: SLOW_NETWORK_DURATION_MS - 1, pending: false, startTime: 50 }),
        createNetwork({ id: 6, status: 200, duration: 5_000, pending: true, startTime: 60 }),
      ],
      timeOrigin: TIME_ORIGIN,
    });

    expect(timeline.events.map((event) => event.severity)).toEqual(['error', 'error', 'error', 'warning']);
    expect(timeline.events.map((event) => event.timestamp)).toEqual([
      TIME_ORIGIN + 10,
      TIME_ORIGIN + 20,
      TIME_ORIGIN + 30,
      TIME_ORIGIN + 40,
    ]);
    expect(timeline.events[0].summary).toContain('失败');
    expect(timeline.events[1].summary).toContain('HTTP 500');
    expect(timeline.events[3].summary).toContain(`${SLOW_NETWORK_DURATION_MS + 500} ms`);
  });

  it('includes long tasks only at or above the threshold', () => {
    const timeline = buildFaultTimeline({
      logs: [],
      network: [],
      longTasks: [
        { startTimeMs: 10, durationMs: LONG_TASK_DURATION_MS - 1 },
        { startTimeMs: 20, durationMs: LONG_TASK_DURATION_MS },
      ],
      timeOrigin: TIME_ORIGIN,
    });

    expect(timeline.events).toHaveLength(1);
    expect(timeline.events[0]).toMatchObject({ type: 'long-task', severity: 'warning', timestamp: TIME_ORIGIN + 20 });
    expect(timeline.events[0].summary).toContain(`${LONG_TASK_DURATION_MS} ms`);
  });

  it('never serializes query strings, credentials, headers or bodies', () => {
    const timeline = buildFaultTimeline({
      logs: [createLog({
        level: 'error',
        args: [{ password: 'hunter2', note: 'see https://x.example.com/a?session=abc' }],
        timestamp: TIME_ORIGIN,
      })],
      network: [createNetwork({
        url: 'https://api.example.com/orders?id=secret&token=abc123',
        requestHeaders: { Authorization: 'Bearer secret-token' },
        requestBody: { password: 'hunter2' },
        responseHeaders: { 'Set-Cookie': 'session=topsecret' },
        responseBody: { secretPayload: true },
        status: 500,
        error: 'token=abc123 Bearer eyJaaa.bbb.ccc contact user@example.com',
        startTime: 10,
      })],
      timeOrigin: TIME_ORIGIN,
    });
    const serialized = JSON.stringify(timeline);

    expect(serialized).toContain('https://api.example.com/orders');
    expect(serialized).toContain('token=[REDACTED]');
    for (const leaked of [
      'secret', 'hunter2', 'abc123', 'topsecret', 'eyJaaa', 'user@example.com',
      '?id=', 'session=abc', 'Authorization', 'Set-Cookie',
      'requestBody', 'responseBody', 'requestHeaders', 'responseHeaders',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('returns an empty timeline when no signal qualifies', () => {
    const timeline = buildFaultTimeline({ logs: [], network: [], longTasks: [], timeOrigin: TIME_ORIGIN });
    expect(timeline.events).toEqual([]);
    expect(timeline.schemaVersion).toBe(1);
  });
});

describe('serializeFaultTimeline', () => {
  it('drops oldest events first to stay within the character budget', () => {
    const logs = Array.from({ length: MAX_TIMELINE_EVENTS }, (_, index) => createLog({
      id: index,
      level: 'error',
      args: ['x'.repeat(150)],
      timestamp: TIME_ORIGIN + index * 1_000,
    }));
    const timeline = buildFaultTimeline({ logs, network: [], timeOrigin: TIME_ORIGIN });

    const serialized = serializeFaultTimeline(timeline, 1_000);
    const parsed = JSON.parse(serialized) as ReturnType<typeof buildFaultTimeline>;

    expect(serialized.length).toBeLessThanOrEqual(1_000);
    expect(parsed.events.length).toBeLessThan(MAX_TIMELINE_EVENTS);
    expect(parsed.events[parsed.events.length - 1].timestamp).toBe(TIME_ORIGIN + (MAX_TIMELINE_EVENTS - 1) * 1_000);
  });
});
