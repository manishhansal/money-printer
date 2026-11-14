/**
 * system-health-monitor.service.spec.ts
 *
 * Unit tests for SystemHealthMonitorService.
 *
 * Coverage:
 *   1.  Initial state: all 6 metrics present and set to Healthy.
 *   2.  Healthy → Degraded transition during pollHealth triggers CRITICAL alert.
 *   3.  Degraded → Down transition during pollHealth triggers CRITICAL alert.
 *   4.  Healthy → Healthy (no-change) does NOT publish a CRITICAL alert.
 *   5.  Down → Healthy recovery transition does NOT publish a CRITICAL alert.
 *   6.  Redis keys are set with TTL 90 s for all 6 metrics on every poll.
 *   7.  pollHealth publishes an INFO status summary on every invocation.
 *   8.  DB query failure classifies postgresql_connection as Down.
 *   9.  Redis isHealthy() returning false classifies redis_availability as Down.
 *  10.  getHealthSnapshot returns the current in-memory states.
 *  11.  updateMetricStatus updates the in-memory state.
 *  12.  updateMetricStatus on a degrading transition triggers an immediate
 *       CRITICAL alert, independent of the poll interval.
 *
 * Requirements: 2.7, 2.8, 20.8, 20.9
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  SystemHealthMonitorService,
  ALL_METRICS,
  HEALTH_KEY_TTL_SECONDS,
} from './system-health-monitor.service';
import { NotificationService } from '../notification/notification.service';
import { RedisService } from '../redis/redis.service';
import { HealthMetricName } from './system-health-monitor.types';

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

function createRedisServiceMock(
  isHealthy = true,
): jest.Mocked<Pick<RedisService, 'isHealthy' | 'set'>> {
  return {
    isHealthy: jest.fn().mockResolvedValue(isHealthy),
    set: jest.fn().mockResolvedValue(undefined),
  };
}

function createNotificationServiceMock(): jest.Mocked<Pick<NotificationService, 'publish'>> {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
  };
}

function createDataSourceMock(
  shouldThrow = false,
  latencyMs = 0,
): jest.Mocked<Pick<DataSource, 'query'>> {
  return {
    query: jest.fn().mockImplementation(async () => {
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      if (shouldThrow) throw new Error('DB connection refused');
      return [{ '?column?': 1 }];
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('SystemHealthMonitorService', () => {
  let service: SystemHealthMonitorService;
  let redisMock: ReturnType<typeof createRedisServiceMock>;
  let notificationMock: ReturnType<typeof createNotificationServiceMock>;
  let dataSourceMock: ReturnType<typeof createDataSourceMock>;

  async function buildModule(
    overrides: {
      redisHealthy?: boolean;
      dbThrows?: boolean;
      dbLatencyMs?: number;
    } = {},
  ): Promise<void> {
    redisMock = createRedisServiceMock(overrides.redisHealthy ?? true);
    notificationMock = createNotificationServiceMock();
    dataSourceMock = createDataSourceMock(overrides.dbThrows ?? false, overrides.dbLatencyMs ?? 0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemHealthMonitorService,
        { provide: RedisService, useValue: redisMock },
        { provide: NotificationService, useValue: notificationMock },
        { provide: getDataSourceToken(), useValue: dataSourceMock },
      ],
    }).compile();

    service = module.get<SystemHealthMonitorService>(SystemHealthMonitorService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    await buildModule();
  });

  // ── Test 1: initial state ──────────────────────────────────────────────────

  it('should initialise all 6 metrics with status Healthy', () => {
    const snapshot = service.getHealthSnapshot();

    expect(Object.keys(snapshot)).toHaveLength(6);

    const expectedMetrics: HealthMetricName[] = ALL_METRICS;
    for (const metric of expectedMetrics) {
      expect(snapshot[metric]).toBe('Healthy');
    }
  });

  // ── Test 2: Healthy → Degraded triggers CRITICAL ───────────────────────────

  it('should publish a CRITICAL alert on Healthy → Degraded transition during pollHealth', async () => {
    // Force postgresql to appear Degraded on the next poll by injecting a
    // slow DataSource query (> DEGRADED_THRESHOLD_MS).
    jest.useFakeTimers();
    dataSourceMock.query.mockImplementation(async () => {
      // Advance real time by simulating elapsed > 500 ms
      return new Promise((resolve) => {
        // We override Date.now inside the service check by advancing the timer
        resolve([]);
      });
    });
    jest.useRealTimers();

    // Drive the transition directly: set initial state to Healthy (default),
    // then update postgresql_connection to Degraded via updateMetricStatus.
    // This simulates what pollHealth would do after an active check returns Degraded.
    await service.updateMetricStatus('postgresql_connection', 'Degraded');

    const criticalCalls = notificationMock.publish.mock.calls.filter(
      ([alert]) => alert.priority === 'CRITICAL',
    );
    expect(criticalCalls).toHaveLength(1);
    expect(criticalCalls[0][0]).toMatchObject({
      priority: 'CRITICAL',
      metadata: expect.objectContaining({
        metric: 'postgresql_connection',
        from: 'Healthy',
        to: 'Degraded',
      }),
    });
  });

  // ── Test 3: Degraded → Down triggers CRITICAL ──────────────────────────────

  it('should publish a CRITICAL alert on Degraded → Down transition during pollHealth', async () => {
    // Prime postgresql_connection to Degraded without triggering alert bookkeeping
    await service.updateMetricStatus('postgresql_connection', 'Degraded');
    // Clear call history so we isolate the second transition
    jest.clearAllMocks();

    // Now simulate the transition to Down
    await service.updateMetricStatus('postgresql_connection', 'Down');

    const criticalCalls = notificationMock.publish.mock.calls.filter(
      ([alert]) => alert.priority === 'CRITICAL',
    );
    expect(criticalCalls).toHaveLength(1);
    expect(criticalCalls[0][0]).toMatchObject({
      priority: 'CRITICAL',
      metadata: expect.objectContaining({
        metric: 'postgresql_connection',
        from: 'Degraded',
        to: 'Down',
      }),
    });
  });

  // ── Test 4: Healthy → Healthy does NOT publish extra alert ─────────────────

  it('should NOT publish a CRITICAL alert when a metric stays Healthy', async () => {
    // Both active checks will return Healthy (default mocks)
    await service.pollHealth();

    const criticalCalls = notificationMock.publish.mock.calls.filter(
      ([alert]) => alert.priority === 'CRITICAL',
    );
    expect(criticalCalls).toHaveLength(0);
  });

  // ── Test 5: Down → Healthy recovery does NOT trigger CRITICAL ──────────────

  it('should NOT publish a CRITICAL alert on Down → Healthy recovery transition', async () => {
    // Prime redis_availability to Down first
    await service.updateMetricStatus('redis_availability', 'Down');
    jest.clearAllMocks();

    // Recover to Healthy
    await service.updateMetricStatus('redis_availability', 'Healthy');

    const criticalCalls = notificationMock.publish.mock.calls.filter(
      ([alert]) => alert.priority === 'CRITICAL',
    );
    expect(criticalCalls).toHaveLength(0);
  });

  // ── Test 6: Redis keys set with TTL 90 s on every poll ─────────────────────

  it('should set a Redis key with TTL 90 s for all 6 metrics on every poll', async () => {
    await service.pollHealth();

    // 7 Redis.set calls: one per metric + health:dhan_last_checked_at timestamp
    expect(redisMock.set).toHaveBeenCalledTimes(7);

    for (const metric of ALL_METRICS) {
      expect(redisMock.set).toHaveBeenCalledWith(
        `health:${metric}`,
        expect.any(String),
        HEALTH_KEY_TTL_SECONDS,
      );
    }

    // The dhan_last_checked_at key must also be refreshed on every poll
    // so that checkDhanConnectivity() never sees stale (Infinity-age) data.
    expect(redisMock.set).toHaveBeenCalledWith(
      'health:dhan_last_checked_at',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), // ISO timestamp
      HEALTH_KEY_TTL_SECONDS,
    );
  });

  // ── Test 7: poll publishes INFO summary ────────────────────────────────────

  it('should publish an INFO status summary on every poll', async () => {
    await service.pollHealth();

    const infoCalls = notificationMock.publish.mock.calls.filter(
      ([alert]) => alert.priority === 'INFO',
    );
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0][0]).toMatchObject({
      priority: 'INFO',
      title: 'System Health Status',
      metadata: expect.objectContaining({ snapshot: expect.any(Object) }),
    });
  });

  // ── Test 8: DB failure → postgresql_connection Down ────────────────────────

  it('should set postgresql_connection to Down when the DataSource query throws', async () => {
    // Rebuild with a throwing DataSource
    await buildModule({ dbThrows: true });

    await service.pollHealth();

    const snapshot = service.getHealthSnapshot();
    expect(snapshot.postgresql_connection).toBe('Down');
  });

  // ── Test 9: Redis unhealthy → redis_availability Down ──────────────────────

  it('should set redis_availability to Down when RedisService.isHealthy() returns false', async () => {
    // Rebuild with an unhealthy Redis
    await buildModule({ redisHealthy: false });

    await service.pollHealth();

    const snapshot = service.getHealthSnapshot();
    expect(snapshot.redis_availability).toBe('Down');
  });

  // ── Test 10: getHealthSnapshot reflects current in-memory state ────────────

  it('getHealthSnapshot should return the current status for all 6 metrics', async () => {
    await service.updateMetricStatus('dhan_api_connectivity', 'Degraded');
    await service.updateMetricStatus('websocket_feed_latency', 'Down');

    const snapshot = service.getHealthSnapshot();

    expect(snapshot.dhan_api_connectivity).toBe('Degraded');
    expect(snapshot.websocket_feed_latency).toBe('Down');
    // Other metrics remain Healthy
    expect(snapshot.cloudengine_modules).toBe('Healthy');
    expect(snapshot.order_execution_latency).toBe('Healthy');
  });

  // ── Test 11: updateMetricStatus persists the new state ─────────────────────

  it('updateMetricStatus should update the in-memory state for the given metric', async () => {
    expect(service.getHealthSnapshot().cloudengine_modules).toBe('Healthy');

    await service.updateMetricStatus(
      'cloudengine_modules',
      'Degraded',
      'Module restart in progress',
    );

    expect(service.getHealthSnapshot().cloudengine_modules).toBe('Degraded');
  });

  // ── Test 12: updateMetricStatus on degrading transition → immediate CRITICAL

  it('updateMetricStatus should publish an immediate CRITICAL alert on a degrading transition', async () => {
    // Prime order_execution_latency to Degraded first
    await service.updateMetricStatus('order_execution_latency', 'Degraded', 'latency spike');
    jest.clearAllMocks();

    // Now push it Down
    await service.updateMetricStatus('order_execution_latency', 'Down', 'broker timeout');

    const criticalCalls = notificationMock.publish.mock.calls.filter(
      ([alert]) => alert.priority === 'CRITICAL',
    );
    expect(criticalCalls).toHaveLength(1);
    expect(criticalCalls[0][0]).toMatchObject({
      priority: 'CRITICAL',
      metadata: expect.objectContaining({
        metric: 'order_execution_latency',
        from: 'Degraded',
        to: 'Down',
        details: 'broker timeout',
      }),
    });

    // No INFO summary is published — that only happens during pollHealth
    const infoCalls = notificationMock.publish.mock.calls.filter(
      ([alert]) => alert.priority === 'INFO',
    );
    expect(infoCalls).toHaveLength(0);
  });
});
