/**
 * position-monitoring.service.spec.ts
 *
 * Unit tests for PositionMonitoringService.
 *
 * Coverage (12 tests):
 *   1.  LONG: MFE increases when price moves above entry
 *   2.  LONG: MAE decreases when price moves below entry
 *   3.  SHORT: MFE increases when price moves below entry (favourable direction)
 *   4.  LONG: SL hit (currentPrice ≤ currentSl) → emits POSITION_EXIT_EVENT with SL_HIT
 *   5.  LONG: target hit (currentPrice ≥ targetPrice) → emits POSITION_EXIT_EVENT with TARGET_HIT
 *   6.  SHORT: SL hit (currentPrice ≥ currentSl) → emits POSITION_EXIT_EVENT with SL_HIT
 *   7.  SHORT: target hit (currentPrice ≤ targetPrice) → emits POSITION_EXIT_EVENT with TARGET_HIT
 *   8.  No exit events when price is between SL and target
 *   9.  UNREALIZED_PNL_UPDATED_EVENT emitted after each tick
 *  10.  No events emitted when no open positions exist for the instrument
 *  11.  addPosition adds to tracking; removePosition removes from tracking
 *  12.  Multiple positions on the same instrument are all processed per tick
 *
 * All tests use in-memory stubs — no real database or Redis connection is needed.
 *
 * Requirements: 7.4, 9.4, 12.2
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Position } from '../../database/entities/positions.entity';
import { RedisService } from '../redis/redis.service';
import { PositionMonitoringService } from './position-monitoring.service';
import {
  POSITION_EXIT_EVENT,
  UNREALIZED_PNL_UPDATED_EVENT,
  PositionExitReason,
  PositionExitSignal,
} from './position-monitoring.types';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constructs a minimal Position-like object with sensible defaults.
 * Any field can be overridden via the `overrides` parameter.
 */
function buildMockPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    engine: 'LIVE',
    instrument_id: 'inst-1',
    signal_id: null,
    direction: 'LONG',
    quantity: 10,
    average_entry_price: '100.00',
    current_sl: '90.00',
    target_price: '115.00',
    trailing_stop_mechanism: null,
    unrealized_pnl: '0',
    mfe: '0',
    mae: '0',
    is_open: true,
    opened_at: new Date(),
    closed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    trades: [],
    ...overrides,
  } as Position;
}

/**
 * Builds a test module with fully mocked dependencies.
 *
 * positionsRepo.find   — controls what DB records are returned for `processTick`.
 * positionsRepo.findOne — controls what DB record is returned for `addPosition`.
 * redisService.subscribe — no-op stub so onModuleInit / subscribeToInstrumentTicks
 *                          complete without an actual Redis connection.
 * eventEmitter.emit    — jest spy so tests can assert on published events.
 */
async function buildService(): Promise<{
  service: PositionMonitoringService;
  positionsRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
  };
  redisService: { subscribe: jest.Mock };
  eventEmitter: { emit: jest.Mock };
}> {
  const positionsRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const redisService = {
    subscribe: jest.fn().mockResolvedValue(undefined),
  };

  const eventEmitter = {
    emit: jest.fn(),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PositionMonitoringService,
      { provide: getRepositoryToken(Position), useValue: positionsRepo },
      { provide: RedisService, useValue: redisService },
      { provide: EventEmitter2, useValue: eventEmitter },
    ],
  }).compile();

  const service = module.get<PositionMonitoringService>(PositionMonitoringService);

  return { service, positionsRepo, redisService, eventEmitter };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LONG: MFE increases when price moves above entry
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — LONG MFE tracking', () => {
  it('MFE reflects the highest unrealized P&L and does not decrease on a later lower tick', async () => {
    // Arrange: LONG position, entry=100, qty=10, initial mfe=0
    const { service, positionsRepo } = await buildService();
    const position = buildMockPosition({
      direction: 'LONG',
      average_entry_price: '100.00',
      quantity: 10,
      mfe: '0',
      current_sl: null,
      target_price: null,
    });
    positionsRepo.find.mockResolvedValue([position]);

    // Act: first tick at 110 → unrealizedPnl = (110-100)*10 = 100
    await service.processTick('inst-1', 110);
    // Second tick at 105 → unrealizedPnl = (105-100)*10 = 50 (lower than 100)
    await service.processTick('inst-1', 105);

    // Assert: MFE should still be 100, not reduced to 50
    const stats = service.getPositionStats(position.id);
    expect(stats).not.toBeNull();
    expect(stats!.mfe).toBe(100);
    expect(stats!.unrealizedPnl).toBe(50); // current P&L is updated to latest
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LONG: MAE decreases when price moves below entry
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — LONG MAE tracking', () => {
  it('MAE reflects the most negative unrealized P&L and does not increase on a later less-negative tick', async () => {
    // Arrange: LONG position, entry=100, qty=10, initial mae=0
    const { service, positionsRepo } = await buildService();
    const position = buildMockPosition({
      direction: 'LONG',
      average_entry_price: '100.00',
      quantity: 10,
      mae: '0',
      current_sl: null,
      target_price: null,
    });
    positionsRepo.find.mockResolvedValue([position]);

    // Act: first tick at 90 → unrealizedPnl = (90-100)*10 = -100
    await service.processTick('inst-1', 90);
    // Second tick at 95 → unrealizedPnl = (95-100)*10 = -50 (less negative)
    await service.processTick('inst-1', 95);

    // Assert: MAE should still be -100, not bumped up to -50
    const stats = service.getPositionStats(position.id);
    expect(stats).not.toBeNull();
    expect(stats!.mae).toBe(-100);
    expect(stats!.unrealizedPnl).toBe(-50); // current P&L is updated to latest
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SHORT: MFE increases when price moves below entry (favourable for SHORT)
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — SHORT MFE tracking', () => {
  it('MFE reflects the highest favourable SHORT unrealized P&L and does not decrease', async () => {
    // Arrange: SHORT position, entry=100, qty=10, initial mfe=0
    const { service, positionsRepo } = await buildService();
    const position = buildMockPosition({
      direction: 'SHORT',
      average_entry_price: '100.00',
      quantity: 10,
      mfe: '0',
      current_sl: null,
      target_price: null,
    });
    positionsRepo.find.mockResolvedValue([position]);

    // Act: first tick at 85 → unrealizedPnl = (100-85)*10 = 150
    await service.processTick('inst-1', 85);
    // Second tick at 90 → unrealizedPnl = (100-90)*10 = 100 (lower than 150)
    await service.processTick('inst-1', 90);

    // Assert: MFE should still be 150, not reduced to 100
    const stats = service.getPositionStats(position.id);
    expect(stats).not.toBeNull();
    expect(stats!.mfe).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. LONG: SL hit (currentPrice ≤ currentSl) → emits POSITION_EXIT_EVENT SL_HIT
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — LONG SL hit', () => {
  it('emits POSITION_EXIT_EVENT with SL_HIT when currentPrice equals currentSl for a LONG', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();
    const position = buildMockPosition({
      direction: 'LONG',
      average_entry_price: '100.00',
      current_sl: '90.00',
      target_price: '120.00',
      quantity: 5,
    });
    positionsRepo.find.mockResolvedValue([position]);

    // currentPrice exactly equals SL → should trigger SL_HIT
    await service.processTick('inst-1', 90);

    const exitCalls = (eventEmitter.emit as jest.Mock).mock.calls.filter(
      ([event]) => event === POSITION_EXIT_EVENT,
    );
    expect(exitCalls).toHaveLength(1);

    const payload = exitCalls[0][1] as PositionExitSignal;
    expect(payload.positionId).toBe(position.id);
    expect(payload.reason).toBe(PositionExitReason.SL_HIT);
    expect(payload.currentPrice).toBe(90);
  });

  it('emits POSITION_EXIT_EVENT with SL_HIT when currentPrice is below currentSl for a LONG', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();
    const position = buildMockPosition({
      direction: 'LONG',
      average_entry_price: '100.00',
      current_sl: '90.00',
      target_price: null,
      quantity: 5,
    });
    positionsRepo.find.mockResolvedValue([position]);

    await service.processTick('inst-1', 85); // below SL

    const exitCalls = (eventEmitter.emit as jest.Mock).mock.calls.filter(
      ([event]) => event === POSITION_EXIT_EVENT,
    );
    expect(exitCalls).toHaveLength(1);
    expect((exitCalls[0][1] as PositionExitSignal).reason).toBe(PositionExitReason.SL_HIT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. LONG: target hit (currentPrice ≥ targetPrice) → emits TARGET_HIT
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — LONG target hit', () => {
  it('emits POSITION_EXIT_EVENT with TARGET_HIT when currentPrice equals targetPrice for a LONG', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();
    const position = buildMockPosition({
      direction: 'LONG',
      average_entry_price: '100.00',
      current_sl: '90.00',
      target_price: '115.00',
      quantity: 5,
    });
    positionsRepo.find.mockResolvedValue([position]);

    await service.processTick('inst-1', 115); // exactly at target

    const exitCalls = (eventEmitter.emit as jest.Mock).mock.calls.filter(
      ([event]) => event === POSITION_EXIT_EVENT,
    );
    expect(exitCalls).toHaveLength(1);

    const payload = exitCalls[0][1] as PositionExitSignal;
    expect(payload.reason).toBe(PositionExitReason.TARGET_HIT);
    expect(payload.currentPrice).toBe(115);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. SHORT: SL hit (currentPrice ≥ currentSl) → emits SL_HIT
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — SHORT SL hit', () => {
  it('emits POSITION_EXIT_EVENT with SL_HIT when currentPrice equals currentSl for a SHORT', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();
    const position = buildMockPosition({
      direction: 'SHORT',
      average_entry_price: '100.00',
      current_sl: '110.00', // SL is above entry for SHORT
      target_price: '80.00',
      quantity: 5,
    });
    positionsRepo.find.mockResolvedValue([position]);

    await service.processTick('inst-1', 110); // exactly at SL

    const exitCalls = (eventEmitter.emit as jest.Mock).mock.calls.filter(
      ([event]) => event === POSITION_EXIT_EVENT,
    );
    expect(exitCalls).toHaveLength(1);
    expect((exitCalls[0][1] as PositionExitSignal).reason).toBe(PositionExitReason.SL_HIT);
  });

  it('emits POSITION_EXIT_EVENT with SL_HIT when currentPrice is above currentSl for a SHORT', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();
    const position = buildMockPosition({
      direction: 'SHORT',
      average_entry_price: '100.00',
      current_sl: '110.00',
      target_price: null,
      quantity: 5,
    });
    positionsRepo.find.mockResolvedValue([position]);

    await service.processTick('inst-1', 115); // above SL

    const exitCalls = (eventEmitter.emit as jest.Mock).mock.calls.filter(
      ([event]) => event === POSITION_EXIT_EVENT,
    );
    expect(exitCalls).toHaveLength(1);
    expect((exitCalls[0][1] as PositionExitSignal).reason).toBe(PositionExitReason.SL_HIT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. SHORT: target hit (currentPrice ≤ targetPrice) → emits TARGET_HIT
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — SHORT target hit', () => {
  it('emits POSITION_EXIT_EVENT with TARGET_HIT when currentPrice equals targetPrice for a SHORT', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();
    const position = buildMockPosition({
      direction: 'SHORT',
      average_entry_price: '100.00',
      current_sl: '110.00',
      target_price: '80.00',
      quantity: 5,
    });
    positionsRepo.find.mockResolvedValue([position]);

    await service.processTick('inst-1', 80); // exactly at target

    const exitCalls = (eventEmitter.emit as jest.Mock).mock.calls.filter(
      ([event]) => event === POSITION_EXIT_EVENT,
    );
    expect(exitCalls).toHaveLength(1);

    const payload = exitCalls[0][1] as PositionExitSignal;
    expect(payload.reason).toBe(PositionExitReason.TARGET_HIT);
    expect(payload.currentPrice).toBe(80);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. No exit events when price is between SL and target
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — no exit when price is safe', () => {
  it('does not emit POSITION_EXIT_EVENT when price is between SL and target; still emits UNREALIZED_PNL_UPDATED_EVENT', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();
    const position = buildMockPosition({
      direction: 'LONG',
      average_entry_price: '100.00',
      current_sl: '90.00',
      target_price: '115.00',
      quantity: 10,
    });
    positionsRepo.find.mockResolvedValue([position]);

    // Price is comfortably between SL (90) and target (115) → no exit
    await service.processTick('inst-1', 105);

    const allEmitCalls = (eventEmitter.emit as jest.Mock).mock.calls;

    // No POSITION_EXIT_EVENT
    const exitCalls = allEmitCalls.filter(([event]) => event === POSITION_EXIT_EVENT);
    expect(exitCalls).toHaveLength(0);

    // UNREALIZED_PNL_UPDATED_EVENT must still be emitted
    const pnlCalls = allEmitCalls.filter(([event]) => event === UNREALIZED_PNL_UPDATED_EVENT);
    expect(pnlCalls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. UNREALIZED_PNL_UPDATED_EVENT emitted after each tick
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — UNREALIZED_PNL_UPDATED_EVENT', () => {
  it('emits UNREALIZED_PNL_UPDATED_EVENT with the correct aggregate unrealized P&L after each tick', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();

    // LONG: entry=100, qty=5; at price 110 → unrealizedPnl = (110-100)*5 = 50
    const position = buildMockPosition({
      direction: 'LONG',
      average_entry_price: '100.00',
      quantity: 5,
      current_sl: null,
      target_price: null,
    });
    positionsRepo.find.mockResolvedValue([position]);

    await service.processTick('inst-1', 110);

    const pnlCalls = (eventEmitter.emit as jest.Mock).mock.calls.filter(
      ([event]) => event === UNREALIZED_PNL_UPDATED_EVENT,
    );
    expect(pnlCalls).toHaveLength(1);

    const payload = pnlCalls[0][1] as { totalUnrealizedPnl: number };
    expect(payload.totalUnrealizedPnl).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. No events emitted when no positions exist for the instrument
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — empty position list', () => {
  it('emits no events at all when the DB returns an empty list for the instrument', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();

    positionsRepo.find.mockResolvedValue([]); // no open positions

    await service.processTick('inst-unknown', 100);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. addPosition / removePosition lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — addPosition and removePosition', () => {
  it('addPosition adds the position to tracked IDs and removePosition removes it', async () => {
    const { service, positionsRepo } = await buildService();

    const position = buildMockPosition({ id: 'pos-new', instrument_id: 'inst-2' });
    positionsRepo.findOne.mockResolvedValue(position);

    // Before adding: not tracked
    expect(service.getTrackedPositionIds()).not.toContain('pos-new');

    await service.addPosition('pos-new');

    // After adding: tracked
    expect(service.getTrackedPositionIds()).toContain('pos-new');

    // Remove it
    service.removePosition('pos-new');

    // After removing: not tracked
    expect(service.getTrackedPositionIds()).not.toContain('pos-new');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Multiple positions on the same instrument are all processed per tick
// ─────────────────────────────────────────────────────────────────────────────

describe('PositionMonitoringService — multiple positions on same instrument', () => {
  it('processes all positions for the instrument on a single tick and emits exit events for each that hits its target', async () => {
    const { service, positionsRepo, eventEmitter } = await buildService();

    const posA = buildMockPosition({
      id: 'pos-A',
      direction: 'LONG',
      average_entry_price: '100.00',
      quantity: 10,
      current_sl: '90.00',
      target_price: '110.00', // will be hit at price 110
    });

    const posB = buildMockPosition({
      id: 'pos-B',
      direction: 'LONG',
      average_entry_price: '95.00',
      quantity: 5,
      current_sl: '85.00',
      target_price: '108.00', // will also be hit at price 110
    });

    // Both positions belong to the same instrument
    positionsRepo.find.mockResolvedValue([posA, posB]);

    await service.processTick('inst-1', 110);

    // Both positions should have their MFE / caches updated
    const statsA = service.getPositionStats('pos-A');
    const statsB = service.getPositionStats('pos-B');
    expect(statsA).not.toBeNull();
    expect(statsB).not.toBeNull();

    // Each hit their target — two TARGET_HIT exit events expected
    const exitCalls = (eventEmitter.emit as jest.Mock).mock.calls.filter(
      ([event]) => event === POSITION_EXIT_EVENT,
    );
    expect(exitCalls).toHaveLength(2);

    const exitReasons = exitCalls.map(([, payload]) => (payload as PositionExitSignal).reason);
    expect(exitReasons).toEqual([PositionExitReason.TARGET_HIT, PositionExitReason.TARGET_HIT]);

    // Aggregate P&L event: posA unrealizedPnl=(110-100)*10=100, posB=(110-95)*5=75 → sum=175
    const pnlCalls = (eventEmitter.emit as jest.Mock).mock.calls.filter(
      ([event]) => event === UNREALIZED_PNL_UPDATED_EVENT,
    );
    expect(pnlCalls).toHaveLength(1);
    expect((pnlCalls[0][1] as { totalUnrealizedPnl: number }).totalUnrealizedPnl).toBe(175);
  });
});
