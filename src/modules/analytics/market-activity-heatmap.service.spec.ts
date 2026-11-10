/**
 * MarketActivityHeatmapService unit tests (8 tests).
 *
 * All database interactions are mocked — no live PostgreSQL required.
 *
 * Tests:
 *  1.  Signals grouped by trading symbol correctly
 *  2.  Signals grouped by 60-minute IST time-of-day bucket correctly
 *  3.  Signals grouped by regime code correctly
 *  4.  Signal with null regime not counted in byRegime
 *  5.  Signal with unresolvable instrument not counted in byInstrument
 *  6.  Empty signals list returns empty maps for all dimensions
 *  7.  Signals repository queried with a date filter for the 30-trading-day window
 *  8.  Multiple signals for the same instrument accumulate correctly
 *
 * Requirements: 14.7
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MarketActivityHeatmapService, HeatmapData } from './market-activity-heatmap.service';
import { Signals } from '../../database/entities/signals.entity';
import { Instruments } from '../../database/entities/instruments.entity';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Stable UUIDs used across tests. */
const INST_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const INST_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const SYMBOL_A = 'NIFTY24JAN21000CE';
const SYMBOL_B = 'BANKNIFTY24JAN43000CE';

/**
 * Converts an IST hour:minute to a UTC Date on a fixed reference date
 * (2024-01-15).  IST = UTC + 5h 30m, so UTC = IST − 5h 30m.
 *
 * Example: 09:30 IST → `Date.UTC(2024, 0, 15, 4, 0)` → 04:00 UTC
 */
function istToUtc(hours: number, minutes: number): Date {
  return new Date(Date.UTC(2024, 0, 15, hours - 5, minutes - 30, 0, 0));
}

/**
 * Builds a minimal signal record that satisfies the fields accessed by
 * MarketActivityHeatmapService (instrumentId, signalTimestamp, regime).
 */
function makeSignal(
  instrumentId: string,
  signalTimestampUtc: Date,
  regime: string | null,
): Pick<Signals, 'instrumentId' | 'signalTimestamp' | 'regime'> {
  return { instrumentId, signalTimestamp: signalTimestampUtc, regime };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('MarketActivityHeatmapService', () => {
  let service: MarketActivityHeatmapService;
  let mockSignalsRepo: { find: jest.Mock };
  let mockInstrumentsRepo: { find: jest.Mock };

  beforeEach(async () => {
    mockSignalsRepo = { find: jest.fn().mockResolvedValue([]) };
    mockInstrumentsRepo = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketActivityHeatmapService,
        {
          provide: getRepositoryToken(Signals),
          useValue: mockSignalsRepo,
        },
        {
          provide: getRepositoryToken(Instruments),
          useValue: mockInstrumentsRepo,
        },
      ],
    }).compile();

    service = module.get<MarketActivityHeatmapService>(MarketActivityHeatmapService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Test 1 ──────────────────────────────────────────────────────────────────

  it('groups signals by trading symbol correctly', async () => {
    // Two signals for INST_A, one for INST_B
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal(INST_A, istToUtc(10, 0), 'BULL_TREND'),
      makeSignal(INST_A, istToUtc(10, 30), 'BULL_TREND'),
      makeSignal(INST_B, istToUtc(11, 0), 'BEAR_TREND'),
    ]);
    mockInstrumentsRepo.find.mockResolvedValueOnce([
      { id: INST_A, tradingSymbol: SYMBOL_A },
      { id: INST_B, tradingSymbol: SYMBOL_B },
    ]);

    const result: HeatmapData = await service.getHeatmap('LIVE');

    expect(result.byInstrument).toEqual({
      [SYMBOL_A]: 2,
      [SYMBOL_B]: 1,
    });
  });

  // ── Test 2 ──────────────────────────────────────────────────────────────────

  it('groups signals by 60-minute IST time-of-day bucket correctly', async () => {
    // 09:30 IST  → bucket "09:15-10:15" (15 min past open → bucket 0)
    // 10:30 IST  → bucket "10:15-11:15" (75 min past open → bucket 1)
    // 10:59 IST  → bucket "10:15-11:15" (104 min past open → bucket 1)
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal(INST_A, istToUtc(9, 30), 'BULL_TREND'),
      makeSignal(INST_A, istToUtc(10, 30), 'BULL_TREND'),
      makeSignal(INST_A, istToUtc(10, 59), 'BULL_TREND'),
    ]);
    mockInstrumentsRepo.find.mockResolvedValueOnce([{ id: INST_A, tradingSymbol: SYMBOL_A }]);

    const result: HeatmapData = await service.getHeatmap('LIVE');

    expect(result.byTimeOfDay['09:15-10:15']).toBe(1);
    expect(result.byTimeOfDay['10:15-11:15']).toBe(2);
  });

  // ── Test 3 ──────────────────────────────────────────────────────────────────

  it('groups signals by regime code correctly', async () => {
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal(INST_A, istToUtc(10, 0), 'BULL_TREND'),
      makeSignal(INST_A, istToUtc(10, 10), 'BULL_TREND'),
      makeSignal(INST_A, istToUtc(11, 0), 'BEAR_TREND'),
    ]);
    mockInstrumentsRepo.find.mockResolvedValueOnce([{ id: INST_A, tradingSymbol: SYMBOL_A }]);

    const result: HeatmapData = await service.getHeatmap('LIVE');

    expect(result.byRegime).toEqual({ BULL_TREND: 2, BEAR_TREND: 1 });
  });

  // ── Test 4 ──────────────────────────────────────────────────────────────────

  it('does not count signals with null regime in byRegime', async () => {
    // Both signals in the same 60-min bucket (09:15-10:15) so there is exactly
    // one time-of-day key; 10:00 and 10:10 IST both fall within bucket 0.
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal(INST_A, istToUtc(10, 0), null),
      makeSignal(INST_A, istToUtc(10, 10), null),
    ]);
    mockInstrumentsRepo.find.mockResolvedValueOnce([{ id: INST_A, tradingSymbol: SYMBOL_A }]);

    const result: HeatmapData = await service.getHeatmap('LIVE');

    // Null-regime signals must not appear in byRegime
    expect(result.byRegime).toEqual({});
    // But they still contribute to byInstrument and byTimeOfDay
    expect(result.byInstrument[SYMBOL_A]).toBe(2);
    // Both fall in "09:15-10:15" (bucket 0), so only one time-of-day key
    expect(Object.keys(result.byTimeOfDay).length).toBe(1);
    expect(result.byTimeOfDay['09:15-10:15']).toBe(2);
  });

  // ── Test 5 ──────────────────────────────────────────────────────────────────

  it('does not count signals with unresolvable instrument in byInstrument', async () => {
    // The signal has a valid instrumentId but the instruments table returns nothing
    // (simulates a deleted or missing instrument record).
    mockSignalsRepo.find.mockResolvedValueOnce([makeSignal(INST_A, istToUtc(10, 0), 'BULL_TREND')]);
    mockInstrumentsRepo.find.mockResolvedValueOnce([]); // lookup returns nothing

    const result: HeatmapData = await service.getHeatmap('LIVE');

    expect(result.byInstrument).toEqual({});
    // The signal still counts in the other two dimensions
    expect(result.byRegime).toEqual({ BULL_TREND: 1 });
    expect(result.byTimeOfDay['09:15-10:15']).toBe(1);
  });

  // ── Test 6 ──────────────────────────────────────────────────────────────────

  it('returns empty maps for all dimensions when no signals exist', async () => {
    mockSignalsRepo.find.mockResolvedValueOnce([]);

    const result: HeatmapData = await service.getHeatmap('PAPER');

    expect(result.byInstrument).toEqual({});
    expect(result.byTimeOfDay).toEqual({});
    expect(result.byRegime).toEqual({});
    expect(result.windowDays).toBe(30);
    expect(result.generatedAt).toBeInstanceOf(Date);
    // Instrument lookup must be skipped when there are no signals
    expect(mockInstrumentsRepo.find).not.toHaveBeenCalled();
  });

  // ── Test 7 ──────────────────────────────────────────────────────────────────

  it('queries signals with a date filter covering the 30-trading-day window', async () => {
    mockSignalsRepo.find.mockResolvedValueOnce([]);

    await service.getHeatmap('LIVE');

    // Inspect the FindOptions passed to signalsRepo.find
    const findOptions = mockSignalsRepo.find.mock.calls[0]?.[0] as {
      where: Record<string, any>;
    };
    const tsFilter = findOptions?.where?.signalTimestamp;

    // A MoreThanOrEqual FindOperator must be present
    expect(tsFilter).toBeDefined();
    expect(tsFilter.type).toBe('moreThanOrEqual');
    expect(tsFilter.value).toBeInstanceOf(Date);

    // The cutoff date should be in the past — at least 30 nominal days ago
    // (the actual implementation uses ~42 calendar days for 30 trading days)
    const daysAgo = (Date.now() - (tsFilter.value as Date).getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeGreaterThanOrEqual(30);
    expect(daysAgo).toBeLessThan(60); // Sanity upper bound
  });

  // ── Test 8 ──────────────────────────────────────────────────────────────────

  it('accumulates signal count correctly for the same instrument across multiple signals', async () => {
    // Three signals, all targeting the same instrument but with different times/regimes
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal(INST_A, istToUtc(9, 30), 'BULL_TREND'),
      makeSignal(INST_A, istToUtc(10, 30), 'RANGE_BOUND'),
      makeSignal(INST_A, istToUtc(11, 30), 'BEAR_TREND'),
    ]);
    mockInstrumentsRepo.find.mockResolvedValueOnce([{ id: INST_A, tradingSymbol: SYMBOL_A }]);

    const result: HeatmapData = await service.getHeatmap('LIVE');

    expect(result.byInstrument[SYMBOL_A]).toBe(3);
    // Each signal falls in a different 60-min bucket
    expect(result.byTimeOfDay['09:15-10:15']).toBe(1);
    expect(result.byTimeOfDay['10:15-11:15']).toBe(1);
    expect(result.byTimeOfDay['11:15-12:15']).toBe(1);
  });
});
