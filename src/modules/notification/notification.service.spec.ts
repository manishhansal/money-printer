/**
 * notification.service.spec.ts
 *
 * Unit tests for NotificationService covering:
 *  - Priority queue ordering (MAX > CRITICAL > WARNING > INFO)
 *  - Acknowledgment tracking (MAX-priority only, idempotent, Redis persisted)
 *  - Redis buffering when no clients are connected
 *  - Retry mechanism (up to MAX_DELIVERY_RETRIES before buffering)
 *  - flushBuffer ordering (MAX → CRITICAL → WARNING → INFO)
 *  - getPendingAlerts filtering by priority
 *
 * Requirements: 12.7, 12.8, 20.9
 */

import { Test, TestingModule } from '@nestjs/testing';
import { v4 as uuidv4 } from 'uuid';
import { NotificationService } from './notification.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  AlertPriority,
  NotificationAlert,
  PRIORITY_ORDER,
  MAX_DELIVERY_RETRIES,
  ACK_TTL_SECONDS,
  redisAckKey,
  redisBufferKey,
} from './notification.types';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeAlert(
  priority: AlertPriority,
  overrides: Partial<NotificationAlert> = {},
): NotificationAlert {
  return {
    id: uuidv4(),
    priority,
    title: `${priority} test alert`,
    message: `Test message for priority ${priority}`,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Minimal Redis mock with only the operations used by NotificationService */
function createRedisMock() {
  return {
    rpush: jest.fn().mockResolvedValue(1),
    lrange: jest.fn<Promise<string[]>, [string, number, number]>().mockResolvedValue([]),
    lrem: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('NotificationService', () => {
  let service: NotificationService;
  let redis: ReturnType<typeof createRedisMock>;

  beforeEach(async () => {
    redis = createRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationService, { provide: REDIS_CLIENT, useValue: redis }],
    }).compile();

    service = module.get<NotificationService>(NotificationService);

    // Suppress sleep() delays in every test by default
    jest
      .spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Priority queue ordering
  // ───────────────────────────────────────────────────────────────────────────

  describe('priority queue ordering', () => {
    it('MAX alert sits at the head of the queue when mixed alerts are enqueued', async () => {
      // Register a delivery fn that never delivers so items stay in the queue
      service.registerDelivery(
        () => false,
        () => false,
      );

      const t0 = new Date('2024-01-01T09:00:00.000Z');
      const info = makeAlert('INFO', { createdAt: new Date(t0.getTime()) });
      const max = makeAlert('MAX', { createdAt: new Date(t0.getTime() + 3) });

      // Publish in reverse priority order to prove sorting is not insertion-order
      // Note: publish is async; each call enqueues before starting async delivery.
      // We capture the queue state right after enqueueing (before async retries complete).
      const enqueueAndPeek = async (a: NotificationAlert) => {
        const publishPromise = service.publish(a);
        // Snapshot queue immediately after sync enqueue, before async retry loop
        const snapshot = service.getQueueSnapshot();
        await publishPromise;
        return snapshot;
      };

      // Enqueue INFO first → queue = [INFO]
      const q1 = await enqueueAndPeek(info);
      expect(q1[0]?.alert.priority).toBe('INFO');

      // Enqueue MAX → queue head should be MAX
      const q2 = await enqueueAndPeek(max);
      // After async delivery loop, max might be buffered; check initial snapshot
      // The first snapshot captured immediately after enqueue
      expect(q2[0]?.alert.priority).toBe('MAX');
    });

    it('flushBuffer processes alerts in MAX → CRITICAL → WARNING → INFO order', async () => {
      const deliveredPriorities: AlertPriority[] = [];

      service.registerDelivery(
        (alert) => {
          deliveredPriorities.push(alert.priority);
          return true;
        },
        () => true,
      );

      // Seed Redis buffer with one alert per priority
      redis.lrange.mockImplementation((key: string) => {
        for (const p of PRIORITY_ORDER) {
          if (key === redisBufferKey(p)) {
            return Promise.resolve([JSON.stringify(makeAlert(p))]);
          }
        }
        return Promise.resolve([]);
      });

      await service.flushBuffer();

      // Verify strict ordering: MAX at 0, CRITICAL at 1, WARNING at 2, INFO at 3
      expect(deliveredPriorities[0]).toBe('MAX');
      expect(deliveredPriorities[1]).toBe('CRITICAL');
      expect(deliveredPriorities[2]).toBe('WARNING');
      expect(deliveredPriorities[3]).toBe('INFO');
    });

    it('buffers to Redis keys in the correct priority namespace', async () => {
      service.registerDelivery(
        () => false,
        () => false,
      );

      const alert = makeAlert('CRITICAL');
      await service.publish(alert);

      expect(redis.rpush).toHaveBeenCalledWith(
        'notifications:pending:CRITICAL',
        expect.stringContaining(alert.id),
      );
    });

    it('PRIORITY_ORDER array is [MAX, CRITICAL, WARNING, INFO]', () => {
      expect(PRIORITY_ORDER).toEqual(['MAX', 'CRITICAL', 'WARNING', 'INFO']);
    });

    it('delivers MAX before CRITICAL when both are buffered and a client reconnects', async () => {
      const deliveredOrder: AlertPriority[] = [];

      service.registerDelivery(
        (alert) => {
          deliveredOrder.push(alert.priority);
          return true;
        },
        () => true,
      );

      const maxAlert = makeAlert('MAX');
      const critAlert = makeAlert('CRITICAL');

      redis.lrange.mockImplementation((key: string) => {
        if (key === 'notifications:pending:MAX') return Promise.resolve([JSON.stringify(maxAlert)]);
        if (key === 'notifications:pending:CRITICAL')
          return Promise.resolve([JSON.stringify(critAlert)]);
        return Promise.resolve([]);
      });

      await service.flushBuffer();

      expect(deliveredOrder.indexOf('MAX')).toBeLessThan(deliveredOrder.indexOf('CRITICAL'));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Acknowledgment tracking
  // ───────────────────────────────────────────────────────────────────────────

  describe('acknowledgment tracking', () => {
    it('registers MAX alert as unacknowledged immediately after publish', async () => {
      service.registerDelivery(
        () => true,
        () => true,
      );

      const alert = makeAlert('MAX');
      await service.publish(alert);

      const state = service.getMaxAlertAckState(alert.id);
      expect(state).toBeDefined();
      expect(state!.acknowledged).toBe(false);
    });

    it('marks MAX alert as acknowledged after acknowledge() call', async () => {
      service.registerDelivery(
        () => true,
        () => true,
      );

      const alert = makeAlert('MAX');
      await service.publish(alert);
      await service.acknowledge(alert.id);

      const state = service.getMaxAlertAckState(alert.id);
      expect(state!.acknowledged).toBe(true);
      expect(state!.acknowledgedAt).toBeInstanceOf(Date);
    });

    it('persists acknowledgment to Redis with correct key and TTL', async () => {
      service.registerDelivery(
        () => true,
        () => true,
      );

      const alert = makeAlert('MAX');
      await service.publish(alert);
      await service.acknowledge(alert.id);

      expect(redis.set).toHaveBeenCalledWith(
        redisAckKey(alert.id),
        expect.stringContaining('"acknowledged":true'),
        'EX',
        ACK_TTL_SECONDS,
      );
    });

    it('does NOT track acknowledgment state for CRITICAL, WARNING, or INFO alerts', async () => {
      service.registerDelivery(
        () => true,
        () => true,
      );

      for (const priority of ['CRITICAL', 'WARNING', 'INFO'] as AlertPriority[]) {
        const alert = makeAlert(priority);
        await service.publish(alert);
        expect(service.getMaxAlertAckState(alert.id)).toBeUndefined();
      }
    });

    it('ignores duplicate acknowledgment — second ACK is a no-op', async () => {
      service.registerDelivery(
        () => true,
        () => true,
      );

      const alert = makeAlert('MAX');
      await service.publish(alert);
      await service.acknowledge(alert.id);

      const firstAckTime = service.getMaxAlertAckState(alert.id)!.acknowledgedAt;

      // Second ACK — must not update acknowledgedAt or write to Redis again
      await service.acknowledge(alert.id);

      const secondAckTime = service.getMaxAlertAckState(alert.id)!.acknowledgedAt;
      expect(secondAckTime).toEqual(firstAckTime);

      // Redis set must only have been called once for this alert's ACK key
      const ackSetCalls = (redis.set as jest.Mock).mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes(alert.id),
      );
      expect(ackSetCalls).toHaveLength(1);
    });

    it('logs a warning when acknowledging an unknown alert id', async () => {
      const warnSpy = jest
        .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);

      await service.acknowledge('unknown-alert-id');

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown or non-MAX'));
    });

    it('multiple distinct MAX alerts each have independent ACK state', async () => {
      service.registerDelivery(
        () => true,
        () => true,
      );

      const alert1 = makeAlert('MAX');
      const alert2 = makeAlert('MAX');

      await service.publish(alert1);
      await service.publish(alert2);

      await service.acknowledge(alert1.id);

      expect(service.getMaxAlertAckState(alert1.id)!.acknowledged).toBe(true);
      expect(service.getMaxAlertAckState(alert2.id)!.acknowledged).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Redis buffering
  // ───────────────────────────────────────────────────────────────────────────

  describe('Redis buffering', () => {
    it('buffers alert to Redis when no clients are connected', async () => {
      service.registerDelivery(
        () => false,
        () => false,
      );

      const alert = makeAlert('WARNING');
      await service.publish(alert);

      expect(redis.rpush).toHaveBeenCalledWith(
        'notifications:pending:WARNING',
        expect.stringContaining(alert.id),
      );
    });

    it('uses the correct Redis key for each priority level', async () => {
      service.registerDelivery(
        () => false,
        () => false,
      );

      for (const priority of PRIORITY_ORDER) {
        redis.rpush.mockClear();
        const alert = makeAlert(priority);
        await service.publish(alert);

        expect(redis.rpush).toHaveBeenCalledWith(
          `notifications:pending:${priority}`,
          expect.any(String),
        );
      }
    });

    it('does NOT buffer when delivery succeeds on first attempt', async () => {
      service.registerDelivery(
        () => true,
        () => true,
      );

      const alert = makeAlert('INFO');
      await service.publish(alert);

      expect(redis.rpush).not.toHaveBeenCalled();
    });

    it('getPendingAlerts returns all priorities in MAX → CRITICAL → WARNING → INFO order', async () => {
      const maxAlert = makeAlert('MAX');
      const infoAlert = makeAlert('INFO');

      redis.lrange.mockImplementation((key: string) => {
        if (key === 'notifications:pending:MAX') return Promise.resolve([JSON.stringify(maxAlert)]);
        if (key === 'notifications:pending:INFO')
          return Promise.resolve([JSON.stringify(infoAlert)]);
        return Promise.resolve([]);
      });

      const pending = await service.getPendingAlerts();

      expect(pending).toHaveLength(2);
      expect(pending[0].priority).toBe('MAX');
      expect(pending[1].priority).toBe('INFO');
    });

    it('getPendingAlerts with priority filter only queries that priority', async () => {
      const critAlert = makeAlert('CRITICAL');
      redis.lrange.mockImplementation((key: string) => {
        if (key === 'notifications:pending:CRITICAL')
          return Promise.resolve([JSON.stringify(critAlert)]);
        return Promise.resolve([]);
      });

      const pending = await service.getPendingAlerts('CRITICAL');

      expect(pending).toHaveLength(1);
      expect(pending[0].priority).toBe('CRITICAL');
      // Must only query the one priority key
      expect(redis.lrange).toHaveBeenCalledTimes(1);
      expect(redis.lrange).toHaveBeenCalledWith('notifications:pending:CRITICAL', 0, -1);
    });

    it('getPendingAlerts rehydrates createdAt as a Date instance', async () => {
      const alert = makeAlert('MAX', { createdAt: new Date('2024-06-01T12:00:00Z') });
      redis.lrange.mockResolvedValueOnce([JSON.stringify(alert)]);
      redis.lrange.mockResolvedValue([]);

      const [result] = await service.getPendingAlerts('MAX');
      expect(result.createdAt).toBeInstanceOf(Date);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Retry mechanism
  // ───────────────────────────────────────────────────────────────────────────

  describe('retry mechanism', () => {
    it(`retries delivery exactly ${MAX_DELIVERY_RETRIES} times before buffering to Redis`, async () => {
      let callCount = 0;
      service.registerDelivery(
        () => {
          callCount++;
          return false;
        },
        () => true,
      );

      const alert = makeAlert('CRITICAL');
      await service.publish(alert);

      expect(callCount).toBe(MAX_DELIVERY_RETRIES);
      expect(redis.rpush).toHaveBeenCalledWith(
        'notifications:pending:CRITICAL',
        expect.stringContaining(alert.id),
      );
    });

    it('stops retrying as soon as delivery succeeds', async () => {
      let callCount = 0;
      service.registerDelivery(
        () => {
          callCount++;
          // Fail on first attempt, succeed on second
          return callCount >= 2;
        },
        () => true,
      );

      const alert = makeAlert('WARNING');
      await service.publish(alert);

      expect(callCount).toBe(2);
      // Should NOT have buffered since delivery succeeded
      expect(redis.rpush).not.toHaveBeenCalled();
    });

    it('delivers successfully on the first attempt without retrying', async () => {
      let callCount = 0;
      service.registerDelivery(
        () => {
          callCount++;
          return true;
        },
        () => true,
      );

      const alert = makeAlert('INFO');
      await service.publish(alert);

      expect(callCount).toBe(1);
      expect(redis.rpush).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // flushBuffer behaviour
  // ───────────────────────────────────────────────────────────────────────────

  describe('flushBuffer', () => {
    it('does nothing when no clients are connected', async () => {
      service.registerDelivery(
        () => true,
        () => false,
      );

      await service.flushBuffer();

      // lrange should not have been called
      expect(redis.lrange).not.toHaveBeenCalled();
    });

    it('removes successfully delivered items from Redis list with lrem', async () => {
      const maxAlert = makeAlert('MAX');
      const maxJson = JSON.stringify(maxAlert);

      service.registerDelivery(
        () => true,
        () => true,
      );

      redis.lrange.mockImplementation((key: string) => {
        if (key === 'notifications:pending:MAX') return Promise.resolve([maxJson]);
        return Promise.resolve([]);
      });

      await service.flushBuffer();

      expect(redis.lrem).toHaveBeenCalledWith('notifications:pending:MAX', 1, maxJson);
    });

    it('does not call lrem when delivery fails', async () => {
      const alert = makeAlert('INFO');

      service.registerDelivery(
        () => false,
        () => true,
      );

      redis.lrange.mockImplementation((key: string) => {
        if (key === 'notifications:pending:INFO') return Promise.resolve([JSON.stringify(alert)]);
        return Promise.resolve([]);
      });

      await service.flushBuffer();

      expect(redis.lrem).not.toHaveBeenCalled();
    });

    it('prevents concurrent flush operations', async () => {
      let lrangeCalls = 0;
      service.registerDelivery(
        () => true,
        () => true,
      );

      redis.lrange.mockImplementation(async () => {
        lrangeCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return [];
      });

      // Launch two concurrent flushes — only one should run
      await Promise.all([service.flushBuffer(), service.flushBuffer()]);

      // Should have been called exactly once per priority (4 priorities)
      // because the second flush is coalesced
      expect(lrangeCalls).toBe(PRIORITY_ORDER.length);
    });
  });
});
