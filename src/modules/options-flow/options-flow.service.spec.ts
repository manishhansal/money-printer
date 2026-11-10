/**
 * options-flow.service.spec.ts
 *
 * Unit tests for OptionsFlowService (task 31.2).
 *
 * Covers:
 *  1. Dashboard returns all subscribed instruments.
 *  2. isStale=true for snapshots older than 60 seconds.
 *  3. isStale=false for fresh snapshots.
 *  4. suppressOptionsFuturesScore=true when any snapshot is stale.
 *  5. suppressOptionsFuturesScore=false when all snapshots are fresh.
 *  6. putCallRatio computed correctly (put OI / call OI).
 *  7. largeBlockDetected=true when volume > configured threshold.
 *  8. largeBlockDetected=false when volume ≤ configured threshold.
 *  9. Empty cache (no subscriptions) returns empty dashboard.
 * 10. generatedAt reflects the current timestamp.
 *
 * Time control: jest fake timers make Date.now() fully deterministic.
 *
 * Requirements: 20.6, 20.7
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OptionsFlowService, SNAPSHOT_MAX_AGE_MS } from './options-flow.service';
import { OptionsFlowDashboard, OptionsFlowSnapshot } from './options-flow.types';
import { RedisService } from '../redis/redis.service';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface StrikeLeg {
  oi: number;
  previous_oi: number;
  implied_volatility: number;
  volume: number;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
}

interface StrikeFixture {
  ce?: StrikeLeg;
  pe?: StrikeLeg;
}

/** Build a minimal option-chain data payload matching the Redis JSON format. */
function makeOptionChainPayload(strikes: Record<string, StrikeFixture>, lastPrice = 25000): string {
  return JSON.stringify({
    data: {
      last_price: lastPrice,
      oc: strikes,
    },
  });
}

/** Shorthand to build a single CE+PE strike. */
function makeStrike(
  ceOi: number,
  peOi: number,
  cePrevOi: number,
  pePrevOi: number,
  ceVol: number,
  peVol: number,
  ceDelta = 0.25,
  peDelta = -0.25,
  ceIv = 20,
  peIv = 22,
): StrikeFixture {
  return {
    ce: {
      oi: ceOi,
      previous_oi: cePrevOi,
      implied_volatility: ceIv,
      volume: ceVol,
      greeks: { delta: ceDelta, gamma: 0.01, theta: -3, vega: 0.1 },
    },
    pe: {
      oi: peOi,
      previous_oi: pePrevOi,
      implied_volatility: peIv,
      volume: peVol,
      greeks: { delta: peDelta, gamma: 0.01, theta: -3, vega: 0.1 },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

function buildRedisMock(
  responses: Record<string, string | null> = {},
): jest.Mocked<Pick<RedisService, 'get'>> {
  return {
    get: jest.fn().mockImplementation((key: string) => {
      const value = responses[key];
      return Promise.resolve(value !== undefined ? value : null);
    }),
  };
}

function buildConfigMock(largeBlockThreshold = 1000): Partial<ConfigService> {
  return {
    get: jest.fn().mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === 'LARGE_BLOCK_VOLUME_THRESHOLD') return largeBlockThreshold;
      return defaultValue;
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('OptionsFlowService', () => {
  let service: OptionsFlowService;
  let redisMock: jest.Mocked<Pick<RedisService, 'get'>>;
  let configMock: Partial<ConfigService>;

  async function buildService(
    redisResponses: Record<string, string | null> = {},
    largeBlockThreshold = 1000,
  ): Promise<void> {
    redisMock = buildRedisMock(redisResponses);
    configMock = buildConfigMock(largeBlockThreshold);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OptionsFlowService,
        { provide: RedisService, useValue: redisMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    service = module.get<OptionsFlowService>(OptionsFlowService);
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 1: dashboard returns all subscribed instruments
  // ───────────────────────────────────────────────────────────────────────────
  it('1. dashboard returns one snapshot per subscribed instrument', async () => {
    const payload = makeOptionChainPayload({
      '25000.000000': makeStrike(1000, 1200, 900, 1100, 300, 300),
    });

    await buildService({
      'mkt:optchain:NIFTY:2024-12-26': payload,
      'mkt:optchain:BANKNIFTY:2024-12-26': payload,
    });

    service.subscribeInstrument('inst-1', 'NIFTY24DEC25000CE', 'NIFTY', '2024-12-26');
    service.subscribeInstrument('inst-2', 'BANKNIFTY24DEC45000CE', 'BANKNIFTY', '2024-12-26');

    await service.refreshFlow();

    const dashboard: OptionsFlowDashboard = service.getDashboard();
    expect(dashboard.snapshots).toHaveLength(2);

    const ids = dashboard.snapshots.map((s) => s.instrumentId);
    expect(ids).toContain('inst-1');
    expect(ids).toContain('inst-2');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 2: isStale=true for snapshots older than 60 seconds
  // ───────────────────────────────────────────────────────────────────────────
  it('2. isStale=true when snapshotTime is more than 60 seconds old', async () => {
    jest.useFakeTimers();
    const baseTime = new Date('2024-12-26T10:00:00.000Z');
    jest.setSystemTime(baseTime);

    const payload = makeOptionChainPayload({
      '25000.000000': makeStrike(1000, 1200, 900, 1100, 300, 300),
    });

    await buildService({ 'mkt:optchain:NIFTY:2024-12-26': payload });
    service.subscribeInstrument('inst-1', 'NIFTY24DEC25000CE', 'NIFTY', '2024-12-26');

    await service.refreshFlow();

    // Advance time past the 60-second staleness threshold
    jest.advanceTimersByTime(SNAPSHOT_MAX_AGE_MS + 1);

    const dashboard = service.getDashboard();
    expect(dashboard.snapshots).toHaveLength(1);
    expect(dashboard.snapshots[0].isStale).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 3: isStale=false for fresh snapshots
  // ───────────────────────────────────────────────────────────────────────────
  it('3. isStale=false for snapshots within the 60-second window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-12-26T10:00:00.000Z'));

    const payload = makeOptionChainPayload({
      '25000.000000': makeStrike(1000, 1200, 900, 1100, 300, 300),
    });

    await buildService({ 'mkt:optchain:NIFTY:2024-12-26': payload });
    service.subscribeInstrument('inst-1', 'NIFTY24DEC25000CE', 'NIFTY', '2024-12-26');

    await service.refreshFlow();

    // Advance only 30 seconds — still within the freshness window
    jest.advanceTimersByTime(30_000);

    const dashboard = service.getDashboard();
    expect(dashboard.snapshots[0].isStale).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 4: suppressOptionsFuturesScore=true when any snapshot is stale
  // ───────────────────────────────────────────────────────────────────────────
  it('4. suppressOptionsFuturesScore=true when at least one snapshot is stale', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-12-26T10:00:00.000Z'));

    const freshPayload = makeOptionChainPayload({
      '25000.000000': makeStrike(1000, 1200, 900, 1100, 300, 300),
    });
    const stalePayload = makeOptionChainPayload({
      '45000.000000': makeStrike(2000, 2400, 1800, 2200, 400, 400),
    });

    await buildService({
      'mkt:optchain:NIFTY:2024-12-26': freshPayload,
      'mkt:optchain:BANKNIFTY:2024-12-26': stalePayload,
    });

    service.subscribeInstrument('inst-fresh', 'NIFTY24DEC25000CE', 'NIFTY', '2024-12-26');
    service.subscribeInstrument('inst-stale', 'BANKNIFTY24DEC45000CE', 'BANKNIFTY', '2024-12-26');

    // Refresh both while time is at baseTime
    await service.refreshFlow();

    // Advance past staleness threshold — both snapshots will be stale
    jest.advanceTimersByTime(SNAPSHOT_MAX_AGE_MS + 1);

    const dashboard = service.getDashboard();
    expect(dashboard.suppressOptionsFuturesScore).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 5: suppressOptionsFuturesScore=false when all snapshots are fresh
  // ───────────────────────────────────────────────────────────────────────────
  it('5. suppressOptionsFuturesScore=false when all snapshots are within the freshness window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-12-26T10:00:00.000Z'));

    const payload = makeOptionChainPayload({
      '25000.000000': makeStrike(1000, 1200, 900, 1100, 300, 300),
    });

    await buildService({
      'mkt:optchain:NIFTY:2024-12-26': payload,
      'mkt:optchain:BANKNIFTY:2024-12-26': payload,
    });

    service.subscribeInstrument('inst-1', 'NIFTY24DEC25000CE', 'NIFTY', '2024-12-26');
    service.subscribeInstrument('inst-2', 'BANKNIFTY24DEC45000CE', 'BANKNIFTY', '2024-12-26');

    await service.refreshFlow();

    // Advance only 20 seconds — still fresh
    jest.advanceTimersByTime(20_000);

    const dashboard = service.getDashboard();
    expect(dashboard.suppressOptionsFuturesScore).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 6: putCallRatio computed correctly (put OI / call OI)
  // ───────────────────────────────────────────────────────────────────────────
  it('6. putCallRatio = totalPutOI / totalCallOI', async () => {
    // Strike A: CE OI=1000, PE OI=1500
    // Strike B: CE OI=800,  PE OI=600
    // Total CE = 1800, Total PE = 2100 → PCR = 2100/1800 ≈ 1.1667
    const payload = makeOptionChainPayload({
      '25000.000000': makeStrike(1000, 1500, 900, 1400, 100, 100),
      '25100.000000': makeStrike(800, 600, 750, 550, 100, 100),
    });

    await buildService({ 'mkt:optchain:NIFTY:2024-12-26': payload });
    service.subscribeInstrument('inst-1', 'NIFTY24DEC25000CE', 'NIFTY', '2024-12-26');

    await service.refreshFlow();

    const dashboard = service.getDashboard();
    const snapshot: OptionsFlowSnapshot = dashboard.snapshots[0];

    const expectedPCR = 2100 / 1800;
    expect(snapshot.putCallRatio).toBeCloseTo(expectedPCR, 5);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 7: largeBlockDetected=true when volume > threshold
  // ───────────────────────────────────────────────────────────────────────────
  it('7. largeBlockDetected=true when a leg volume exceeds the configured threshold', async () => {
    // threshold=1000; leg volume=2000 → detected
    const payload = makeOptionChainPayload({
      '25000.000000': makeStrike(1000, 1200, 900, 1100, 2000 /* CE vol */, 300),
    });

    await buildService({ 'mkt:optchain:NIFTY:2024-12-26': payload }, 1000);
    service.subscribeInstrument('inst-1', 'NIFTY24DEC25000CE', 'NIFTY', '2024-12-26');

    await service.refreshFlow();

    const dashboard = service.getDashboard();
    const snapshot = dashboard.snapshots[0];
    expect(snapshot.largeBlockDetected).toBe(true);
    expect(snapshot.largeBlockVolume).toBe(2000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 8: largeBlockDetected=false when volume ≤ threshold
  // ───────────────────────────────────────────────────────────────────────────
  it('8. largeBlockDetected=false when all leg volumes are below the configured threshold', async () => {
    // threshold=1000; all volumes=300 → not detected
    const payload = makeOptionChainPayload({
      '25000.000000': makeStrike(1000, 1200, 900, 1100, 300, 300),
    });

    await buildService({ 'mkt:optchain:NIFTY:2024-12-26': payload }, 1000);
    service.subscribeInstrument('inst-1', 'NIFTY24DEC25000CE', 'NIFTY', '2024-12-26');

    await service.refreshFlow();

    const dashboard = service.getDashboard();
    const snapshot = dashboard.snapshots[0];
    expect(snapshot.largeBlockDetected).toBe(false);
    expect(snapshot.largeBlockVolume).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 9: empty cache returns empty dashboard
  // ───────────────────────────────────────────────────────────────────────────
  it('9. empty subscription list returns a dashboard with zero snapshots', async () => {
    await buildService();

    // No subscriptions → no refreshFlow() call needed
    const dashboard = service.getDashboard();

    expect(dashboard.snapshots).toHaveLength(0);
    expect(dashboard.suppressOptionsFuturesScore).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 10: generatedAt reflects the current timestamp
  // ───────────────────────────────────────────────────────────────────────────
  it('10. generatedAt is set to the current wall-clock time', async () => {
    jest.useFakeTimers();
    const fixedTime = new Date('2024-12-26T10:30:00.000Z');
    jest.setSystemTime(fixedTime);

    await buildService();

    const dashboard = service.getDashboard();
    expect(dashboard.generatedAt).toEqual(fixedTime);
  });
});
