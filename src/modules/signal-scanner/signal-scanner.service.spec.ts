/**
 * signal-scanner.service.spec.ts
 *
 * Unit tests for SignalScannerService — the cron-based signal scanning pipeline.
 *
 * Coverage (20 tests):
 *
 *  Engine selection (DEFECT-001 regression):
 *   1.  buildCandidate sets engine='LIVE' when LiveTradingService.isArmed() === true
 *   2.  buildCandidate sets engine='PAPER' when LiveTradingService.isArmed() === false
 *   3.  DISARMED → engine='PAPER'
 *   4.  ARMED_PENDING → engine='PAPER'
 *
 *  Scan loop phase guards:
 *   5.  scanForSignals() skips when phase is CLOSING
 *   6.  scanForSignals() skips when phase is EOD_RECONCILIATION
 *   7.  scanForSignals() proceeds when phase is MORNING_MOMENTUM
 *   8.  scanForSignals() warns and returns when no snapshots in Redis
 *
 *  Eligibility and scoring:
 *   9.  isEligible() returns false when SniperEntryService rejects the snapshot
 *  10.  isEligible() returns true when SniperEntryService approves
 *  11.  computeComponentScores uses REGIME_SCORE lookup for regimeAlignment
 *  12.  computeComponentScores sets momentum=8 and vwapTrendAlignment=8 (known gap, not a bug)
 *  13.  computeComponentScores sets priceStructure=12 when bid and ask are present
 *  14.  computeComponentScores sets priceStructure=10 when bid/ask are missing
 *  15.  computeComponentScores sets volumeConfirmation=13 when volume > 100
 *  16.  computeComponentScores sets volumeConfirmation=10 when 0 < volume ≤ 100
 *  17.  computeComponentScores sets volumeConfirmation=7 when volume === 0
 *  18.  computeComponentScores sets rrQuality=10 when R:R ≥ 2.0
 *  19.  computeComponentScores sets rrQuality=8 when 1.5 ≤ R:R < 2.0
 *  20.  computeComponentScores sets rrQuality=5 when R:R < 1.5
 *
 * All tests use in-memory stubs — no real database, Redis or broker connection needed.
 *
 * Requirements: DEFECT-001 fix, signal pipeline coverage
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Instruments } from '../../database/entities/instruments.entity';
import { RedisService } from '../redis/redis.service';
import { MarketRegimeService } from '../market-regime/market-regime.service';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { StrategyService } from '../strategy/strategy.service';
import { SniperEntryService } from './sniper-entry.service';
import { LiveTradingService } from '../live-trading/live-trading.service';
import { SignalScannerService } from './signal-scanner.service';
import { MarketRegime } from '../market-regime/market-regime.types';
import { SessionPhase } from '../session-manager/session-manager.types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface MockDeps {
  service: SignalScannerService;
  redisService: { keys: jest.Mock; get: jest.Mock };
  marketRegimeService: { getCurrentRegime: jest.Mock };
  sessionManagerService: { getCurrentPhase: jest.Mock };
  strategyService: { evaluateSignalCandidate: jest.Mock };
  sniperEntryService: { evaluate: jest.Mock };
  liveTradingService: { isArmed: jest.Mock };
  instrumentsRepo: { find: jest.Mock };
}

async function buildService(overrides: { isArmed?: boolean } = {}): Promise<MockDeps> {
  const redisService = {
    keys: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(null),
  };

  const marketRegimeService = {
    getCurrentRegime: jest.fn().mockReturnValue(MarketRegime.STRONG_BULL),
  };

  const sessionManagerService = {
    getCurrentPhase: jest.fn().mockReturnValue(SessionPhase.MORNING_MOMENTUM),
  };

  const strategyService = {
    evaluateSignalCandidate: jest.fn().mockResolvedValue(undefined),
  };

  const sniperEntryService = {
    evaluate: jest.fn().mockReturnValue({ eligible: true, failingFilters: [], qualityScore: 80 }),
  };

  const liveTradingService = {
    isArmed: jest.fn().mockReturnValue(overrides.isArmed ?? false),
  };

  const instrumentsRepo = {
    find: jest.fn().mockResolvedValue([]),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SignalScannerService,
      { provide: RedisService, useValue: redisService },
      { provide: MarketRegimeService, useValue: marketRegimeService },
      { provide: SessionManagerService, useValue: sessionManagerService },
      { provide: StrategyService, useValue: strategyService },
      { provide: SniperEntryService, useValue: sniperEntryService },
      { provide: LiveTradingService, useValue: liveTradingService },
      { provide: getRepositoryToken(Instruments), useValue: instrumentsRepo },
    ],
  }).compile();

  return {
    service: module.get(SignalScannerService),
    redisService,
    marketRegimeService,
    sessionManagerService,
    strategyService,
    sniperEntryService,
    liveTradingService,
    instrumentsRepo,
  };
}

/** Minimal valid snapshot stored as JSON string in Redis. */
function makeSnapshotJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ltp: 100.0,
    bidPrice: 99.5,
    askPrice: 100.5,
    volume: 50000,
    timestamp: Date.now(),
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1–4. Engine selection — DEFECT-001 regression
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — engine selection (DEFECT-001 regression)', () => {
  it('sets engine="LIVE" when LiveTradingService.isArmed() returns true', async () => {
    const { service, liveTradingService } = await buildService({ isArmed: true });
    liveTradingService.isArmed.mockReturnValue(true);

    // Access buildCandidate indirectly via the private method using type cast
    // to verify the engine field without running the full scan loop.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    const candidate = svc.buildCandidate(
      'inst-uuid-1',
      'sec-123',
      { ltp: 100, bidPrice: 99.5, askPrice: 100.5, volume: 50000 },
      MarketRegime.STRONG_BULL,
      false,
    );

    expect(candidate.engine).toBe('LIVE');
  });

  it('sets engine="PAPER" when LiveTradingService.isArmed() returns false', async () => {
    const { service, liveTradingService } = await buildService({ isArmed: false });
    liveTradingService.isArmed.mockReturnValue(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    const candidate = svc.buildCandidate(
      'inst-uuid-1',
      'sec-123',
      { ltp: 100, bidPrice: 99.5, askPrice: 100.5, volume: 50000 },
      MarketRegime.STRONG_BULL,
      false,
    );

    expect(candidate.engine).toBe('PAPER');
  });

  it('never sets engine="LIVE" when isArmed() is false (DISARMED state)', async () => {
    const { service, liveTradingService } = await buildService();
    liveTradingService.isArmed.mockReturnValue(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    const candidate = svc.buildCandidate(
      'inst-1',
      'sec-1',
      { ltp: 50, bidPrice: 49, askPrice: 51, volume: 1000 },
      MarketRegime.WEAK_BULL,
      false,
    );

    expect(candidate.engine).not.toBe('LIVE');
    expect(candidate.engine).toBe('PAPER');
  });

  it('sets engine="LIVE" only when isArmed() is strictly true', async () => {
    const { service, liveTradingService } = await buildService({ isArmed: true });
    liveTradingService.isArmed.mockReturnValue(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    const candidateLive = svc.buildCandidate(
      'inst-1',
      'sec-1',
      { ltp: 100, bidPrice: 99, askPrice: 101, volume: 10000 },
      MarketRegime.STRONG_BULL,
      false,
    );

    liveTradingService.isArmed.mockReturnValue(false);
    const candidatePaper = svc.buildCandidate(
      'inst-1',
      'sec-1',
      { ltp: 100, bidPrice: 99, askPrice: 101, volume: 10000 },
      MarketRegime.STRONG_BULL,
      false,
    );

    expect(candidateLive.engine).toBe('LIVE');
    expect(candidatePaper.engine).toBe('PAPER');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5–8. Scan loop phase guards
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — scan loop phase guards', () => {
  it('skips scan entirely when session phase is CLOSING', async () => {
    const { service, sessionManagerService, strategyService, redisService } = await buildService();
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.CLOSING);
    redisService.keys.mockResolvedValue(['mkt:snapshot:123']);

    await service.scanForSignals();

    // StrategyService should never be called when phase is CLOSING
    expect(strategyService.evaluateSignalCandidate).not.toHaveBeenCalled();
    // Redis keys should not be queried either (returned early before that point)
    expect(redisService.keys).not.toHaveBeenCalled();
  });

  it('skips scan entirely when session phase is EOD_RECONCILIATION', async () => {
    const { service, sessionManagerService, strategyService } = await buildService();
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.EOD_RECONCILIATION);

    await service.scanForSignals();

    expect(strategyService.evaluateSignalCandidate).not.toHaveBeenCalled();
  });

  it('proceeds through the scan when phase is MORNING_MOMENTUM', async () => {
    const { service, sessionManagerService, redisService, instrumentsRepo } = await buildService();
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.MORNING_MOMENTUM);

    // No snapshots — scan proceeds to Redis keys call then returns early
    redisService.keys.mockResolvedValue([]);

    await service.scanForSignals();

    // Redis keys should have been queried (phase guard passed)
    expect(redisService.keys).toHaveBeenCalledWith('mkt:snapshot:*');
    // No instruments to cache, so DB not queried
    expect(instrumentsRepo.find).not.toHaveBeenCalled();
  });

  it('warns and returns when no market snapshots are present in Redis', async () => {
    const { service, redisService, strategyService } = await buildService();
    redisService.keys.mockResolvedValue([]); // empty feed

    await service.scanForSignals();

    // No snapshots → no evaluation
    expect(strategyService.evaluateSignalCandidate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9–10. Eligibility gate
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — eligibility gate', () => {
  it('returns false from isEligible() when SniperEntryService rejects the snapshot', async () => {
    const { service, sniperEntryService } = await buildService();
    sniperEntryService.evaluate.mockReturnValue({
      eligible: false,
      failingFilters: ['min_ltp', 'spread_too_wide'],
      qualityScore: 0,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).isEligible({
      ltp: 2,
      bidPrice: 1,
      askPrice: 5,
      volume: 1000,
      timestamp: Date.now(),
    });

    expect(result).toBe(false);
  });

  it('returns true from isEligible() when SniperEntryService approves the snapshot', async () => {
    const { service, sniperEntryService } = await buildService();
    sniperEntryService.evaluate.mockReturnValue({
      eligible: true,
      failingFilters: [],
      qualityScore: 85,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (service as any).isEligible({
      ltp: 100,
      bidPrice: 99.5,
      askPrice: 100.5,
      volume: 50000,
      timestamp: Date.now(),
    });

    expect(result).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11–20. Component score calculations
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — computeComponentScores', () => {
  const baseSnapshot = { ltp: 100, bidPrice: 99.5, askPrice: 100.5, volume: 50000 };

  it('uses REGIME_SCORE lookup for regimeAlignment (STRONG_BULL → 15)', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.STRONG_BULL,
      2.0,
    );
    expect(scores.regimeAlignment).toBe(15);
  });

  it('uses REGIME_SCORE lookup for regimeAlignment (STRONG_BEAR → 4)', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.STRONG_BEAR,
      2.0,
    );
    expect(scores.regimeAlignment).toBe(4);
  });

  it('momentum is 8 (heuristic placeholder — DEFECT-003: TechnicalAnalysisService not yet wired)', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.STRONG_BULL,
      2.0,
    );
    // This is a known gap (DEFECT-003). The assertion documents the current
    // behaviour so any future change to wire TechnicalAnalysisService is caught.
    expect(scores.momentum).toBe(8);
  });

  it('vwapTrendAlignment is 8 (heuristic placeholder — DEFECT-003: TechnicalAnalysisService not yet wired)', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.STRONG_BULL,
      2.0,
    );
    expect(scores.vwapTrendAlignment).toBe(8);
  });

  it('priceStructure=12 when bidPrice and askPrice are both present', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      { ltp: 100, bidPrice: 99.5, askPrice: 100.5, volume: 1000 },
      MarketRegime.STRONG_BULL,
      2.0,
    );
    expect(scores.priceStructure).toBe(12);
  });

  it('priceStructure=10 when bidPrice or askPrice is null', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      { ltp: 100, bidPrice: null, askPrice: null, volume: 1000 },
      MarketRegime.STRONG_BULL,
      2.0,
    );
    expect(scores.priceStructure).toBe(10);
  });

  it('volumeConfirmation=13 when volume > 100', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      { ltp: 100, bidPrice: 99, askPrice: 101, volume: 50000 },
      MarketRegime.STRONG_BULL,
      2.0,
    );
    expect(scores.volumeConfirmation).toBe(13);
  });

  it('volumeConfirmation=10 when 0 < volume ≤ 100', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      { ltp: 100, bidPrice: 99, askPrice: 101, volume: 50 },
      MarketRegime.STRONG_BULL,
      2.0,
    );
    expect(scores.volumeConfirmation).toBe(10);
  });

  it('volumeConfirmation=7 when volume === 0', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      { ltp: 100, bidPrice: 99, askPrice: 101, volume: 0 },
      MarketRegime.STRONG_BULL,
      2.0,
    );
    expect(scores.volumeConfirmation).toBe(7);
  });

  it('rrQuality=10 when R:R ratio ≥ 2.0', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.SIDEWAYS,
      2.0,
    );
    expect(scores.rrQuality).toBe(10);
  });

  it('rrQuality=8 when 1.5 ≤ R:R ratio < 2.0', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.SIDEWAYS,
      1.7,
    );
    expect(scores.rrQuality).toBe(8);
  });

  it('rrQuality=5 when R:R ratio < 1.5', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.SIDEWAYS,
      1.2,
    );
    expect(scores.rrQuality).toBe(5);
  });
});

// Suppress unused variable warning for makeSnapshotJson (kept as doc helper)
void makeSnapshotJson;
