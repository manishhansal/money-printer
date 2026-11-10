/**
 * AnalyticsService unit tests (19 tests).
 *
 * All database interactions are mocked — no live PostgreSQL required.
 *
 * Tests:
 *  1.  Returns all 12 metrics as numbers for LIVE engine with 30+ trades
 *  2.  Returns all 12 metrics as numbers for PAPER engine with 30+ trades
 *  3.  When tradeCount < 30: profitFactor = INSUFFICIENT_DATA sentinel
 *  4.  When tradeCount < 30: sharpeRatio  = INSUFFICIENT_DATA sentinel
 *  5.  When tradeCount < 30: sortinoRatio = INSUFFICIENT_DATA sentinel
 *  6.  When tradeCount < 30: calmarRatio  = INSUFFICIENT_DATA sentinel
 *  7.  winRate = 0.75 for 3 wins out of 4 trades
 *  8.  maxConsecutiveWins and maxConsecutiveLosses computed correctly
 *  9.  expectancy = arithmetic mean of net_pnl values
 * 10.  Empty trade list returns zero metrics without throwing
 * 11.  LIVE engine queries the Trades (live) table, not PaperTrades
 * 12.  PAPER engine queries the PaperTrades table, not Trades
 * 13.  SESSION time-window filter passes a date lower-bound to the repository
 * 14.  maxDrawdown is computed from peak-to-trough cumulative P&L
 * 15.  avgWin and avgLoss are computed correctly
 * 16.  Attribution: trades grouped correctly by strategy code
 * 17.  Attribution: trades grouped correctly by time-of-day bucket
 * 18.  Attribution: empty trade list returns empty breakdown
 * 19.  Attribution: multiple strategies produce separate byStrategy entries
 *
 * Requirements: 14.1, 14.2, 14.3
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AnalyticsService } from './analytics.service';
import { INSUFFICIENT_DATA } from './analytics.types';
import { Trade } from '../../database/entities/trades.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { Strategies } from '../../database/entities/strategies.entity';
import { Instruments } from '../../database/entities/instruments.entity';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a minimal trade record suitable for mocking repository.find(). */
function tradeRecord(netPnl: number, daysAgo = 1): { net_pnl: string; entry_time: Date } {
  const entry_time = new Date();
  entry_time.setDate(entry_time.getDate() - daysAgo);
  return { net_pnl: netPnl.toFixed(2), entry_time };
}

/**
 * Generates exactly `count` trade records alternating wins and losses.
 * Default pattern: two wins (100) then one loss (-50), repeating.
 * With count=30 → 20 wins, 10 losses.
 */
function generateTrades(
  count: number,
  pattern: number[] = [100, 100, -50],
): Array<{ net_pnl: string; entry_time: Date }> {
  return Array.from({ length: count }, (_, i) =>
    tradeRecord(pattern[i % pattern.length], count - i),
  );
}

/**
 * Builds an attribution-capable trade record carrying strategy_id,
 * instrument_id, net_pnl, and an entry_time derived from an IST hour/minute.
 */
function attributionRecord(
  netPnl: number,
  strategyId: string,
  instrumentId: string,
  istHour: number,
  istMinute = 30,
): {
  net_pnl: string;
  entry_time: Date;
  strategy_id: string;
  instrument_id: string;
} {
  /**
   * IST = UTC + 5h 30m → UTC = IST − 5h 30m
   * e.g. 10:30 IST → 05:00 UTC
   */
  const IST_OFFSET_H = 5;
  const IST_OFFSET_M = 30;
  const utcMinutes = istHour * 60 + istMinute - (IST_OFFSET_H * 60 + IST_OFFSET_M);
  const utcH = Math.floor(utcMinutes / 60);
  const utcM = utcMinutes % 60;

  const now = new Date();
  const entry_time = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcH, utcM, 0, 0),
  );

  return {
    net_pnl: netPnl.toFixed(2),
    entry_time,
    strategy_id: strategyId,
    instrument_id: instrumentId,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let mockTradesRepo: { find: jest.Mock };
  let mockPaperTradesRepo: { find: jest.Mock };
  let mockStrategiesRepo: { find: jest.Mock };
  let mockInstrumentsRepo: { find: jest.Mock };

  beforeEach(async () => {
    mockTradesRepo = { find: jest.fn().mockResolvedValue([]) };
    mockPaperTradesRepo = { find: jest.fn().mockResolvedValue([]) };
    mockStrategiesRepo = { find: jest.fn().mockResolvedValue([]) };
    mockInstrumentsRepo = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: getRepositoryToken(Trade),
          useValue: mockTradesRepo,
        },
        {
          provide: getRepositoryToken(PaperTrade),
          useValue: mockPaperTradesRepo,
        },
        {
          provide: getRepositoryToken(Strategies),
          useValue: mockStrategiesRepo,
        },
        {
          provide: getRepositoryToken(Instruments),
          useValue: mockInstrumentsRepo,
        },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Test 1: LIVE engine, 30+ trades — all metrics are numbers ─────────────

  it('returns all 12 numeric metrics for LIVE engine with 30+ trades', async () => {
    mockTradesRepo.find.mockResolvedValue(generateTrades(30));

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.tradeCount).toBe(30);
    expect(typeof result.winRate).toBe('number');
    expect(typeof result.profitFactor).toBe('number');
    expect(typeof result.expectancy).toBe('number');
    expect(typeof result.avgWin).toBe('number');
    expect(typeof result.avgLoss).toBe('number');
    expect(typeof result.rrRatio).toBe('number');
    expect(typeof result.maxDrawdown).toBe('number');
    expect(typeof result.sharpeRatio).toBe('number');
    expect(typeof result.sortinoRatio).toBe('number');
    expect(typeof result.calmarRatio).toBe('number');
    expect(typeof result.maxConsecutiveWins).toBe('number');
    expect(typeof result.maxConsecutiveLosses).toBe('number');
  });

  // ── Test 2: PAPER engine, 30+ trades — all metrics are numbers ────────────

  it('returns all 12 numeric metrics for PAPER engine with 30+ trades', async () => {
    mockPaperTradesRepo.find.mockResolvedValue(generateTrades(30));

    const result = await service.getPerformanceMetrics('PAPER', 'ALL_TIME');

    expect(result.tradeCount).toBe(30);
    expect(typeof result.winRate).toBe('number');
    expect(typeof result.profitFactor).toBe('number');
    expect(typeof result.expectancy).toBe('number');
    expect(typeof result.avgWin).toBe('number');
    expect(typeof result.avgLoss).toBe('number');
    expect(typeof result.rrRatio).toBe('number');
    expect(typeof result.maxDrawdown).toBe('number');
    expect(typeof result.sharpeRatio).toBe('number');
    expect(typeof result.sortinoRatio).toBe('number');
    expect(typeof result.calmarRatio).toBe('number');
    expect(typeof result.maxConsecutiveWins).toBe('number');
    expect(typeof result.maxConsecutiveLosses).toBe('number');
  });

  // ── Test 3: tradeCount < 30 → profitFactor suppressed ────────────────────

  it('sets profitFactor to INSUFFICIENT_DATA when tradeCount < 30', async () => {
    // 4 trades: well below the 30-trade threshold
    mockTradesRepo.find.mockResolvedValue(generateTrades(4));

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.profitFactor).toBe(INSUFFICIENT_DATA);
  });

  // ── Test 4: tradeCount < 30 → sharpeRatio suppressed ─────────────────────

  it('sets sharpeRatio to INSUFFICIENT_DATA when tradeCount < 30', async () => {
    mockTradesRepo.find.mockResolvedValue(generateTrades(4));

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.sharpeRatio).toBe(INSUFFICIENT_DATA);
  });

  // ── Test 5: tradeCount < 30 → sortinoRatio suppressed ────────────────────

  it('sets sortinoRatio to INSUFFICIENT_DATA when tradeCount < 30', async () => {
    mockTradesRepo.find.mockResolvedValue(generateTrades(4));

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.sortinoRatio).toBe(INSUFFICIENT_DATA);
  });

  // ── Test 6: tradeCount < 30 → calmarRatio suppressed ─────────────────────

  it('sets calmarRatio to INSUFFICIENT_DATA when tradeCount < 30', async () => {
    mockTradesRepo.find.mockResolvedValue(generateTrades(4));

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.calmarRatio).toBe(INSUFFICIENT_DATA);
  });

  // ── Test 7: winRate = 0.75 for 3 wins out of 4 trades ────────────────────

  it('computes winRate = 0.75 for 3 wins out of 4 trades', async () => {
    // 3 wins, 1 loss → 3/4 = 0.75
    const trades = [100, 200, 300, -50].map((v) => tradeRecord(v));
    mockTradesRepo.find.mockResolvedValue(trades);

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.winRate).toBeCloseTo(0.75);
  });

  // ── Test 8: maxConsecutiveWins and maxConsecutiveLosses ───────────────────

  it('computes maxConsecutiveWins and maxConsecutiveLosses correctly', async () => {
    // pnl sequence: W W W L L W → maxWins=3, maxLosses=2
    const trades = [100, 200, 300, -50, -100, 400].map((v) => tradeRecord(v));
    mockTradesRepo.find.mockResolvedValue(trades);

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.maxConsecutiveWins).toBe(3);
    expect(result.maxConsecutiveLosses).toBe(2);
  });

  // ── Test 9: expectancy = arithmetic mean of net_pnl ──────────────────────

  it('computes expectancy as the arithmetic mean of net_pnl values', async () => {
    // sum = 100 + (-100) + 200 = 200, mean = 200 / 3 ≈ 66.67
    const trades = [100, -100, 200].map((v) => tradeRecord(v));
    mockTradesRepo.find.mockResolvedValue(trades);

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.expectancy).toBeCloseTo(200 / 3, 5);
  });

  // ── Test 10: empty trade list returns zero metrics without crashing ────────

  it('returns zero metrics for an empty trade list without throwing', async () => {
    mockTradesRepo.find.mockResolvedValue([]);

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.tradeCount).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.expectancy).toBe(0);
    expect(result.avgWin).toBe(0);
    expect(result.avgLoss).toBe(0);
    expect(result.rrRatio).toBe(0);
    expect(result.maxDrawdown).toBe(0);
    expect(result.maxConsecutiveWins).toBe(0);
    expect(result.maxConsecutiveLosses).toBe(0);
    // Ratio metrics are still suppressed (0 < 30)
    expect(result.profitFactor).toBe(INSUFFICIENT_DATA);
    expect(result.sharpeRatio).toBe(INSUFFICIENT_DATA);
    expect(result.sortinoRatio).toBe(INSUFFICIENT_DATA);
    expect(result.calmarRatio).toBe(INSUFFICIENT_DATA);
  });

  // ── Test 11: LIVE engine queries Trades table, not PaperTrades ────────────

  it('queries the Trades (live) table and NOT the PaperTrades table for LIVE engine', async () => {
    mockTradesRepo.find.mockResolvedValue([]);

    await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(mockTradesRepo.find).toHaveBeenCalledTimes(1);
    expect(mockPaperTradesRepo.find).not.toHaveBeenCalled();
  });

  // ── Test 12: PAPER engine queries PaperTrades table, not Trades ───────────

  it('queries the PaperTrades table and NOT the Trades table for PAPER engine', async () => {
    mockPaperTradesRepo.find.mockResolvedValue([]);

    await service.getPerformanceMetrics('PAPER', 'ALL_TIME');

    expect(mockPaperTradesRepo.find).toHaveBeenCalledTimes(1);
    expect(mockTradesRepo.find).not.toHaveBeenCalled();
  });

  // ── Test 13: SESSION filter passes a date lower-bound ─────────────────────

  it("passes a date lower-bound (today's 09:00 IST) to the repository for SESSION window", async () => {
    mockTradesRepo.find.mockResolvedValue([]);

    await service.getPerformanceMetrics('LIVE', 'SESSION');

    expect(mockTradesRepo.find).toHaveBeenCalledTimes(1);
    const findArg = mockTradesRepo.find.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    // The where clause must include an entry_time filter (MoreThanOrEqual).
    expect(findArg.where.entry_time).toBeDefined();

    // ALL_TIME must NOT include an entry_time filter.
    jest.clearAllMocks();
    mockTradesRepo.find.mockResolvedValue([]);
    await service.getPerformanceMetrics('LIVE', 'ALL_TIME');
    const allTimeFindArg = mockTradesRepo.find.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(allTimeFindArg.where.entry_time).toBeUndefined();
  });

  // ── Test 14: maxDrawdown from peak-to-trough cumulative P&L ──────────────

  it('computes maxDrawdown from the peak-to-trough decline in cumulative P&L', async () => {
    // cumPnl:  [100, 300, -100,  0]
    // peaks:   [100, 300,  300, 300]
    // drawdowns: [0,   0,  400, 300]  → maxDrawdown = 400
    const trades = [100, 200, -400, 100].map((v) => tradeRecord(v));
    mockTradesRepo.find.mockResolvedValue(trades);

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.maxDrawdown).toBeCloseTo(400);
  });

  // ── Test 15: avgWin and avgLoss computed correctly ────────────────────────

  it('computes avgWin and avgLoss correctly', async () => {
    // wins: 100, 200  → avgWin  = 150
    // losses: -50, -150 → avgLoss = -100
    const trades = [100, 200, -50, -150].map((v) => tradeRecord(v));
    mockTradesRepo.find.mockResolvedValue(trades);

    const result = await service.getPerformanceMetrics('LIVE', 'ALL_TIME');

    expect(result.avgWin).toBeCloseTo(150);
    expect(result.avgLoss).toBeCloseTo(-100);
    // R:R = |150 / -100| = 1.5
    expect(result.rrRatio).toBeCloseTo(1.5);
  });

  // ── Test 16: attribution — trades grouped correctly by strategy ────────────

  it('groups attribution trades by strategy code and computes per-group metrics', async () => {
    const strategyUuidA = 'aaaaaaaa-0000-0000-0000-000000000001';
    const strategyUuidB = 'bbbbbbbb-0000-0000-0000-000000000002';
    const instrumentId = 'cccccccc-0000-0000-0000-000000000003';

    // 2 wins + 1 loss for strategy A; 1 win for strategy B
    const tradesData = [
      attributionRecord(100, strategyUuidA, instrumentId, 10),
      attributionRecord(200, strategyUuidA, instrumentId, 11),
      attributionRecord(-50, strategyUuidA, instrumentId, 12),
      attributionRecord(300, strategyUuidB, instrumentId, 10),
    ];

    mockTradesRepo.find.mockResolvedValue(tradesData);
    mockStrategiesRepo.find.mockResolvedValue([
      { id: strategyUuidA, code: 'A' },
      { id: strategyUuidB, code: 'B' },
    ]);
    mockInstrumentsRepo.find.mockResolvedValue([
      { id: instrumentId, tradingSymbol: 'NIFTY24JAN21000CE' },
    ]);

    const result = await service.getAttributionBreakdown('LIVE', 'ALL_TIME');

    // Strategy A: 3 trades, 2 wins, expectancy = (100+200-50)/3 ≈ 83.33
    expect(result.byStrategy['A']).toBeDefined();
    expect(result.byStrategy['A'].tradeCount).toBe(3);
    expect(result.byStrategy['A'].winRate).toBeCloseTo(2 / 3);
    expect(result.byStrategy['A'].expectancy).toBeCloseTo(250 / 3);
    expect(result.byStrategy['A'].netPnl).toBeCloseTo(250);

    // Strategy B: 1 trade, 1 win, expectancy = 300
    expect(result.byStrategy['B']).toBeDefined();
    expect(result.byStrategy['B'].tradeCount).toBe(1);
    expect(result.byStrategy['B'].winRate).toBe(1);
    expect(result.byStrategy['B'].netPnl).toBeCloseTo(300);
  });

  // ── Test 17: attribution — trades grouped by time-of-day bucket ───────────

  it('groups attribution trades into correct 60-minute IST time-of-day buckets', async () => {
    const strategyId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const instrumentId = 'bbbbbbbb-0000-0000-0000-000000000002';

    // IST 09:30 → bucket "09:15-10:15"
    // IST 10:45 → bucket "10:15-11:15"
    const tradesData = [
      attributionRecord(100, strategyId, instrumentId, 9, 30), // 09:30 IST
      attributionRecord(200, strategyId, instrumentId, 9, 50), // 09:50 IST  — same bucket
      attributionRecord(-50, strategyId, instrumentId, 10, 45), // 10:45 IST  — different bucket
    ];

    mockTradesRepo.find.mockResolvedValue(tradesData);
    mockStrategiesRepo.find.mockResolvedValue([{ id: strategyId, code: 'A' }]);
    mockInstrumentsRepo.find.mockResolvedValue([
      { id: instrumentId, tradingSymbol: 'NIFTY24JAN21000CE' },
    ]);

    const result = await service.getAttributionBreakdown('LIVE', 'ALL_TIME');

    expect(result.byTimeOfDay['09:15-10:15']).toBeDefined();
    expect(result.byTimeOfDay['09:15-10:15'].tradeCount).toBe(2);
    expect(result.byTimeOfDay['09:15-10:15'].netPnl).toBeCloseTo(300);

    expect(result.byTimeOfDay['10:15-11:15']).toBeDefined();
    expect(result.byTimeOfDay['10:15-11:15'].tradeCount).toBe(1);
    expect(result.byTimeOfDay['10:15-11:15'].netPnl).toBeCloseTo(-50);
  });

  // ── Test 18: attribution — empty trade list returns empty breakdown ────────

  it('returns empty records for all attribution dimensions when trade list is empty', async () => {
    mockTradesRepo.find.mockResolvedValue([]);

    const result = await service.getAttributionBreakdown('LIVE', 'ALL_TIME');

    expect(result.byStrategy).toEqual({});
    expect(result.byInstrument).toEqual({});
    expect(result.byRegime).toEqual({});
    expect(result.byTimeOfDay).toEqual({});
    // No lookups should be needed when there are no trades
    expect(mockStrategiesRepo.find).not.toHaveBeenCalled();
    expect(mockInstrumentsRepo.find).not.toHaveBeenCalled();
  });

  // ── Test 19: attribution — multiple strategies produce separate entries ────

  it('produces a separate byStrategy entry for each distinct strategy code', async () => {
    const uuids = {
      A: 'aaaaaaaa-0000-0000-0000-000000000001',
      C: 'cccccccc-0000-0000-0000-000000000003',
      H: 'hhhhhhhh-0000-0000-0000-000000000008',
    };
    const instrumentId = 'ffffffff-0000-0000-0000-000000000006';

    const tradesData = [
      attributionRecord(100, uuids.A, instrumentId, 10),
      attributionRecord(200, uuids.C, instrumentId, 11),
      attributionRecord(-100, uuids.H, instrumentId, 12),
    ];

    mockTradesRepo.find.mockResolvedValue(tradesData);
    mockStrategiesRepo.find.mockResolvedValue([
      { id: uuids.A, code: 'A' },
      { id: uuids.C, code: 'C' },
      { id: uuids.H, code: 'H' },
    ]);
    mockInstrumentsRepo.find.mockResolvedValue([
      { id: instrumentId, tradingSymbol: 'BANKNIFTY24JAN48000CE' },
    ]);

    const result = await service.getAttributionBreakdown('LIVE', 'ALL_TIME');

    const keys = Object.keys(result.byStrategy).sort();
    expect(keys).toEqual(['A', 'C', 'H']);
    expect(result.byStrategy['A'].tradeCount).toBe(1);
    expect(result.byStrategy['C'].tradeCount).toBe(1);
    expect(result.byStrategy['H'].tradeCount).toBe(1);
    expect(result.byStrategy['H'].winRate).toBe(0);
  });
});
