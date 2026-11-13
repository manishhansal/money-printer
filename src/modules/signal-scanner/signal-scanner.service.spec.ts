/**
 * signal-scanner.service.spec.ts
 *
 * Unit tests for SignalScannerService — the cron-based signal scanning pipeline.
 *
 * Coverage (46 tests):
 *
 *  Engine selection (DEFECT-001 regression):
 *   1–4.  buildCandidate engine selection (LIVE/PAPER)
 *
 *  Scan loop phase guards:
 *   5–12. Phase guard tests including AFTERNOON_LATE regression
 *
 *  Eligibility gate:
 *  13–14. SniperEntryService eligibility
 *
 *  Entry condition evaluation (DEFECT-002):
 *  15–21. RSI/VWAP/relVol guards
 *
 *  Directional RSI entry condition (Improvement — RSI ≥ 55 for options):
 *  22.  met=false when RSI < 55 and optionType=CE (option premium not in uptrend)
 *  23.  met=false when RSI < 55 and optionType=PE (same rule applies)
 *  24.  met=true when RSI ≥ 55 and optionType=CE
 *  25.  met=true when RSI ≥ 55 and optionType=PE
 *  26.  met=true when RSI < 55 but optionType is null (original 25–75 guard)
 *
 *  Near-ATM filter (Improvement 1):
 *  27.  isNearATM returns true when no spot price available (graceful fallback)
 *  28.  isNearATM returns true when no strike price (non-option)
 *  29.  isNearATM returns true when |strike − spot| / spot ≤ 10%
 *  30.  isNearATM returns false when |strike − spot| / spot > 10%
 *  31.  isNearATM returns false for NIFTY 17000 strike when spot is 21500
 *
 *  Directional CE/PE selection (Improvement 2):
 *  32.  isDirectionalMatch: CE matches STRONG_BULL
 *  33.  isDirectionalMatch: CE matches WEAK_BULL
 *  34.  isDirectionalMatch: CE matches BREAKOUT
 *  35.  isDirectionalMatch: CE does NOT match STRONG_BEAR
 *  36.  isDirectionalMatch: CE does NOT match SIDEWAYS
 *  37.  isDirectionalMatch: PE matches STRONG_BEAR
 *  38.  isDirectionalMatch: PE matches WEAK_BEAR
 *  39.  isDirectionalMatch: PE matches REVERSAL
 *  40.  isDirectionalMatch: PE does NOT match STRONG_BULL
 *  41.  isDirectionalMatch: null optionType always matches (non-option)
 *
 *  Component scores — regime and snapshot-based (unchanged from v1):
 *  42–46 (renamed from 22–31): same tests
 *
 * All tests use in-memory stubs — no real database, Redis or broker connection.
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
import { CandleQueryService } from '../market-data/candle-query.service';
import { TechnicalAnalysisService } from '../technical-analysis/technical-analysis.service';
import { SignalScannerService, IndicatorSnapshot } from './signal-scanner.service';
import { MarketRegime } from '../market-regime/market-regime.types';
import { SessionPhase } from '../session-manager/session-manager.types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal valid indicator snapshot — represents no candle data available. */
const EMPTY_INDICATORS: IndicatorSnapshot = {
  vwap: null,
  rsi: null,
  atr: null,
  macd: null,
  ema9: null,
  ema21: null,
  relVol: null,
  orb: null,
  candleCount: 0,
};

/** Healthy indicator snapshot — RSI in range, LTP near VWAP, good relative volume. */
function makeHealthyIndicators(ltp: number): IndicatorSnapshot {
  return {
    vwap: ltp * 1.001, // LTP is 0.1% above VWAP
    rsi: 55,
    atr: ltp * 0.005,
    macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
    ema9: ltp * 0.998,
    ema21: ltp * 0.995,
    relVol: 1.2,
    orb: { orbHigh: ltp * 1.01, orbLow: ltp * 0.99, windowMinutes: 15 },
    candleCount: 50,
  };
}

interface MockDeps {
  service: SignalScannerService;
  redisService: { keys: jest.Mock; get: jest.Mock };
  marketRegimeService: { getCurrentRegime: jest.Mock };
  sessionManagerService: { getCurrentPhase: jest.Mock };
  strategyService: { evaluateSignalCandidate: jest.Mock };
  sniperEntryService: { evaluate: jest.Mock };
  liveTradingService: { isArmed: jest.Mock };
  candleQueryService: {
    getTodayCandles: jest.Mock;
    getMultiDayCandles: jest.Mock;
    getRecentCandles: jest.Mock;
  };
  technicalAnalysisService: {
    computeVWAP: jest.Mock;
    computeRSI: jest.Mock;
    computeATR: jest.Mock;
    computeMACD: jest.Mock;
    computeEMA: jest.Mock;
    computeRelativeVolume: jest.Mock;
    computeORBRange: jest.Mock;
    computeSupportResistance: jest.Mock;
  };
  instrumentsRepo: { createQueryBuilder: jest.Mock };
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
  // CandleQueryService — return empty arrays by default (no candle data scenario).
  const candleQueryService = {
    getTodayCandles: jest.fn().mockResolvedValue([]),
    getMultiDayCandles: jest.fn().mockResolvedValue([]),
    getRecentCandles: jest.fn().mockResolvedValue([]),
  };
  // TechnicalAnalysisService — return nulls by default (no data scenario).
  const technicalAnalysisService = {
    computeVWAP: jest.fn().mockReturnValue(null),
    computeRSI: jest.fn().mockReturnValue(null),
    computeATR: jest.fn().mockReturnValue(null),
    computeMACD: jest.fn().mockReturnValue(null),
    computeEMA: jest.fn().mockReturnValue(null),
    computeRelativeVolume: jest.fn().mockReturnValue(null),
    computeORBRange: jest.fn().mockReturnValue(null),
    computeSupportResistance: jest.fn().mockReturnValue(null),
  };
  const instrumentsRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
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
      { provide: CandleQueryService, useValue: candleQueryService },
      { provide: TechnicalAnalysisService, useValue: technicalAnalysisService },
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
    candleQueryService,
    technicalAnalysisService,
    instrumentsRepo,
  };
}

const baseSnapshot = { ltp: 100, bidPrice: 99.5, askPrice: 100.5, volume: 50000 };

// ─────────────────────────────────────────────────────────────────────────────
// 1–4. Engine selection — DEFECT-001 regression
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — engine selection (DEFECT-001 regression)', () => {
  it('sets engine="LIVE" when LiveTradingService.isArmed() returns true', async () => {
    const { service, liveTradingService } = await buildService({ isArmed: true });
    liveTradingService.isArmed.mockReturnValue(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    const candidate = svc.buildCandidate(
      'inst-uuid-1',
      'sec-123',
      { ltp: 100, bidPrice: 99.5, askPrice: 100.5, volume: 50000 },
      MarketRegime.STRONG_BULL,
      false,
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
    );

    liveTradingService.isArmed.mockReturnValue(false);
    const candidatePaper = svc.buildCandidate(
      'inst-1',
      'sec-1',
      { ltp: 100, bidPrice: 99, askPrice: 101, volume: 10000 },
      MarketRegime.STRONG_BULL,
      false,
      EMPTY_INDICATORS,
    );

    expect(candidateLive.engine).toBe('LIVE');
    expect(candidatePaper.engine).toBe('PAPER');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5–12. Scan loop phase guards
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — scan loop phase guards', () => {
  it('skips scan entirely when session phase is CLOSING', async () => {
    const { service, sessionManagerService, strategyService, redisService } = await buildService();
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.CLOSING);
    redisService.keys.mockResolvedValue(['mkt:snapshot:123']);

    await service.scanForSignals();

    expect(strategyService.evaluateSignalCandidate).not.toHaveBeenCalled();
    expect(redisService.keys).not.toHaveBeenCalled();
  });

  it('skips scan entirely when session phase is EOD_RECONCILIATION', async () => {
    const { service, sessionManagerService, strategyService } = await buildService();
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.EOD_RECONCILIATION);

    await service.scanForSignals();

    expect(strategyService.evaluateSignalCandidate).not.toHaveBeenCalled();
  });

  it('proceeds through the scan when phase is MORNING_MOMENTUM', async () => {
    const { service, sessionManagerService, redisService } = await buildService();
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.MORNING_MOMENTUM);
    redisService.keys.mockResolvedValue([]);

    await service.scanForSignals();

    expect(redisService.keys).toHaveBeenCalledWith('mkt:snapshot:*');
  });

  it('warns and returns when no market snapshots are present in Redis', async () => {
    const { service, redisService, strategyService } = await buildService();
    redisService.keys.mockResolvedValue([]);

    await service.scanForSignals();

    expect(strategyService.evaluateSignalCandidate).not.toHaveBeenCalled();
  });

  it(
    'AFTERNOON_LATE proceeds through the scan (14:30–15:00 regression — RCA-005: ' +
      'entries were previously blocked in this window when CLOSING started at 14:30)',
    async () => {
      const { service, sessionManagerService, redisService } = await buildService();
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.AFTERNOON_LATE);
      redisService.keys.mockResolvedValue([]);

      await service.scanForSignals();

      expect(redisService.keys).toHaveBeenCalledWith('mkt:snapshot:*');
    },
  );

  it('skips scan when phase is PRE_MARKET (before market open)', async () => {
    const { service, sessionManagerService, strategyService } = await buildService();
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.PRE_MARKET);

    await service.scanForSignals();

    expect(strategyService.evaluateSignalCandidate).not.toHaveBeenCalled();
  });

  it('skips scan when phase is MARKET_CLOSED (overnight / holiday)', async () => {
    const { service, sessionManagerService, strategyService } = await buildService();
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.MARKET_CLOSED);

    await service.scanForSignals();

    expect(strategyService.evaluateSignalCandidate).not.toHaveBeenCalled();
  });

  it('CLOSING phase does NOT proceed (entries blocked from 15:00 IST, not 14:30)', async () => {
    const { service, sessionManagerService, redisService } = await buildService();
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.CLOSING);
    redisService.keys.mockResolvedValue(['mkt:snapshot:123']);

    await service.scanForSignals();

    expect(redisService.keys).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13–14. Eligibility gate
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
    });

    expect(result).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15–21. Entry condition evaluation — DEFECT-002 regression
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — entry conditions (DEFECT-002 regression)', () => {
  it('met=true when no candle data (graceful fallback — same as old behaviour)', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(100, EMPTY_INDICATORS);
    expect(result.met).toBe(true);
  });

  it('met=false when RSI < 25 (deeply oversold extreme)', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(100, {
      ...EMPTY_INDICATORS,
      rsi: 20,
      candleCount: 25,
    });
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/RSI.*25.*oversold/i);
  });

  it('met=false when RSI > 75 (deeply overbought extreme)', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(100, {
      ...EMPTY_INDICATORS,
      rsi: 80,
      candleCount: 25,
    });
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/RSI.*75.*overbought/i);
  });

  it('met=true when RSI is in the valid 25–75 range', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(100, {
      ...EMPTY_INDICATORS,
      rsi: 55,
      candleCount: 25,
    });
    expect(result.met).toBe(true);
  });

  it('met=false when LTP is more than 15% above VWAP', async () => {
    const { service } = await buildService();
    const vwap = 80; // LTP=100 is 25% above VWAP=80
    const result = service.evaluateEntryConditions(100, {
      ...EMPTY_INDICATORS,
      vwap,
      candleCount: 25,
    });
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/VWAP/i);
  });

  it('met=false when relative volume < 0.2 (critically low)', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(100, {
      ...EMPTY_INDICATORS,
      relVol: 0.1,
      candleCount: 25,
    });
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/relative volume/i);
  });

  it('met=true when all indicators are healthy', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(100, makeHealthyIndicators(100));
    expect(result.met).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 22–31. Component scores — regime and snapshot-based (unchanged logic)
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — computeComponentScores (snapshot-based)', () => {
  it('uses REGIME_SCORE lookup for regimeAlignment (STRONG_BULL → 15)', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.STRONG_BULL,
      2.0,
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
    );
    expect(scores.regimeAlignment).toBe(4);
  });

  it('priceStructure=12 when bidPrice and askPrice are both present', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      { ltp: 100, bidPrice: 99.5, askPrice: 100.5, volume: 1000 },
      MarketRegime.STRONG_BULL,
      2.0,
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
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
      EMPTY_INDICATORS,
    );
    expect(scores.rrQuality).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 32–37. Indicator-driven scores — DEFECT-003 regression
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — computeComponentScores (indicator-driven, DEFECT-003 fix)', () => {
  it('momentum=8 (neutral fallback) when no indicator data available', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.STRONG_BULL,
      2.0,
      EMPTY_INDICATORS,
    );
    expect(scores.momentum).toBe(8);
  });

  it('momentum=15 when RSI is in 60–75 range (strong bullish momentum)', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.STRONG_BULL,
      2.0,
      { ...EMPTY_INDICATORS, rsi: 65, candleCount: 25 },
    );
    expect(scores.momentum).toBe(15);
  });

  it('momentum=9 when RSI is in 40–50 range (neutral)', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.STRONG_BULL,
      2.0,
      { ...EMPTY_INDICATORS, rsi: 45, candleCount: 25 },
    );
    expect(scores.momentum).toBe(9);
  });

  it('vwapTrendAlignment=8 (neutral fallback) when no VWAP data available', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      baseSnapshot,
      MarketRegime.STRONG_BULL,
      2.0,
      EMPTY_INDICATORS,
    );
    expect(scores.vwapTrendAlignment).toBe(8);
  });

  it('vwapTrendAlignment=15 when LTP is ≥ 0.5% above VWAP (bullish)', async () => {
    const { service } = await buildService();
    const ltp = 100.6; // 0.6% above VWAP=100
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      { ...baseSnapshot, ltp },
      MarketRegime.STRONG_BULL,
      2.0,
      { ...EMPTY_INDICATORS, vwap: 100, candleCount: 25 },
    );
    expect(scores.vwapTrendAlignment).toBe(15);
  });

  it('vwapTrendAlignment=6 when LTP is ≥ 0.5% below VWAP (bearish)', async () => {
    const { service } = await buildService();
    const ltp = 99.4; // 0.6% below VWAP=100
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = (service as any).computeComponentScores(
      { ...baseSnapshot, ltp },
      MarketRegime.STRONG_BULL,
      2.0,
      { ...EMPTY_INDICATORS, vwap: 100, candleCount: 25 },
    );
    expect(scores.vwapTrendAlignment).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 22–26. Directional RSI entry condition (Improvement — RSI ≥ 55 for options)
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — directional RSI entry condition (Improvement)', () => {
  it('met=false when RSI < 55 and optionType=CE (option premium not in uptrend)', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(
      100,
      { ...EMPTY_INDICATORS, rsi: 50, candleCount: 25 },
      'CE',
    );
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/RSI.*55.*uptrend/i);
  });

  it('met=false when RSI < 55 and optionType=PE (same uptrend rule applies)', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(
      100,
      { ...EMPTY_INDICATORS, rsi: 45, candleCount: 25 },
      'PE',
    );
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/RSI.*55/);
  });

  it('met=true when RSI ≥ 55 and optionType=CE (CE premium in uptrend)', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(
      100,
      { ...EMPTY_INDICATORS, rsi: 62, candleCount: 25 },
      'CE',
    );
    expect(result.met).toBe(true);
  });

  it('met=true when RSI ≥ 55 and optionType=PE (PE premium in uptrend)', async () => {
    const { service } = await buildService();
    const result = service.evaluateEntryConditions(
      100,
      { ...EMPTY_INDICATORS, rsi: 58, candleCount: 25 },
      'PE',
    );
    expect(result.met).toBe(true);
  });

  it('met=true when RSI=50 and optionType is null (original 25–75 guard applies)', async () => {
    const { service } = await buildService();
    // No optionType → uses original DEFECT-002 guard (RSI 25–75), RSI=50 passes
    const result = service.evaluateEntryConditions(
      100,
      { ...EMPTY_INDICATORS, rsi: 50, candleCount: 25 },
      null,
    );
    expect(result.met).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 27–31. Near-ATM filter — Improvement 1
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — near-ATM filter (Improvement 1)', () => {
  it('isNearATM returns true when no spot price is cached for the underlying', async () => {
    const { service } = await buildService();
    // spotPriceCache is empty → graceful fallback, all strikes pass
    const result = service.isNearATM(21000, 'NIFTY');
    expect(result).toBe(true);
  });

  it('isNearATM returns true when strikePrice is null (non-option instrument)', async () => {
    const { service } = await buildService();
    const result = service.isNearATM(null, 'NIFTY');
    expect(result).toBe(true);
  });

  it('isNearATM returns true when |strike − spot| / spot ≤ 10%', async () => {
    const { service } = await buildService();
    // Inject spot price into the private cache
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).spotPriceCache.set('NIFTY', 21500);
    // |21000 − 21500| / 21500 = 2.3% — within 10%
    expect(service.isNearATM(21000, 'NIFTY')).toBe(true);
    // |22000 − 21500| / 21500 = 2.3% — within 10%
    expect(service.isNearATM(22000, 'NIFTY')).toBe(true);
  });

  it('isNearATM returns false when |strike − spot| / spot > 10%', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).spotPriceCache.set('NIFTY', 21500);
    // |18000 − 21500| / 21500 = 16.3% — exceeds 10%
    expect(service.isNearATM(18000, 'NIFTY')).toBe(false);
  });

  it('isNearATM returns false for NIFTY 17000 strike when spot is 21500 (deep OTM)', async () => {
    const { service } = await buildService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).spotPriceCache.set('NIFTY', 21500);
    // |17000 − 21500| / 21500 = 20.9% — this was the worst performer in simulation
    expect(service.isNearATM(17000, 'NIFTY')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 32–41. Directional CE/PE selection — Improvement 2
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalScannerService — directional CE/PE selection (Improvement 2)', () => {
  it('CE matches STRONG_BULL regime', async () => {
    const { service } = await buildService();
    expect(service.isDirectionalMatch('CE', MarketRegime.STRONG_BULL)).toBe(true);
  });

  it('CE matches WEAK_BULL regime', async () => {
    const { service } = await buildService();
    expect(service.isDirectionalMatch('CE', MarketRegime.WEAK_BULL)).toBe(true);
  });

  it('CE matches BREAKOUT regime (most breakouts are upside)', async () => {
    const { service } = await buildService();
    expect(service.isDirectionalMatch('CE', MarketRegime.BREAKOUT)).toBe(true);
  });

  it('CE does NOT match STRONG_BEAR (buying CE in bear market is countertrend)', async () => {
    const { service } = await buildService();
    expect(service.isDirectionalMatch('CE', MarketRegime.STRONG_BEAR)).toBe(false);
  });

  it('CE does NOT match SIDEWAYS (no directional edge — time decay wins)', async () => {
    const { service } = await buildService();
    expect(service.isDirectionalMatch('CE', MarketRegime.SIDEWAYS)).toBe(false);
  });

  it('PE matches STRONG_BEAR regime', async () => {
    const { service } = await buildService();
    expect(service.isDirectionalMatch('PE', MarketRegime.STRONG_BEAR)).toBe(true);
  });

  it('PE matches WEAK_BEAR regime', async () => {
    const { service } = await buildService();
    expect(service.isDirectionalMatch('PE', MarketRegime.WEAK_BEAR)).toBe(true);
  });

  it('PE matches REVERSAL regime (reversals follow bull runs)', async () => {
    const { service } = await buildService();
    expect(service.isDirectionalMatch('PE', MarketRegime.REVERSAL)).toBe(true);
  });

  it('PE does NOT match STRONG_BULL (buying PE in bull market is countertrend)', async () => {
    const { service } = await buildService();
    expect(service.isDirectionalMatch('PE', MarketRegime.STRONG_BULL)).toBe(false);
  });

  it('null optionType (non-option) always passes directional check', async () => {
    const { service } = await buildService();
    // Futures, underlying indices — not affected by CE/PE directional rule
    expect(service.isDirectionalMatch(null, MarketRegime.STRONG_BULL)).toBe(true);
    expect(service.isDirectionalMatch(null, MarketRegime.SIDEWAYS)).toBe(true);
    expect(service.isDirectionalMatch(null, MarketRegime.STRONG_BEAR)).toBe(true);
  });
});
