/**
 * DailyLossStateMachineService — unit + property-based tests.
 *
 * Coverage:
 *   Unit tests:
 *     - 2nd losing trade triggers TWO_LOSS_LOCKOUT (Req 9.3)
 *     - 1st losing trade leaves state NORMAL
 *     - Daily loss limit triggers EMERGENCY_HALT (Req 9.4)
 *     - Kill switch transitions from any state (Req 9.8)
 *     - Daily reset returns TWO_LOSS_LOCKOUT / EMERGENCY_HALT → NORMAL
 *     - KILL_SWITCH_ACTIVE is NOT reset by daily cron
 *     - isNewEntryBlocked returns true for all three blocking states
 *     - isNewEntryBlocked returns false for NORMAL
 *     - RiskEvents record is persisted on every transition
 *     - NotificationService is called on every transition with correct priority
 *
 *   Property test:
 *     - Property 15: Two-Loss Daily Lockout State Machine (Req 9.3)
 *         After exactly 2 losing trades → TWO_LOSS_LOCKOUT
 *         After exactly 1 losing trade  → NORMAL
 *
 * Requirements: 9.3, 9.4, 9.8
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import fc from 'fast-check';

import { RiskEvents } from '../../database/entities/risk-events.entity';
import { NotificationService } from '../notification/notification.service';
import { DailyLossStateMachineService, DailyLossState } from './daily-loss-state-machine.service';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a stub TypeORM repository that captures saved entities. */
function buildMockRepo() {
  const saved: RiskEvents[] = [];
  return {
    create: jest.fn((data: Partial<RiskEvents>) => ({ ...data }) as RiskEvents),
    save: jest.fn(async (entity: RiskEvents) => {
      saved.push(entity);
      return entity;
    }),
    _saved: saved,
  };
}

/** Creates a stub NotificationService that records published alerts. */
function buildMockNotificationService() {
  const published: unknown[] = [];
  return {
    publish: jest.fn(async (alert: unknown) => {
      published.push(alert);
    }),
    _published: published,
  };
}

/** Creates a stub ConfigService with an optional daily loss limit override. */
function buildMockConfigService(dailyLossLimit?: number) {
  return {
    get: jest.fn(<T>(key: string): T | undefined => {
      if (key === 'DAILY_LOSS_LIMIT_RUPEES') {
        return (dailyLossLimit as unknown as T) ?? undefined;
      }
      return undefined;
    }),
  };
}

/** Assembles a test module and returns a ready-to-use service instance. */
async function buildService(opts: {
  dailyLossLimit?: number;
  mockRepo?: ReturnType<typeof buildMockRepo>;
  mockNotification?: ReturnType<typeof buildMockNotificationService>;
}): Promise<{
  service: DailyLossStateMachineService;
  repo: ReturnType<typeof buildMockRepo>;
  notification: ReturnType<typeof buildMockNotificationService>;
}> {
  const repo = opts.mockRepo ?? buildMockRepo();
  const notification = opts.mockNotification ?? buildMockNotificationService();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      DailyLossStateMachineService,
      { provide: getRepositoryToken(RiskEvents), useValue: repo },
      { provide: NotificationService, useValue: notification },
      {
        provide: ConfigService,
        useValue: buildMockConfigService(opts.dailyLossLimit),
      },
      // EventEmitter2 is required by DailyLossStateMachineService to broadcast
      // risk.state.changed events to LiveTradingService.
      {
        provide: EventEmitter2,
        useValue: { emit: jest.fn() },
      },
    ],
  }).compile();

  return {
    service: module.get<DailyLossStateMachineService>(DailyLossStateMachineService),
    repo,
    notification,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — initial state
// ─────────────────────────────────────────────────────────────────────────────

describe('DailyLossStateMachineService — initial state', () => {
  it('starts in NORMAL state for LIVE engine', async () => {
    const { service } = await buildService({});
    expect(service.getCurrentState('LIVE')).toBe('NORMAL');
  });

  it('starts in NORMAL state for PAPER engine', async () => {
    const { service } = await buildService({});
    expect(service.getCurrentState('PAPER')).toBe('NORMAL');
  });

  it('isNewEntryBlocked returns false for NORMAL state', async () => {
    const { service } = await buildService({});
    expect(service.isNewEntryBlocked('LIVE')).toBe(false);
    expect(service.isNewEntryBlocked('PAPER')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — onTradeClosed (TWO_LOSS_LOCKOUT, Req 9.3)
// ─────────────────────────────────────────────────────────────────────────────

describe('DailyLossStateMachineService — onTradeClosed', () => {
  it('stays NORMAL after 1 losing trade', async () => {
    const { service } = await buildService({});
    await service.onTradeClosed('LIVE', '-500.00');
    expect(service.getCurrentState('LIVE')).toBe('NORMAL');
  });

  it('transitions to TWO_LOSS_LOCKOUT after 2nd losing trade', async () => {
    const { service } = await buildService({});
    await service.onTradeClosed('LIVE', '-300.00');
    await service.onTradeClosed('LIVE', '-200.00');
    expect(service.getCurrentState('LIVE')).toBe('TWO_LOSS_LOCKOUT');
  });

  it('persists a RiskEvents row with event_type TWO_LOSS_LOCKOUT', async () => {
    const { service, repo } = await buildService({});
    await service.onTradeClosed('LIVE', '-100.00');
    await service.onTradeClosed('LIVE', '-100.00');

    expect(repo.save).toHaveBeenCalledTimes(1);
    const saved = repo._saved[0];
    expect(saved.event_type).toBe('TWO_LOSS_LOCKOUT');
    expect(saved.engine).toBe('LIVE');
  });

  it('publishes a WARNING notification on TWO_LOSS_LOCKOUT', async () => {
    const { service, notification } = await buildService({});
    await service.onTradeClosed('LIVE', '-100.00');
    await service.onTradeClosed('LIVE', '-100.00');

    expect(notification.publish).toHaveBeenCalledTimes(1);
    const alert = (notification._published as Array<{ priority: string }>)[0];
    expect(alert.priority).toBe('WARNING');
  });

  it('does not count winning trades', async () => {
    const { service } = await buildService({});
    await service.onTradeClosed('LIVE', '500.00');
    await service.onTradeClosed('LIVE', '300.00');
    expect(service.getCurrentState('LIVE')).toBe('NORMAL');
  });

  it('does not count break-even trades (net_pnl = 0)', async () => {
    const { service } = await buildService({});
    await service.onTradeClosed('LIVE', '0.00');
    await service.onTradeClosed('LIVE', '0');
    expect(service.getCurrentState('LIVE')).toBe('NORMAL');
  });

  it('does not double-transition: 3rd losing trade leaves state TWO_LOSS_LOCKOUT', async () => {
    const { service, repo } = await buildService({});
    await service.onTradeClosed('LIVE', '-100.00');
    await service.onTradeClosed('LIVE', '-100.00'); // triggers lockout
    await service.onTradeClosed('LIVE', '-100.00'); // no-op: already locked

    expect(service.getCurrentState('LIVE')).toBe('TWO_LOSS_LOCKOUT');
    // Only one RiskEvent should be saved (for the lockout transition).
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('LIVE and PAPER engines maintain independent counters', async () => {
    const { service } = await buildService({});
    await service.onTradeClosed('LIVE', '-100.00');
    await service.onTradeClosed('LIVE', '-100.00'); // LIVE → TWO_LOSS_LOCKOUT
    // PAPER still at NORMAL
    expect(service.getCurrentState('PAPER')).toBe('NORMAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — onIntradayLossUpdate (EMERGENCY_HALT, Req 9.4)
// ─────────────────────────────────────────────────────────────────────────────

describe('DailyLossStateMachineService — onIntradayLossUpdate', () => {
  it('stays NORMAL when loss is below the daily limit', async () => {
    const { service } = await buildService({ dailyLossLimit: 10_000 });
    await service.onIntradayLossUpdate('LIVE', 9_999);
    expect(service.getCurrentState('LIVE')).toBe('NORMAL');
  });

  it('transitions to EMERGENCY_HALT when loss equals the daily limit', async () => {
    const { service } = await buildService({ dailyLossLimit: 10_000 });
    await service.onIntradayLossUpdate('LIVE', 10_000);
    expect(service.getCurrentState('LIVE')).toBe('EMERGENCY_HALT');
  });

  it('transitions to EMERGENCY_HALT when loss exceeds the daily limit', async () => {
    const { service } = await buildService({ dailyLossLimit: 10_000 });
    await service.onIntradayLossUpdate('LIVE', 15_000);
    expect(service.getCurrentState('LIVE')).toBe('EMERGENCY_HALT');
  });

  it('uses default limit of 10000 when config key is absent', async () => {
    const { service } = await buildService({}); // no dailyLossLimit override → default 10000
    await service.onIntradayLossUpdate('LIVE', 10_000);
    expect(service.getCurrentState('LIVE')).toBe('EMERGENCY_HALT');
  });

  it('persists a RiskEvents row with event_type EMERGENCY_HALT', async () => {
    const { service, repo } = await buildService({ dailyLossLimit: 10_000 });
    await service.onIntradayLossUpdate('LIVE', 10_000);

    const saved = repo._saved[0];
    expect(saved.event_type).toBe('EMERGENCY_HALT');
    expect(saved.triggering_metric_name).toBe('intraday_net_loss_rupees');
  });

  it('publishes a CRITICAL notification on EMERGENCY_HALT', async () => {
    const { service, notification } = await buildService({ dailyLossLimit: 10_000 });
    await service.onIntradayLossUpdate('LIVE', 10_000);

    const alert = (notification._published as Array<{ priority: string }>)[0];
    expect(alert.priority).toBe('CRITICAL');
  });

  it('does not re-trigger when already in EMERGENCY_HALT', async () => {
    const { service, repo } = await buildService({ dailyLossLimit: 10_000 });
    await service.onIntradayLossUpdate('LIVE', 10_000); // triggers halt
    await service.onIntradayLossUpdate('LIVE', 12_000); // no-op

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(service.getCurrentState('LIVE')).toBe('EMERGENCY_HALT');
  });

  it('can transition from TWO_LOSS_LOCKOUT to EMERGENCY_HALT', async () => {
    const { service } = await buildService({ dailyLossLimit: 10_000 });
    // First trigger lockout
    await service.onTradeClosed('LIVE', '-100.00');
    await service.onTradeClosed('LIVE', '-100.00');
    expect(service.getCurrentState('LIVE')).toBe('TWO_LOSS_LOCKOUT');
    // Now cumulative unrealized loss hits the limit
    await service.onIntradayLossUpdate('LIVE', 10_000);
    expect(service.getCurrentState('LIVE')).toBe('EMERGENCY_HALT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — activateKillSwitch (KILL_SWITCH_ACTIVE, Req 9.8)
// ─────────────────────────────────────────────────────────────────────────────

describe('DailyLossStateMachineService — activateKillSwitch', () => {
  it('transitions from NORMAL to KILL_SWITCH_ACTIVE', async () => {
    const { service } = await buildService({});
    await service.activateKillSwitch('LIVE', 'UserKillSwitch');
    expect(service.getCurrentState('LIVE')).toBe('KILL_SWITCH_ACTIVE');
  });

  it('transitions from TWO_LOSS_LOCKOUT to KILL_SWITCH_ACTIVE', async () => {
    const { service } = await buildService({});
    await service.onTradeClosed('LIVE', '-100.00');
    await service.onTradeClosed('LIVE', '-100.00'); // → TWO_LOSS_LOCKOUT
    await service.activateKillSwitch('LIVE', 'UserKillSwitch');
    expect(service.getCurrentState('LIVE')).toBe('KILL_SWITCH_ACTIVE');
  });

  it('transitions from EMERGENCY_HALT to KILL_SWITCH_ACTIVE', async () => {
    const { service } = await buildService({ dailyLossLimit: 10_000 });
    await service.onIntradayLossUpdate('LIVE', 10_000); // → EMERGENCY_HALT
    await service.activateKillSwitch('LIVE', 'OperatorRequest');
    expect(service.getCurrentState('LIVE')).toBe('KILL_SWITCH_ACTIVE');
  });

  it('is idempotent: second kill switch activation stays KILL_SWITCH_ACTIVE', async () => {
    const { service, repo } = await buildService({});
    await service.activateKillSwitch('LIVE', 'UserKillSwitch');
    await service.activateKillSwitch('LIVE', 'UserKillSwitch'); // second activation
    expect(service.getCurrentState('LIVE')).toBe('KILL_SWITCH_ACTIVE');
    // Two RiskEvents should be persisted (one per activation call).
    expect(repo.save).toHaveBeenCalledTimes(2);
  });

  it('persists a RiskEvents row with event_type KILL_SWITCH', async () => {
    const { service, repo } = await buildService({});
    await service.activateKillSwitch('LIVE', 'UserKillSwitch');

    const saved = repo._saved[0];
    expect(saved.event_type).toBe('KILL_SWITCH');
    expect(saved.initiating_actor).toBe('UserKillSwitch');
  });

  it('publishes a MAX-priority notification on kill switch activation', async () => {
    const { service, notification } = await buildService({});
    await service.activateKillSwitch('LIVE', 'UserKillSwitch');

    const alert = (notification._published as Array<{ priority: string }>)[0];
    expect(alert.priority).toBe('MAX');
  });

  it('LIVE and PAPER kill switches are independent', async () => {
    const { service } = await buildService({});
    await service.activateKillSwitch('LIVE', 'UserKillSwitch');
    expect(service.getCurrentState('PAPER')).toBe('NORMAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — resetDailyState
// ─────────────────────────────────────────────────────────────────────────────

describe('DailyLossStateMachineService — resetDailyState', () => {
  it('resets TWO_LOSS_LOCKOUT to NORMAL for LIVE', async () => {
    const { service } = await buildService({});
    await service.onTradeClosed('LIVE', '-100.00');
    await service.onTradeClosed('LIVE', '-100.00'); // → TWO_LOSS_LOCKOUT
    await service.resetDailyState();
    expect(service.getCurrentState('LIVE')).toBe('NORMAL');
  });

  it('resets EMERGENCY_HALT to NORMAL for LIVE', async () => {
    const { service } = await buildService({ dailyLossLimit: 10_000 });
    await service.onIntradayLossUpdate('LIVE', 10_000); // → EMERGENCY_HALT
    await service.resetDailyState();
    expect(service.getCurrentState('LIVE')).toBe('NORMAL');
  });

  it('resets TWO_LOSS_LOCKOUT to NORMAL for PAPER', async () => {
    const { service } = await buildService({});
    await service.onTradeClosed('PAPER', '-100.00');
    await service.onTradeClosed('PAPER', '-100.00');
    await service.resetDailyState();
    expect(service.getCurrentState('PAPER')).toBe('NORMAL');
  });

  it('does NOT reset KILL_SWITCH_ACTIVE', async () => {
    const { service } = await buildService({});
    await service.activateKillSwitch('LIVE', 'UserKillSwitch');
    await service.resetDailyState();
    expect(service.getCurrentState('LIVE')).toBe('KILL_SWITCH_ACTIVE');
  });

  it('after reset, a fresh 2nd losing trade triggers TWO_LOSS_LOCKOUT again', async () => {
    const { service } = await buildService({});
    // Day 1: two losses → lockout
    await service.onTradeClosed('LIVE', '-100.00');
    await service.onTradeClosed('LIVE', '-100.00');
    expect(service.getCurrentState('LIVE')).toBe('TWO_LOSS_LOCKOUT');

    // Midnight reset
    await service.resetDailyState();
    expect(service.getCurrentState('LIVE')).toBe('NORMAL');

    // Day 2: two losses → lockout again
    await service.onTradeClosed('LIVE', '-50.00');
    await service.onTradeClosed('LIVE', '-50.00');
    expect(service.getCurrentState('LIVE')).toBe('TWO_LOSS_LOCKOUT');
  });

  it('NORMAL state is untouched by reset', async () => {
    const { service } = await buildService({});
    await service.resetDailyState();
    expect(service.getCurrentState('LIVE')).toBe('NORMAL');
    expect(service.getCurrentState('PAPER')).toBe('NORMAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — isNewEntryBlocked
// ─────────────────────────────────────────────────────────────────────────────

describe('DailyLossStateMachineService — isNewEntryBlocked', () => {
  it('returns false for NORMAL', async () => {
    const { service } = await buildService({});
    expect(service.isNewEntryBlocked('LIVE')).toBe(false);
  });

  it('returns true for TWO_LOSS_LOCKOUT', async () => {
    const { service } = await buildService({});
    await service.onTradeClosed('LIVE', '-100.00');
    await service.onTradeClosed('LIVE', '-100.00');
    expect(service.isNewEntryBlocked('LIVE')).toBe(true);
  });

  it('returns true for EMERGENCY_HALT', async () => {
    const { service } = await buildService({ dailyLossLimit: 10_000 });
    await service.onIntradayLossUpdate('LIVE', 10_000);
    expect(service.isNewEntryBlocked('LIVE')).toBe(true);
  });

  it('returns true for KILL_SWITCH_ACTIVE', async () => {
    const { service } = await buildService({});
    await service.activateKillSwitch('LIVE', 'UserKillSwitch');
    expect(service.isNewEntryBlocked('LIVE')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 15: Two-Loss Daily Lockout State Machine
// ─────────────────────────────────────────────────name──────────────────────────
// **Validates: Requirements 9.3**
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 15: Two-Loss Daily Lockout State Machine', () => {
  /**
   * Builds a fresh service instance for each property run with lightweight
   * no-op mocks so the state-machine logic can run without I/O.
   */
  async function freshService(): Promise<DailyLossStateMachineService> {
    const { service } = await buildService({});
    return service;
  }

  it('Property 15a: after exactly 2 losing trades the state is TWO_LOSS_LOCKOUT', async () => {
    // **Validates: Requirements 9.3**
    //
    // For any pair of negative net P&L strings applied to a fresh NORMAL
    // state, the state machine MUST be in TWO_LOSS_LOCKOUT (and must NOT
    // be NORMAL, EMERGENCY_HALT, or KILL_SWITCH_ACTIVE).
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }).map((v) => `-${v}.00`), // loss 1
        fc.integer({ min: 1, max: 1_000_000 }).map((v) => `-${v}.00`), // loss 2
        async (loss1, loss2) => {
          const service = await freshService();
          await service.onTradeClosed('LIVE', loss1);
          await service.onTradeClosed('LIVE', loss2);

          expect(service.getCurrentState('LIVE')).toBe<DailyLossState>('TWO_LOSS_LOCKOUT');
          expect(service.isNewEntryBlocked('LIVE')).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('Property 15b: after exactly 1 losing trade the state is still NORMAL', async () => {
    // **Validates: Requirements 9.3**
    //
    // A single losing trade is insufficient to trigger the lockout.  For any
    // negative net P&L string applied to a fresh NORMAL state, the engine MUST
    // remain in NORMAL (new entries are still permitted).
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }).map((v) => `-${v}.00`), // loss 1
        async (loss1) => {
          const service = await freshService();
          await service.onTradeClosed('LIVE', loss1);

          expect(service.getCurrentState('LIVE')).toBe<DailyLossState>('NORMAL');
          expect(service.isNewEntryBlocked('LIVE')).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('Property 15c: any number of winning trades never triggers TWO_LOSS_LOCKOUT', async () => {
    // **Validates: Requirements 9.3**
    //
    // Positive (or zero) net P&L trades MUST NOT increment the losing-trade
    // counter.  For any sequence of up to 10 winning trades, the state
    // MUST remain NORMAL.
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.integer({ min: 0, max: 1_000_000 }).map((v) => `${v}.00`),
          { minLength: 2, maxLength: 10 },
        ),
        async (winningPnls) => {
          const service = await freshService();
          for (const pnl of winningPnls) {
            await service.onTradeClosed('LIVE', pnl);
          }
          expect(service.getCurrentState('LIVE')).toBe<DailyLossState>('NORMAL');
        },
      ),
      { numRuns: 300 },
    );
  });
});
