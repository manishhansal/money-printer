/**
 * DailyIntelligenceReportService unit tests (8 tests).
 *
 * All database interactions are mocked — no live PostgreSQL required.
 *
 * Tests:
 *  1.  Returns correct tradeSummary fields when trades exist
 *  2.  noTradeEntry is undefined when trades were placed
 *  3.  noTradeEntry is populated when no trades were placed
 *  4.  noTradeEntry.evaluatedSignals contains score and failingCriterion
 *  5.  rejectedSignals is empty when no rejected/expired signals exist
 *  6.  rejectedSignals includes failingCriterion for score-below-threshold signals
 *  7.  rejectedSignals includes TTL description for expired signals
 *  8.  rejectedSignals uses stored rejectionReason when score is above threshold
 *
 * Requirements: 14.4, 14.5
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  DailyIntelligenceReportService,
  DailyIntelligenceReport,
} from './daily-intelligence-report.service';
import { Trade } from '../../database/entities/trades.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { Signals } from '../../database/entities/signals.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';
import { CapitalLedgers } from '../../database/entities/capital-ledgers.entity';
import { MarketRegimes } from '../../database/entities/market-regimes.entity';
import { Strategies } from '../../database/entities/strategies.entity';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a minimal trade row for testing. */
function tradeRow(netPnl: number): { net_pnl: string; entry_time: Date } {
  return { net_pnl: netPnl.toFixed(2), entry_time: new Date('2024-11-15T06:00:00Z') };
}

/** Returns a minimal Signals-like object for testing. */
function makeSignal(
  overrides: Partial<{
    id: string;
    strategyId: string;
    compositeScore: string;
    rejectionReason: string | null;
    status: 'rejected' | 'expired';
    regime: string;
  }>,
): Signals {
  return {
    id: overrides.id ?? 'signal-uuid-1',
    strategyId: overrides.strategyId ?? 'strategy-uuid-a',
    compositeScore: overrides.compositeScore ?? '75.00',
    rejectionReason: overrides.rejectionReason ?? null,
    status: overrides.status ?? 'rejected',
    regime: overrides.regime ?? 'TRENDING_BULLISH',
    signalTimestamp: new Date('2024-11-15T05:30:00Z'),
  } as unknown as Signals;
}

/** A fixed session date in UTC that maps to 2024-11-15 IST. */
const SESSION_DATE = new Date('2024-11-15T06:00:00Z'); // 11:30 IST

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('DailyIntelligenceReportService', () => {
  let service: DailyIntelligenceReportService;

  let mockTradesRepo: { find: jest.Mock };
  let mockPaperTradesRepo: { find: jest.Mock };
  let mockSignalsRepo: { find: jest.Mock };
  let mockStratPerfRepo: { find: jest.Mock };
  let mockCapitalLedgerRepo: { findOne: jest.Mock };
  let mockMarketRegimesRepo: { find: jest.Mock };
  let mockStrategiesRepo: { find: jest.Mock };

  beforeEach(async () => {
    // Default stubs — each test overrides what it needs.
    mockTradesRepo = { find: jest.fn().mockResolvedValue([]) };
    mockPaperTradesRepo = { find: jest.fn().mockResolvedValue([]) };
    mockSignalsRepo = { find: jest.fn().mockResolvedValue([]) };
    mockStratPerfRepo = { find: jest.fn().mockResolvedValue([]) };
    mockCapitalLedgerRepo = { findOne: jest.fn().mockResolvedValue(null) };
    mockMarketRegimesRepo = { find: jest.fn().mockResolvedValue([]) };
    mockStrategiesRepo = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyIntelligenceReportService,
        { provide: getRepositoryToken(Trade), useValue: mockTradesRepo },
        { provide: getRepositoryToken(PaperTrade), useValue: mockPaperTradesRepo },
        { provide: getRepositoryToken(Signals), useValue: mockSignalsRepo },
        { provide: getRepositoryToken(StrategyPerformance), useValue: mockStratPerfRepo },
        { provide: getRepositoryToken(CapitalLedgers), useValue: mockCapitalLedgerRepo },
        { provide: getRepositoryToken(MarketRegimes), useValue: mockMarketRegimesRepo },
        { provide: getRepositoryToken(Strategies), useValue: mockStrategiesRepo },
      ],
    }).compile();

    service = module.get<DailyIntelligenceReportService>(DailyIntelligenceReportService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Test 1: tradeSummary is correct when trades exist ─────────────────────

  it('populates tradeSummary correctly when trades exist', async () => {
    // 2 wins (100, 200) + 1 loss (-50) = totalNetPnl 250, winRate 2/3
    mockTradesRepo.find.mockResolvedValueOnce([tradeRow(100), tradeRow(200), tradeRow(-50)]);

    const report: DailyIntelligenceReport = await service.generateDailyReport('LIVE', SESSION_DATE);

    expect(report.tradeSummary.totalTrades).toBe(3);
    expect(report.tradeSummary.winCount).toBe(2);
    expect(report.tradeSummary.lossCount).toBe(1);
    expect(report.tradeSummary.totalNetPnl).toBeCloseTo(250);
    expect(report.tradeSummary.winRate).toBeCloseTo(2 / 3);
  });

  // ── Test 2: noTradeEntry is absent when trades were placed ────────────────

  it('sets noTradeEntry to undefined when trades were placed', async () => {
    mockTradesRepo.find.mockResolvedValueOnce([tradeRow(100)]);

    const report = await service.generateDailyReport('LIVE', SESSION_DATE);

    expect(report.noTradeEntry).toBeUndefined();
  });

  // ── Test 3: noTradeEntry is populated when no trades were placed ──────────

  it('populates noTradeEntry when no trades were placed (Req 14.5)', async () => {
    // 0 trades, 1 rejected signal
    mockTradesRepo.find.mockResolvedValueOnce([]);
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal({ id: 'sig-1', compositeScore: '72.50', status: 'rejected' }),
    ]);

    const report = await service.generateDailyReport('LIVE', SESSION_DATE);

    expect(report.noTradeEntry).toBeDefined();
    expect(report.noTradeEntry!.reason).toMatch(/1 signal\(s\) evaluated/);
    expect(report.noTradeEntry!.evaluatedSignals).toHaveLength(1);
  });

  // ── Test 4: noTradeEntry.evaluatedSignals carries score and failingCriterion

  it('noTradeEntry.evaluatedSignals carries score and failingCriterion per signal', async () => {
    mockTradesRepo.find.mockResolvedValueOnce([]);
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal({ id: 'sig-1', compositeScore: '65.00', status: 'rejected' }),
    ]);

    const report = await service.generateDailyReport('LIVE', SESSION_DATE);

    const entry = report.noTradeEntry!.evaluatedSignals[0];
    expect(entry.signalId).toBe('sig-1');
    expect(entry.score).toBeCloseTo(65);
    // Score 65 < 80 → failingCriterion identifies the composite-score threshold
    expect(entry.failingCriterion).toContain('Composite score below minimum threshold');
    expect(entry.failingCriterion).toContain('65.00');
  });

  // ── Test 5: rejectedSignals is empty when no rejected/expired signals exist

  it('returns an empty rejectedSignals array when no signals were rejected or expired', async () => {
    mockTradesRepo.find.mockResolvedValueOnce([tradeRow(500)]);
    // signalsRepo returns [] by default (no rejected/expired signals)

    const report = await service.generateDailyReport('LIVE', SESSION_DATE);

    expect(report.rejectedSignals).toEqual([]);
  });

  // ── Test 6: score-below-threshold signals include the composite-score criterion

  it('sets failingCriterion to composite-score description when score < 80', async () => {
    mockTradesRepo.find.mockResolvedValueOnce([]);
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal({ id: 'sig-low', compositeScore: '58.75', status: 'rejected' }),
    ]);

    const report = await service.generateDailyReport('LIVE', SESSION_DATE);

    const entry = report.rejectedSignals[0];
    expect(entry.signalId).toBe('sig-low');
    expect(entry.score).toBeCloseTo(58.75);
    expect(entry.failingCriterion).toContain('Composite score below minimum threshold');
    expect(entry.failingCriterion).toContain('≥80');
    expect(entry.failingCriterion).toContain('58.75');
  });

  // ── Test 7: expired signals carry the TTL-elapsed description ────────────

  it('sets failingCriterion to TTL-elapsed description for expired signals', async () => {
    mockTradesRepo.find.mockResolvedValueOnce([]);
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal({ id: 'sig-exp', compositeScore: '85.00', status: 'expired' }),
    ]);

    const report = await service.generateDailyReport('LIVE', SESSION_DATE);

    const entry = report.rejectedSignals[0];
    expect(entry.signalId).toBe('sig-exp');
    expect(entry.failingCriterion).toBe('Signal expired — TTL elapsed before execution');
    // rejectionReason should reflect expiry
    expect(entry.rejectionReason).toBe('Signal expired');
  });

  // ── Test 8: signals above threshold use the stored rejectionReason ────────

  it('uses stored rejectionReason as failingCriterion when score ≥ 80', async () => {
    const customReason = 'R:R ratio below strategy minimum (required: 1.5, actual: 1.1)';
    mockTradesRepo.find.mockResolvedValueOnce([]);
    mockSignalsRepo.find.mockResolvedValueOnce([
      makeSignal({
        id: 'sig-rr',
        compositeScore: '82.00',
        status: 'rejected',
        rejectionReason: customReason,
      }),
    ]);

    const report = await service.generateDailyReport('LIVE', SESSION_DATE);

    const entry = report.rejectedSignals[0];
    expect(entry.rejectionReason).toBe(customReason);
    expect(entry.failingCriterion).toBe(customReason);
  });
});
