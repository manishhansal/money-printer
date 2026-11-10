/**
 * Unit tests for OpportunityRankingService.
 *
 * Coverage:
 *   - Correct ordering by composite score, then expected value, then regime
 *     alignment strength (all descending)
 *   - Natural-language explanations contain the right fields
 *   - Empty active-signal list returns an empty array
 *   - Zero R:R (entry = stop) sets expectedValue to 0 without throwing
 *   - computeRrRatio and computeRegimeAlignmentStrength helpers
 *   - buildExplanation helper for all regime alignment states
 *
 * Requirements: 20.1
 */

import { Repository } from 'typeorm';
import {
  OpportunityRankingService,
  computeRrRatio,
  computeRegimeAlignmentStrength,
  buildExplanation,
} from './opportunity-ranking.service';
import { Signals } from '../../database/entities/signals.entity';
import { Instruments } from '../../database/entities/instruments.entity';

// ─── Mock repository factory ──────────────────────────────────────────────────

function buildMockSignalsRepo(): jest.Mocked<Pick<Repository<Signals>, 'find'>> {
  return { find: jest.fn() };
}

function buildMockInstrumentsRepo(): jest.Mocked<Pick<Repository<Instruments>, 'find'>> {
  return { find: jest.fn() };
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function buildSignal(overrides: Partial<Signals> = {}): Signals {
  return {
    id: 'sig-001',
    status: 'active',
    compositeScore: '90',
    entryPrice: '100.00',
    stopLossPrice: '95.00',
    targetPrice: '110.00',
    positionSize: 1,
    instrumentId: 'instr-001',
    strategyId: 'strat-001',
    engine: 'LIVE',
    direction: 'BUY',
    scoreRegimeAlignment: '15',
    scorePriceStructure: '15',
    scoreVolumeConfirmation: '15',
    scoreMomentum: '10',
    scoreVwapTrend: '10',
    scoreOptionsFutures: '15',
    scoreLiquidityExecution: '10',
    scoreRrQuality: '0',
    measuredInputs: {},
    regime: 'STRONG_BULL',
    dhanOrderId: null,
    rejectionReason: null,
    signalTimestamp: new Date(),
    expiryTimestamp: new Date(Date.now() + 300_000),
    createdAt: new Date(),
    strategy: { id: 'strat-001', code: 'A' } as any,
    ...overrides,
  } as Signals;
}

function buildInstrument(id: string, tradingSymbol: string): Instruments {
  return { id, tradingSymbol } as Instruments;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OpportunityRankingService', () => {
  let service: OpportunityRankingService;
  let signalsRepo: ReturnType<typeof buildMockSignalsRepo>;
  let instrumentsRepo: ReturnType<typeof buildMockInstrumentsRepo>;

  beforeEach(() => {
    signalsRepo = buildMockSignalsRepo();
    instrumentsRepo = buildMockInstrumentsRepo();
    service = new OpportunityRankingService(
      signalsRepo as unknown as Repository<Signals>,
      instrumentsRepo as unknown as Repository<Instruments>,
    );
  });

  // ─── Empty list ──────────────────────────────────────────────────────────

  it('returns an empty array when there are no active signals', async () => {
    signalsRepo.find.mockResolvedValue([]);
    const result = await service.rankActiveSignals('STRONG_BULL');
    expect(result).toEqual([]);
    expect(instrumentsRepo.find).not.toHaveBeenCalled();
  });

  // ─── Ranking by composite score (primary) ───────────────────────────────

  it('ranks signals by compositeScore descending as the primary criterion', async () => {
    const low = buildSignal({
      id: 'sig-low',
      compositeScore: '82',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '110.00',
      regime: 'STRONG_BULL',
    });
    const high = buildSignal({
      id: 'sig-high',
      compositeScore: '95',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '110.00',
      regime: 'STRONG_BULL',
    });
    const mid = buildSignal({
      id: 'sig-mid',
      compositeScore: '88',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '110.00',
      regime: 'STRONG_BULL',
    });

    signalsRepo.find.mockResolvedValue([low, high, mid]);
    instrumentsRepo.find.mockResolvedValue([]);

    const result = await service.rankActiveSignals('STRONG_BULL');

    expect(result[0].signal.id).toBe('sig-high');
    expect(result[0].rank).toBe(1);
    expect(result[1].signal.id).toBe('sig-mid');
    expect(result[1].rank).toBe(2);
    expect(result[2].signal.id).toBe('sig-low');
    expect(result[2].rank).toBe(3);
  });

  // ─── Ranking by expected value (secondary) ──────────────────────────────

  it('breaks compositeScore ties using expectedValue descending', async () => {
    // Both signals have compositeScore = 85.
    // sig-highEV: entry=100, stop=95, target=110 → R:R=2.0 → EV=85*(2/3)=56.7
    // sig-lowEV:  entry=100, stop=95, target=107 → R:R=1.4 → EV=85*(1.4/2.4)=49.6
    const highEV = buildSignal({
      id: 'sig-highEV',
      compositeScore: '85',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '110.00',
      regime: 'TRENDING',
    });
    const lowEV = buildSignal({
      id: 'sig-lowEV',
      compositeScore: '85',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '107.00',
      regime: 'TRENDING',
    });

    signalsRepo.find.mockResolvedValue([lowEV, highEV]);
    instrumentsRepo.find.mockResolvedValue([]);

    const result = await service.rankActiveSignals('TRENDING');

    expect(result[0].signal.id).toBe('sig-highEV');
    expect(result[0].rank).toBe(1);
    expect(result[1].signal.id).toBe('sig-lowEV');
    expect(result[1].rank).toBe(2);

    // EV values are correct
    expect(result[0].expectedValue).toBeCloseTo(56.67, 1);
    expect(result[1].expectedValue).toBeCloseTo(49.58, 1);
  });

  // ─── Ranking by regime alignment strength (tertiary) ────────────────────

  it('breaks compositeScore + expectedValue ties using regimeAlignmentStrength descending', async () => {
    // Both signals identical prices → same EV.  sig-aligned regime matches, sig-mismatch does not.
    const aligned = buildSignal({
      id: 'sig-aligned',
      compositeScore: '85',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '110.00',
      regime: 'TRENDING',
    });
    const mismatched = buildSignal({
      id: 'sig-mismatch',
      compositeScore: '85',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '110.00',
      regime: 'SIDEWAYS',
    });

    signalsRepo.find.mockResolvedValue([mismatched, aligned]);
    instrumentsRepo.find.mockResolvedValue([]);

    const result = await service.rankActiveSignals('TRENDING');

    expect(result[0].signal.id).toBe('sig-aligned');
    expect(result[0].regimeAlignmentStrength).toBe(3);
    expect(result[1].signal.id).toBe('sig-mismatch');
    expect(result[1].regimeAlignmentStrength).toBe(0);
  });

  // ─── All three criteria together ─────────────────────────────────────────

  it('applies all three sort criteria in the correct priority order', async () => {
    // #1 expected: highest compositeScore
    // #2 expected: tied compositeScore, higher EV
    // #3 expected: tied compositeScore + EV, better regime alignment
    // #4 expected: lowest on all criteria

    const rank1 = buildSignal({
      id: 'rank1',
      compositeScore: '95',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '110.00',
      regime: 'TRENDING',
    });
    const rank2 = buildSignal({
      id: 'rank2',
      compositeScore: '85',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '110.00',
      regime: 'TRENDING',
    });
    const rank3 = buildSignal({
      id: 'rank3',
      compositeScore: '85',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '107.00',
      regime: 'TRENDING',
    });
    const rank4 = buildSignal({
      id: 'rank4',
      compositeScore: '82',
      entryPrice: '100.00',
      stopLossPrice: '95.00',
      targetPrice: '110.00',
      regime: 'SIDEWAYS',
    });

    // rank2 and rank3 have same compositeScore=85 but different EVs (rank2 > rank3).
    signalsRepo.find.mockResolvedValue([rank3, rank1, rank4, rank2]);
    instrumentsRepo.find.mockResolvedValue([]);

    const result = await service.rankActiveSignals('TRENDING');

    expect(result.map((r) => r.signal.id)).toEqual(['rank1', 'rank2', 'rank3', 'rank4']);
    result.forEach((r, i) => expect(r.rank).toBe(i + 1));
  });

  // ─── Zero R:R safety ─────────────────────────────────────────────────────

  it('sets expectedValue to 0 when entry equals stop (zero risk) without throwing', async () => {
    const zeroRisk = buildSignal({
      id: 'sig-zerorisk',
      compositeScore: '85',
      entryPrice: '100.00',
      stopLossPrice: '100.00', // entry = stop → risk = 0
      targetPrice: '110.00',
      regime: null,
    });

    signalsRepo.find.mockResolvedValue([zeroRisk]);
    instrumentsRepo.find.mockResolvedValue([]);

    const result = await service.rankActiveSignals();

    expect(result).toHaveLength(1);
    expect(result[0].expectedValue).toBe(0);
    expect(result[0].rank).toBe(1);
  });

  // ─── Instrument symbol in explanation ───────────────────────────────────

  it('includes the instrument trading symbol in the explanation when available', async () => {
    const signal = buildSignal({ id: 'sig-001', instrumentId: 'instr-001', regime: 'STRONG_BULL' });

    signalsRepo.find.mockResolvedValue([signal]);
    instrumentsRepo.find.mockResolvedValue([buildInstrument('instr-001', 'NIFTY24JAN21000CE')]);

    const result = await service.rankActiveSignals('STRONG_BULL');

    expect(result[0].explanation).toContain('NIFTY24JAN21000CE');
  });

  it('omits the trading symbol gracefully when instrument lookup returns nothing', async () => {
    const signal = buildSignal({
      id: 'sig-001',
      instrumentId: 'instr-unknown',
      regime: 'STRONG_BULL',
    });

    signalsRepo.find.mockResolvedValue([signal]);
    instrumentsRepo.find.mockResolvedValue([]); // no match

    const result = await service.rankActiveSignals('STRONG_BULL');

    expect(result[0].explanation).toContain('#1:');
    expect(result[0].explanation).toContain('Score');
    // Should not throw and should produce a usable explanation
    expect(result[0].explanation.length).toBeGreaterThan(20);
  });

  // ─── Explanation content ─────────────────────────────────────────────────

  it('explanation contains rank, score, EV, regime status, direction, entry price, and R:R', async () => {
    const signal = buildSignal({
      id: 'sig-001',
      compositeScore: '90',
      entryPrice: '19500.00',
      stopLossPrice: '19000.00',
      targetPrice: '20500.00',
      direction: 'BUY',
      regime: 'STRONG_BULL',
      strategy: { id: 'strat-001', code: 'A' } as any,
    });

    signalsRepo.find.mockResolvedValue([signal]);
    instrumentsRepo.find.mockResolvedValue([buildInstrument('instr-001', 'NIFTY24JAN21000CE')]);

    const [ranked] = await service.rankActiveSignals('STRONG_BULL');

    expect(ranked.explanation).toContain('#1');
    expect(ranked.explanation).toContain('90/100');
    expect(ranked.explanation).toContain('STRONG_BULL');
    expect(ranked.explanation).toContain('aligned');
    expect(ranked.explanation).toContain('Strategy A');
    expect(ranked.explanation).toContain('BUY');
    expect(ranked.explanation).toContain('₹19500.00');
    expect(ranked.explanation).toContain('R:R 2.0');
  });

  it('explanation contains "mismatch" when signal regime differs from current regime', async () => {
    const signal = buildSignal({ regime: 'BREAKOUT', compositeScore: '85' });

    signalsRepo.find.mockResolvedValue([signal]);
    instrumentsRepo.find.mockResolvedValue([]);

    const [ranked] = await service.rankActiveSignals('SIDEWAYS');

    expect(ranked.explanation).toContain('mismatch');
    expect(ranked.explanation).toContain('SIDEWAYS');
    expect(ranked.explanation).toContain('Lower priority due to regime mismatch');
  });

  it('explanation contains "no current regime" when currentRegime is not supplied', async () => {
    const signal = buildSignal({ regime: 'TRENDING', compositeScore: '85' });

    signalsRepo.find.mockResolvedValue([signal]);
    instrumentsRepo.find.mockResolvedValue([]);

    const [ranked] = await service.rankActiveSignals(); // no currentRegime

    expect(ranked.explanation).toContain('no current regime');
    expect(ranked.regimeAlignmentStrength).toBe(2);
  });
});

// ─── Helper function unit tests ───────────────────────────────────────────────

describe('computeRrRatio()', () => {
  it('computes 2.0 for a BUY signal (entry=100, stop=95, target=110)', () => {
    expect(computeRrRatio('100', '95', '110')).toBeCloseTo(2.0);
  });

  it('computes 2.0 for a SELL signal (entry=100, stop=105, target=90)', () => {
    expect(computeRrRatio('100', '105', '90')).toBeCloseTo(2.0);
  });

  it('returns 0 when entry equals stop (division by zero guard)', () => {
    expect(computeRrRatio('100', '100', '110')).toBe(0);
  });

  it('handles decimal string prices', () => {
    // 5.0 / 2.5 = 2.0
    expect(computeRrRatio('100.50', '98.00', '105.50')).toBeCloseTo(2.0);
  });
});

describe('computeRegimeAlignmentStrength()', () => {
  it('returns 3 when signal regime matches current regime', () => {
    expect(computeRegimeAlignmentStrength('STRONG_BULL', 'STRONG_BULL')).toBe(3);
  });

  it('returns 2 when currentRegime is undefined', () => {
    expect(computeRegimeAlignmentStrength('TRENDING', undefined)).toBe(2);
  });

  it('returns 1 when signal has no stored regime', () => {
    expect(computeRegimeAlignmentStrength(null, 'TRENDING')).toBe(1);
    expect(computeRegimeAlignmentStrength(undefined, 'TRENDING')).toBe(1);
  });

  it('returns 0 when both regimes are set but differ', () => {
    expect(computeRegimeAlignmentStrength('BREAKOUT', 'SIDEWAYS')).toBe(0);
  });
});

describe('buildExplanation()', () => {
  const baseSignal = {
    id: 'sig-001',
    direction: 'BUY',
    entryPrice: '100.00',
    regime: 'STRONG_BULL',
    strategy: { code: 'A' },
  } as unknown as Signals;

  it('formats aligned regime explanation correctly', () => {
    const result = buildExplanation({
      rank: 1,
      compositeScore: 92,
      expectedValue: 61.3,
      regimeAlignmentStrength: 3,
      rrRatio: 2.0,
      signal: baseSignal,
      tradingSymbol: 'NIFTY24JAN21000CE',
      currentRegime: 'STRONG_BULL',
    });

    expect(result).toMatch(/^#1:/);
    expect(result).toContain('Score 92/100');
    expect(result).toContain('EV 61.3');
    expect(result).toContain('STRONG_BULL (aligned)');
    expect(result).toContain('Strategy A');
    expect(result).toContain('BUY NIFTY24JAN21000CE');
    expect(result).toContain('₹100.00');
    expect(result).toContain('R:R 2.0');
    expect(result).toContain('High composite score with strong regime alignment.');
  });

  it('formats mismatch regime explanation correctly', () => {
    const mismatchSignal = { ...baseSignal, regime: 'BREAKOUT' } as Signals;
    const result = buildExplanation({
      rank: 3,
      compositeScore: 85,
      expectedValue: 42.5,
      regimeAlignmentStrength: 0,
      rrRatio: 1.5,
      signal: mismatchSignal,
      tradingSymbol: undefined,
      currentRegime: 'SIDEWAYS',
    });

    expect(result).toMatch(/^#3:/);
    expect(result).toContain('BREAKOUT (mismatch — current: SIDEWAYS)');
    expect(result).toContain('Lower priority due to regime mismatch.');
  });

  it('formats no-current-regime explanation correctly', () => {
    const result = buildExplanation({
      rank: 2,
      compositeScore: 88,
      expectedValue: 50.0,
      regimeAlignmentStrength: 2,
      rrRatio: 1.8,
      signal: baseSignal,
      tradingSymbol: undefined,
      currentRegime: undefined,
    });

    expect(result).toContain('no current regime');
    expect(result).toContain('Composite score used for ranking; regime alignment unverifiable.');
  });

  it('formats no-signal-regime explanation correctly', () => {
    const noRegimeSignal = { ...baseSignal, regime: null } as unknown as Signals;
    const result = buildExplanation({
      rank: 4,
      compositeScore: 81,
      expectedValue: 30.0,
      regimeAlignmentStrength: 1,
      rrRatio: 1.2,
      signal: noRegimeSignal,
      tradingSymbol: undefined,
      currentRegime: 'TRENDING',
    });

    expect(result).toContain('Regime none');
    expect(result).toContain(
      'No regime stored on signal; ranked by composite score and expected value.',
    );
  });

  it('rounds compositeScore to nearest integer in explanation', () => {
    const result = buildExplanation({
      rank: 1,
      compositeScore: 92.7,
      expectedValue: 55.0,
      regimeAlignmentStrength: 3,
      rrRatio: 2.0,
      signal: baseSignal,
      tradingSymbol: undefined,
      currentRegime: 'STRONG_BULL',
    });

    expect(result).toContain('Score 93/100');
  });
});
