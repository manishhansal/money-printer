/**
 * trailing-stop.service.spec.ts
 *
 * Unit tests for TrailingStopService — all 8 trailing stop mechanisms.
 *
 * Requirements: 12.1, 12.6
 */

import { TrailingStopService } from './trailing-stop.service';
import {
  AtrBasedConfig,
  ChandelierExitConfig,
  PartialProfitConfig,
  PercentageBasedConfig,
  StructureBasedConfig,
  SwingHighLowConfig,
  TimeBasedConfig,
  TrailingStopMarketData,
  TrailingStopMechanism,
  TrailingStopPosition,
  VolatilityAdjustedConfig,
} from './trailing-stop.types';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildService(): TrailingStopService {
  return new TrailingStopService();
}

function buildMarketData(overrides: Partial<TrailingStopMarketData> = {}): TrailingStopMarketData {
  return {
    currentPrice: 100,
    atr: 5,
    swingHighs: [112, 110, 108, 105],
    swingLows: [88, 90, 92, 95],
    ivRegime: 'NEUTRAL',
    supportLevels: [95, 90, 85, 80],
    resistanceLevels: [105, 110, 115, 120],
    highestHigh: 115,
    lowestLow: 85,
    ...overrides,
  };
}

function buildLongPosition(overrides: Partial<TrailingStopPosition> = {}): TrailingStopPosition {
  return {
    entryPrice: '95.00',
    currentStopLoss: '88.00',
    direction: 'LONG',
    quantity: 100,
    ...overrides,
  };
}

function buildShortPosition(overrides: Partial<TrailingStopPosition> = {}): TrailingStopPosition {
  return {
    entryPrice: '105.00',
    currentStopLoss: '112.00',
    direction: 'SHORT',
    quantity: 100,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ATR-based
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — ATR-based (Mechanism 1)', () => {
  const svc = buildService();
  const config: AtrBasedConfig = {
    mechanism: TrailingStopMechanism.ATR_BASED,
    multiplier: 2,
  };

  it('LONG: newSL = entryPrice − (atr × multiplier)', () => {
    // entryPrice=95, atr=5, mult=2 → 95 - 10 = 85.00
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '95.00' }),
      config,
      buildMarketData({ atr: 5 }),
    );
    expect(result.newStopLoss).toBe('85.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.ATR_BASED);
  });

  it('SHORT: newSL = entryPrice + (atr × multiplier)', () => {
    // entryPrice=105, atr=5, mult=2 → 105 + 10 = 115.00
    const result = svc.computeTrailingStop(
      buildShortPosition({ entryPrice: '105.00' }),
      config,
      buildMarketData({ atr: 5 }),
    );
    expect(result.newStopLoss).toBe('115.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.ATR_BASED);
  });

  it('LONG: shouldExit = false when currentPrice is above existingStopLoss', () => {
    // currentPrice=100, existingSL=88 → 100 > 88 → no exit
    const result = svc.computeTrailingStop(
      buildLongPosition({ currentStopLoss: '88.00' }),
      config,
      buildMarketData({ currentPrice: 100 }),
    );
    expect(result.shouldExit).toBe(false);
  });

  it('LONG: shouldExit = true when currentPrice falls to existingStopLoss', () => {
    // currentPrice=88, existingSL=88 → 88 ≤ 88 → exit
    const result = svc.computeTrailingStop(
      buildLongPosition({ currentStopLoss: '88.00' }),
      config,
      buildMarketData({ currentPrice: 88 }),
    );
    expect(result.shouldExit).toBe(true);
  });

  it('SHORT: shouldExit = true when currentPrice rises to existingStopLoss', () => {
    // currentPrice=112, existingSL=112 → 112 ≥ 112 → exit
    const result = svc.computeTrailingStop(
      buildShortPosition({ currentStopLoss: '112.00' }),
      config,
      buildMarketData({ currentPrice: 112 }),
    );
    expect(result.shouldExit).toBe(true);
  });

  it('uses fractional multiplier correctly', () => {
    // entryPrice=200, atr=10, mult=1.5 → 200 - 15 = 185.00
    const cfg: AtrBasedConfig = { mechanism: TrailingStopMechanism.ATR_BASED, multiplier: 1.5 };
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '200.00' }),
      cfg,
      buildMarketData({ atr: 10 }),
    );
    expect(result.newStopLoss).toBe('185.00');
  });

  it('returns a valid TrailingStopResult shape', () => {
    const result = svc.computeTrailingStop(buildLongPosition(), config, buildMarketData());
    expect(result).toMatchObject({
      newStopLoss: expect.any(String),
      shouldExit: expect.any(Boolean),
      mechanism: TrailingStopMechanism.ATR_BASED,
    });
    expect(result.exitQuantity).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Swing High/Low
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — Swing High/Low (Mechanism 2)', () => {
  const svc = buildService();
  const config: SwingHighLowConfig = {
    mechanism: TrailingStopMechanism.SWING_HIGH_LOW,
    lookbackBars: 3,
    buffer: 2,
  };

  it('LONG: newSL = min of lookbackBars recent swing lows − buffer', () => {
    // swingLows=[88,90,92,95], lookback=3 → min(88,90,92)=88, buffer=2 → 86.00
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({ swingLows: [88, 90, 92, 95] }),
    );
    expect(result.newStopLoss).toBe('86.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.SWING_HIGH_LOW);
  });

  it('SHORT: newSL = max of lookbackBars recent swing highs + buffer', () => {
    // swingHighs=[112,110,108,105], lookback=3 → max(112,110,108)=112, buffer=2 → 114.00
    const result = svc.computeTrailingStop(
      buildShortPosition(),
      config,
      buildMarketData({ swingHighs: [112, 110, 108, 105] }),
    );
    expect(result.newStopLoss).toBe('114.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.SWING_HIGH_LOW);
  });

  it('LONG: falls back to currentPrice − buffer when no swingLows provided', () => {
    // No swing data → currentPrice(100) - buffer(2) = 98.00
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({ swingLows: [], currentPrice: 100 }),
    );
    expect(result.newStopLoss).toBe('98.00');
  });

  it('respects lookbackBars — does not use bars beyond the window', () => {
    // swingLows=[88,90,92,70], lookback=3 → uses only [88,90,92], min=88, SL=88-2=86
    // The 70 at index 3 is excluded because lookbackBars=3
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({ swingLows: [88, 90, 92, 70] }),
    );
    expect(result.newStopLoss).toBe('86.00');
  });

  it('returns a valid TrailingStopResult shape', () => {
    const result = svc.computeTrailingStop(buildLongPosition(), config, buildMarketData());
    expect(result).toMatchObject({
      newStopLoss: expect.any(String),
      shouldExit: expect.any(Boolean),
      mechanism: TrailingStopMechanism.SWING_HIGH_LOW,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Chandelier Exit
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — Chandelier Exit (Mechanism 3)', () => {
  const svc = buildService();
  const config: ChandelierExitConfig = {
    mechanism: TrailingStopMechanism.CHANDELIER_EXIT,
    period: 3,
    multiplier: 2,
  };

  it('LONG: newSL = highestHigh − (atr × multiplier) using provided highestHigh', () => {
    // highestHigh=120, atr=5, mult=2 → 120 - 10 = 110.00
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({ highestHigh: 120, atr: 5 }),
    );
    expect(result.newStopLoss).toBe('110.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.CHANDELIER_EXIT);
  });

  it('SHORT: newSL = lowestLow + (atr × multiplier) using provided lowestLow', () => {
    // lowestLow=80, atr=5, mult=2 → 80 + 10 = 90.00
    const result = svc.computeTrailingStop(
      buildShortPosition(),
      config,
      buildMarketData({ lowestLow: 80, atr: 5 }),
    );
    expect(result.newStopLoss).toBe('90.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.CHANDELIER_EXIT);
  });

  it('LONG: derives highestHigh from swingHighs when not explicitly provided', () => {
    // swingHighs=[112,110,108,105], period=3 → max(112,110,108)=112, atr=5, mult=2 → 112-10=102.00
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({
        swingHighs: [112, 110, 108, 105],
        atr: 5,
        highestHigh: undefined,
        lowestLow: undefined,
      }),
    );
    expect(result.newStopLoss).toBe('102.00');
  });

  it('uses highestHigh over period correctly — wider window captures higher high', () => {
    // With period=4, swingHighs=[112,110,108,120], max=120 → SL=120-10=110.00
    const cfg: ChandelierExitConfig = {
      mechanism: TrailingStopMechanism.CHANDELIER_EXIT,
      period: 4,
      multiplier: 2,
    };
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      cfg,
      buildMarketData({
        swingHighs: [112, 110, 108, 120],
        atr: 5,
        highestHigh: undefined,
        lowestLow: undefined,
      }),
    );
    expect(result.newStopLoss).toBe('110.00');
  });

  it('returns a valid TrailingStopResult shape', () => {
    const result = svc.computeTrailingStop(buildLongPosition(), config, buildMarketData());
    expect(result).toMatchObject({
      newStopLoss: expect.any(String),
      shouldExit: expect.any(Boolean),
      mechanism: TrailingStopMechanism.CHANDELIER_EXIT,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Percentage-based
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — Percentage-based (Mechanism 4)', () => {
  const svc = buildService();
  const config: PercentageBasedConfig = {
    mechanism: TrailingStopMechanism.PERCENTAGE_BASED,
    percentage: 0.02,
  };

  it('LONG: newSL is at correct % below current price', () => {
    // currentPrice=100, pct=0.02 → 100*(1-0.02) = 98.00
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({ currentPrice: 100 }),
    );
    expect(result.newStopLoss).toBe('98.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.PERCENTAGE_BASED);
  });

  it('SHORT: newSL is at correct % above current price', () => {
    // currentPrice=100, pct=0.02 → 100*(1+0.02) = 102.00
    const result = svc.computeTrailingStop(
      buildShortPosition(),
      config,
      buildMarketData({ currentPrice: 100 }),
    );
    expect(result.newStopLoss).toBe('102.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.PERCENTAGE_BASED);
  });

  it('LONG: 5% stop from 200 → SL = 190.00', () => {
    const cfg: PercentageBasedConfig = {
      mechanism: TrailingStopMechanism.PERCENTAGE_BASED,
      percentage: 0.05,
    };
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '200.00' }),
      cfg,
      buildMarketData({ currentPrice: 200 }),
    );
    expect(result.newStopLoss).toBe('190.00');
  });

  it('SL distance scales proportionally with current price', () => {
    // At price 500 with 2%: SL = 490.00
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '480.00' }),
      config,
      buildMarketData({ currentPrice: 500 }),
    );
    expect(result.newStopLoss).toBe('490.00');
  });

  it('returns a valid TrailingStopResult shape', () => {
    const result = svc.computeTrailingStop(buildLongPosition(), config, buildMarketData());
    expect(result).toMatchObject({
      newStopLoss: expect.any(String),
      shouldExit: expect.any(Boolean),
      mechanism: TrailingStopMechanism.PERCENTAGE_BASED,
    });
    expect(result.exitQuantity).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Volatility-adjusted
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — Volatility-adjusted (Mechanism 5)', () => {
  const svc = buildService();

  const baseConfig: VolatilityAdjustedConfig = {
    mechanism: TrailingStopMechanism.VOLATILITY_ADJUSTED,
    baseMultiplier: 2,
    expandingIvMultiplier: 1.5,
    contractingIvMultiplier: 0.75,
  };

  it('NEUTRAL regime: same distance as plain ATR-based (ivScale = 1.0)', () => {
    // entryPrice=95, atr=5, base=2, neutral scale=1 → 95 - (5*2*1) = 85.00
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '95.00' }),
      baseConfig,
      buildMarketData({ atr: 5, ivRegime: 'NEUTRAL' }),
    );
    expect(result.newStopLoss).toBe('85.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.VOLATILITY_ADJUSTED);
  });

  it('EXPANDING regime: IV multiplier > 1 widens the stop (SL lower for LONG)', () => {
    // entryPrice=95, atr=5, base=2, expanding=1.5 → 95 - (5*2*1.5) = 95-15 = 80.00
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '95.00' }),
      baseConfig,
      buildMarketData({ atr: 5, ivRegime: 'EXPANDING' }),
    );
    expect(result.newStopLoss).toBe('80.00');
  });

  it('CONTRACTING regime: IV multiplier < 1 tightens the stop (SL higher for LONG)', () => {
    // entryPrice=95, atr=5, base=2, contracting=0.75 → 95 - (5*2*0.75) = 95-7.5 = 87.50
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '95.00' }),
      baseConfig,
      buildMarketData({ atr: 5, ivRegime: 'CONTRACTING' }),
    );
    expect(result.newStopLoss).toBe('87.50');
  });

  it('SHORT + EXPANDING: wider stop means SL is higher', () => {
    // entryPrice=105, atr=5, base=2, expanding=1.5 → 105 + (5*2*1.5) = 105+15 = 120.00
    const result = svc.computeTrailingStop(
      buildShortPosition({ entryPrice: '105.00' }),
      baseConfig,
      buildMarketData({ atr: 5, ivRegime: 'EXPANDING' }),
    );
    expect(result.newStopLoss).toBe('120.00');
  });

  it('EXPANDING SL is farther from entry than CONTRACTING SL (LONG)', () => {
    const mdExpanding = buildMarketData({ atr: 5, ivRegime: 'EXPANDING' });
    const mdContracting = buildMarketData({ atr: 5, ivRegime: 'CONTRACTING' });
    const position = buildLongPosition({ entryPrice: '100.00' });

    const expandingResult = svc.computeTrailingStop(position, baseConfig, mdExpanding);
    const contractingResult = svc.computeTrailingStop(position, baseConfig, mdContracting);

    expect(parseFloat(expandingResult.newStopLoss)).toBeLessThan(
      parseFloat(contractingResult.newStopLoss),
    );
  });

  it('returns a valid TrailingStopResult shape', () => {
    const result = svc.computeTrailingStop(buildLongPosition(), baseConfig, buildMarketData());
    expect(result).toMatchObject({
      newStopLoss: expect.any(String),
      shouldExit: expect.any(Boolean),
      mechanism: TrailingStopMechanism.VOLATILITY_ADJUSTED,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Structure-based
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — Structure-based (Mechanism 6)', () => {
  const svc = buildService();
  const config: StructureBasedConfig = {
    mechanism: TrailingStopMechanism.STRUCTURE_BASED,
    buffer: 2,
  };

  it('LONG: newSL = nearest support below currentPrice − buffer', () => {
    // currentPrice=100, supports=[95,90,85,80] → nearest below=95, buffer=2 → 93.00
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({ currentPrice: 100, supportLevels: [95, 90, 85, 80] }),
    );
    expect(result.newStopLoss).toBe('93.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.STRUCTURE_BASED);
  });

  it('SHORT: newSL = nearest resistance above currentPrice + buffer', () => {
    // currentPrice=100, resistances=[105,110,115] → nearest above=105, buffer=2 → 107.00
    const result = svc.computeTrailingStop(
      buildShortPosition(),
      config,
      buildMarketData({ currentPrice: 100, resistanceLevels: [105, 110, 115] }),
    );
    expect(result.newStopLoss).toBe('107.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.STRUCTURE_BASED);
  });

  it('LONG: falls back to currentPrice − buffer when no supports below', () => {
    // No support levels below currentPrice(100) → 100 - 2 = 98.00
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({ currentPrice: 100, supportLevels: [105, 110] }),
    );
    expect(result.newStopLoss).toBe('98.00');
  });

  it('SHORT: falls back to currentPrice + buffer when no resistances above', () => {
    // No resistance levels above currentPrice(100) → 100 + 2 = 102.00
    const result = svc.computeTrailingStop(
      buildShortPosition(),
      config,
      buildMarketData({ currentPrice: 100, resistanceLevels: [90, 85] }),
    );
    expect(result.newStopLoss).toBe('102.00');
  });

  it('LONG: picks the NEAREST support (highest one below current price)', () => {
    // currentPrice=100, supports=[70,80,97,99] → nearest below=99, SL=97.00
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({ currentPrice: 100, supportLevels: [70, 80, 97, 99] }),
    );
    expect(result.newStopLoss).toBe('97.00');
  });

  it('returns a valid TrailingStopResult shape', () => {
    const result = svc.computeTrailingStop(buildLongPosition(), config, buildMarketData());
    expect(result).toMatchObject({
      newStopLoss: expect.any(String),
      shouldExit: expect.any(Boolean),
      mechanism: TrailingStopMechanism.STRUCTURE_BASED,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Time-based
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — Time-based (Mechanism 7)', () => {
  const svc = buildService();

  it('SL is closer to current price as hours since entry increases (LONG)', () => {
    const entryTimeNow = new Date(Date.now() - 0); // just entered
    const entryTime2hAgo = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

    const cfgNow: TimeBasedConfig = {
      mechanism: TrailingStopMechanism.TIME_BASED,
      baseMultiplier: 3,
      tighteningRatePerHour: 0.5,
      entryTime: entryTimeNow,
    };

    const cfg2h: TimeBasedConfig = {
      mechanism: TrailingStopMechanism.TIME_BASED,
      baseMultiplier: 3,
      tighteningRatePerHour: 0.5,
      entryTime: entryTime2hAgo,
    };

    const md = buildMarketData({ currentPrice: 100, atr: 10 });
    const position = buildLongPosition();

    const resultNow = svc.computeTrailingStop(position, cfgNow, md);
    const result2h = svc.computeTrailingStop(position, cfg2h, md);

    // After 2 hours: effectiveMult = 3 - (0.5*2) = 2 → SL = 100 - 10*2 = 80
    // Just entered:  effectiveMult ≈ 3        → SL ≈ 100 - 10*3 = 70
    // 2h stop (80) is HIGHER than fresh stop (70) → tighter for LONG
    expect(parseFloat(result2h.newStopLoss)).toBeGreaterThan(parseFloat(resultNow.newStopLoss));
    expect(result2h.mechanism).toBe(TrailingStopMechanism.TIME_BASED);
  });

  it('SL distance decreases monotonically as time passes (LONG)', () => {
    // At t=0: effectiveMult=3 → distance=30, SL=100-30=70
    // At t=2h: effectiveMult=2 → distance=20, SL=100-20=80
    // At t=4h: effectiveMult=1 → distance=10, SL=100-10=90
    const md = buildMarketData({ currentPrice: 100, atr: 10 });
    const position = buildLongPosition();

    const makeCfg = (hoursAgo: number): TimeBasedConfig => ({
      mechanism: TrailingStopMechanism.TIME_BASED,
      baseMultiplier: 3,
      tighteningRatePerHour: 0.5,
      entryTime: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
    });

    const sl0h = parseFloat(svc.computeTrailingStop(position, makeCfg(0), md).newStopLoss);
    const sl2h = parseFloat(svc.computeTrailingStop(position, makeCfg(2), md).newStopLoss);
    const sl4h = parseFloat(svc.computeTrailingStop(position, makeCfg(4), md).newStopLoss);

    // As time increases, LONG SL should increase (tighten toward current price)
    expect(sl2h).toBeGreaterThan(sl0h);
    expect(sl4h).toBeGreaterThan(sl2h);
  });

  it('effectiveMultiplier is clamped to 0 — SL never exceeds currentPrice for LONG', () => {
    // 10 hours in with high tightening rate: baseMultiplier - rate*hours goes negative → clamped to 0
    // SL = currentPrice - 0 = currentPrice
    const cfg: TimeBasedConfig = {
      mechanism: TrailingStopMechanism.TIME_BASED,
      baseMultiplier: 2,
      tighteningRatePerHour: 1,
      entryTime: new Date(Date.now() - 10 * 60 * 60 * 1000), // 10 hours ago
    };
    const md = buildMarketData({ currentPrice: 100, atr: 5 });
    const result = svc.computeTrailingStop(buildLongPosition(), cfg, md);
    // effectiveMult = max(0, 2 - 1*10) = 0 → SL = 100 - 0 = 100.00
    expect(result.newStopLoss).toBe('100.00');
  });

  it('SHORT: SL distance decreases (SL moves toward current price) as time passes', () => {
    const md = buildMarketData({ currentPrice: 100, atr: 10 });
    const position = buildShortPosition();

    const cfg0h: TimeBasedConfig = {
      mechanism: TrailingStopMechanism.TIME_BASED,
      baseMultiplier: 3,
      tighteningRatePerHour: 0.5,
      entryTime: new Date(Date.now()),
    };
    const cfg2h: TimeBasedConfig = {
      ...cfg0h,
      entryTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
    };

    const sl0h = parseFloat(svc.computeTrailingStop(position, cfg0h, md).newStopLoss);
    const sl2h = parseFloat(svc.computeTrailingStop(position, cfg2h, md).newStopLoss);

    // SHORT SL should decrease (tighten toward price) as time passes
    expect(sl2h).toBeLessThan(sl0h);
  });

  it('returns a valid TrailingStopResult shape', () => {
    const cfg: TimeBasedConfig = {
      mechanism: TrailingStopMechanism.TIME_BASED,
      baseMultiplier: 2,
      tighteningRatePerHour: 0.3,
      entryTime: new Date(),
    };
    const result = svc.computeTrailingStop(buildLongPosition(), cfg, buildMarketData());
    expect(result).toMatchObject({
      newStopLoss: expect.any(String),
      shouldExit: expect.any(Boolean),
      mechanism: TrailingStopMechanism.TIME_BASED,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Partial-profit
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — Partial-profit (Mechanism 8)', () => {
  const svc = buildService();

  it('LONG: exits partial qty and moves SL to entryPrice (break-even) at first target', () => {
    // entryPrice=90, firstTarget=100, currentPrice=100, fraction=0.5, qty=100
    // → exitQty=50, newSL=90.00 (break-even), shouldExit=true
    const config: PartialProfitConfig = {
      mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
      firstTargetPrice: 100,
      partialExitFraction: 0.5,
    };
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '90.00', quantity: 100 }),
      config,
      buildMarketData({ currentPrice: 100 }),
    );
    expect(result.shouldExit).toBe(true);
    expect(result.exitQuantity).toBe(50);
    expect(result.newStopLoss).toBe('90.00'); // break-even at entryPrice
    expect(result.mechanism).toBe(TrailingStopMechanism.PARTIAL_PROFIT);
  });

  it('LONG: does NOT exit before first target is reached', () => {
    // currentPrice=99, target=100 → target not reached
    const config: PartialProfitConfig = {
      mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
      firstTargetPrice: 100,
      partialExitFraction: 0.5,
    };
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '90.00', currentStopLoss: '85.00' }),
      config,
      buildMarketData({ currentPrice: 99 }),
    );
    expect(result.shouldExit).toBe(false);
    expect(result.exitQuantity).toBeUndefined();
    expect(result.newStopLoss).toBe('85.00'); // unchanged currentStopLoss
  });

  it('SHORT: exits partial qty and moves SL to entryPrice at first target', () => {
    // entryPrice=110, firstTarget=100, currentPrice=100, fraction=0.5, qty=100
    // → exitQty=50, newSL=110.00 (break-even), shouldExit=true
    const config: PartialProfitConfig = {
      mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
      firstTargetPrice: 100,
      partialExitFraction: 0.5,
    };
    const result = svc.computeTrailingStop(
      buildShortPosition({ entryPrice: '110.00', quantity: 100 }),
      config,
      buildMarketData({ currentPrice: 100 }),
    );
    expect(result.shouldExit).toBe(true);
    expect(result.exitQuantity).toBe(50);
    expect(result.newStopLoss).toBe('110.00'); // break-even
  });

  it('uses postPartialStopPrice when configured instead of break-even', () => {
    const config: PartialProfitConfig = {
      mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
      firstTargetPrice: 100,
      partialExitFraction: 0.5,
      postPartialStopPrice: 92,
    };
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '90.00', quantity: 100 }),
      config,
      buildMarketData({ currentPrice: 105 }),
    );
    expect(result.shouldExit).toBe(true);
    expect(result.newStopLoss).toBe('92.00');
    expect(result.exitQuantity).toBe(50);
  });

  it('exitQuantity uses floor() for fractional lots', () => {
    // qty=75, fraction=0.5 → floor(37.5) = 37
    const config: PartialProfitConfig = {
      mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
      firstTargetPrice: 100,
      partialExitFraction: 0.5,
    };
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '90.00', quantity: 75 }),
      config,
      buildMarketData({ currentPrice: 100 }),
    );
    expect(result.exitQuantity).toBe(37);
  });

  it('LONG: triggers when price is ABOVE first target (not only equal)', () => {
    // currentPrice=105 > firstTarget=100 → triggered
    const config: PartialProfitConfig = {
      mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
      firstTargetPrice: 100,
      partialExitFraction: 0.5,
    };
    const result = svc.computeTrailingStop(
      buildLongPosition({ entryPrice: '90.00', quantity: 100 }),
      config,
      buildMarketData({ currentPrice: 105 }),
    );
    expect(result.shouldExit).toBe(true);
    expect(result.exitQuantity).toBe(50);
  });

  it('returns a valid TrailingStopResult shape when target not reached', () => {
    const config: PartialProfitConfig = {
      mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
      firstTargetPrice: 200,
      partialExitFraction: 0.5,
    };
    const result = svc.computeTrailingStop(
      buildLongPosition(),
      config,
      buildMarketData({ currentPrice: 100 }),
    );
    expect(result).toMatchObject({
      newStopLoss: expect.any(String),
      shouldExit: false,
      mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting: computeTrailingStop dispatcher
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — computeTrailingStop dispatcher', () => {
  const svc = buildService();

  const mechanismConfigs = [
    {
      name: 'ATR_BASED',
      config: { mechanism: TrailingStopMechanism.ATR_BASED, multiplier: 2 } as AtrBasedConfig,
    },
    {
      name: 'SWING_HIGH_LOW',
      config: {
        mechanism: TrailingStopMechanism.SWING_HIGH_LOW,
        lookbackBars: 3,
        buffer: 1,
      } as SwingHighLowConfig,
    },
    {
      name: 'CHANDELIER_EXIT',
      config: {
        mechanism: TrailingStopMechanism.CHANDELIER_EXIT,
        period: 3,
        multiplier: 2,
      } as ChandelierExitConfig,
    },
    {
      name: 'PERCENTAGE_BASED',
      config: {
        mechanism: TrailingStopMechanism.PERCENTAGE_BASED,
        percentage: 0.02,
      } as PercentageBasedConfig,
    },
    {
      name: 'VOLATILITY_ADJUSTED',
      config: {
        mechanism: TrailingStopMechanism.VOLATILITY_ADJUSTED,
        baseMultiplier: 2,
        expandingIvMultiplier: 1.5,
        contractingIvMultiplier: 0.75,
      } as VolatilityAdjustedConfig,
    },
    {
      name: 'STRUCTURE_BASED',
      config: {
        mechanism: TrailingStopMechanism.STRUCTURE_BASED,
        buffer: 2,
      } as StructureBasedConfig,
    },
    {
      name: 'TIME_BASED',
      config: {
        mechanism: TrailingStopMechanism.TIME_BASED,
        baseMultiplier: 2,
        tighteningRatePerHour: 0.3,
        entryTime: new Date(),
      } as TimeBasedConfig,
    },
    {
      name: 'PARTIAL_PROFIT',
      config: {
        mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
        firstTargetPrice: 200,
        partialExitFraction: 0.5,
      } as PartialProfitConfig,
    },
  ];

  it.each(mechanismConfigs)(
    '$name: returns a TrailingStopResult with correct mechanism tag',
    ({ name, config }) => {
      const result = svc.computeTrailingStop(buildLongPosition(), config, buildMarketData());
      expect(result.newStopLoss).toBeDefined();
      expect(typeof result.shouldExit).toBe('boolean');
      expect(result.mechanism).toBe(
        TrailingStopMechanism[name as keyof typeof TrailingStopMechanism],
      );
    },
  );

  it.each(mechanismConfigs)(
    '$name: newStopLoss is a valid numeric string with 2 decimal places',
    ({ config }) => {
      const result = svc.computeTrailingStop(buildLongPosition(), config, buildMarketData());
      expect(result.newStopLoss).toMatch(/^-?\d+\.\d{2}$/);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. enforceSlMonotonicity
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — enforceSlMonotonicity (Requirement 12.2)', () => {
  const svc = buildService();

  // LONG direction ──────────────────────────────────────────────────────────

  it('LONG: new SL higher than current → enforced SL = new SL (move allowed)', () => {
    // SL improving: 88 → 92 → allowed
    expect(svc.enforceSlMonotonicity('88.00', '92.00', 'LONG')).toBe('92.00');
  });

  it('LONG: new SL lower than current → enforced SL = current SL (move blocked)', () => {
    // SL regressing: 92 → 88 → blocked, keep 92
    expect(svc.enforceSlMonotonicity('92.00', '88.00', 'LONG')).toBe('92.00');
  });

  it('LONG: new SL equal to current → enforced SL = current SL (unchanged)', () => {
    expect(svc.enforceSlMonotonicity('90.00', '90.00', 'LONG')).toBe('90.00');
  });

  // SHORT direction ─────────────────────────────────────────────────────────

  it('SHORT: new SL lower than current → enforced SL = new SL (move allowed)', () => {
    // SL improving: 112 → 108 → allowed
    expect(svc.enforceSlMonotonicity('112.00', '108.00', 'SHORT')).toBe('108.00');
  });

  it('SHORT: new SL higher than current → enforced SL = current SL (move blocked)', () => {
    // SL regressing: 108 → 112 → blocked, keep 108
    expect(svc.enforceSlMonotonicity('108.00', '112.00', 'SHORT')).toBe('108.00');
  });

  it('SHORT: new SL equal to current → enforced SL = current SL (unchanged)', () => {
    expect(svc.enforceSlMonotonicity('110.00', '110.00', 'SHORT')).toBe('110.00');
  });

  // Output format ───────────────────────────────────────────────────────────

  it('result is always a 2-decimal-place string', () => {
    const result = svc.enforceSlMonotonicity('88.5', '92.3333', 'LONG');
    expect(result).toMatch(/^-?\d+\.\d{2}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Property test — SL Monotonicity (Property 16)
// ─────────────────────────────────────────────────────────────────────────────

// Feature: money-printer, Property 16: Trailing Stop SL Monotonicity in Profit Direction
import * as fc from 'fast-check';

describe('TrailingStopService — Property 16: SL monotonicity in profit direction', () => {
  const svc = buildService();

  /**
   * Validates: Requirement 12.2
   *
   * For any LONG position:
   *   enforced SL ≥ current SL  (SL only ratchets higher)
   *
   * For any SHORT position:
   *   enforced SL ≤ current SL  (SL only ratchets lower)
   *
   * Additionally, for LONG the enforced SL is never the SMALLER of the two
   * values (it is always max(current, new)).
   */
  it('LONG: enforced SL is always ≥ current SL for any pair of price values', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 1, max: 10_000, noNaN: true }),
        fc.float({ min: 1, max: 10_000, noNaN: true }),
        (currentSl, newSl) => {
          const enforced = parseFloat(
            svc.enforceSlMonotonicity(currentSl.toFixed(2), newSl.toFixed(2), 'LONG'),
          );
          return enforced >= currentSl - 0.005; // allow for 2dp rounding
        },
      ),
      { numRuns: 100 },
    );
  });

  it('SHORT: enforced SL is always ≤ current SL for any pair of price values', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 1, max: 10_000, noNaN: true }),
        fc.float({ min: 1, max: 10_000, noNaN: true }),
        (currentSl, newSl) => {
          const enforced = parseFloat(
            svc.enforceSlMonotonicity(currentSl.toFixed(2), newSl.toFixed(2), 'SHORT'),
          );
          return enforced <= currentSl + 0.005; // allow for 2dp rounding
        },
      ),
      { numRuns: 100 },
    );
  });

  it('LONG: enforced SL is never the smaller of (current, new) — always max', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 1, max: 10_000, noNaN: true }),
        fc.float({ min: 1, max: 10_000, noNaN: true }),
        (a, b) => {
          const enforced = parseFloat(
            svc.enforceSlMonotonicity(a.toFixed(2), b.toFixed(2), 'LONG'),
          );
          const expectedMax = Math.max(parseFloat(a.toFixed(2)), parseFloat(b.toFixed(2)));
          return Math.abs(enforced - expectedMax) < 0.01;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('applies monotonicity across a sequence of price updates (LONG)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 1, max: 10_000, noNaN: true }), {
          minLength: 2,
          maxLength: 50,
        }),
        (priceUpdates) => {
          let currentSl = priceUpdates[0].toFixed(2);
          for (let i = 1; i < priceUpdates.length; i++) {
            const newSl = priceUpdates[i].toFixed(2);
            const enforced = svc.enforceSlMonotonicity(currentSl, newSl, 'LONG');
            // SL must never go below the previous value
            if (parseFloat(enforced) < parseFloat(currentSl) - 0.005) return false;
            currentSl = enforced;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('applies monotonicity across a sequence of price updates (SHORT)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 1, max: 10_000, noNaN: true }), {
          minLength: 2,
          maxLength: 50,
        }),
        (priceUpdates) => {
          let currentSl = priceUpdates[0].toFixed(2);
          for (let i = 1; i < priceUpdates.length; i++) {
            const newSl = priceUpdates[i].toFixed(2);
            const enforced = svc.enforceSlMonotonicity(currentSl, newSl, 'SHORT');
            // SL must never go above the previous value
            if (parseFloat(enforced) > parseFloat(currentSl) + 0.005) return false;
            currentSl = enforced;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. computeAndEnforceSl
// ─────────────────────────────────────────────────────────────────────────────

describe('TrailingStopService — computeAndEnforceSl (Requirement 12.2)', () => {
  const svc = buildService();

  it('LONG: when computeTrailingStop returns a lower SL → current SL is preserved', () => {
    // ATR-based: entryPrice=95, atr=1, mult=2 → newSL=95-2=93.00
    // currentStopLoss=97.00 → 93.00 < 97.00 → enforce keeps 97.00
    const config: AtrBasedConfig = {
      mechanism: TrailingStopMechanism.ATR_BASED,
      multiplier: 2,
    };
    const position = buildLongPosition({
      entryPrice: '95.00',
      currentStopLoss: '97.00', // higher than the computed 93.00
    });
    const marketData = buildMarketData({ atr: 1, currentPrice: 110 });

    const result = svc.computeAndEnforceSl(position, config, marketData);

    // Raw computation: 95 - (1*2) = 93.00; enforced to 97.00
    expect(result.newStopLoss).toBe('97.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.ATR_BASED);
    expect(result.shouldExit).toBe(false); // currentPrice=110 > currentSL=97
  });

  it('LONG: when computeTrailingStop returns a higher SL → new SL is used', () => {
    // ATR-based: entryPrice=95, atr=5, mult=2 → newSL=95-10=85.00
    // currentStopLoss=80.00 → 85.00 > 80.00 → enforce allows 85.00
    const config: AtrBasedConfig = {
      mechanism: TrailingStopMechanism.ATR_BASED,
      multiplier: 2,
    };
    const position = buildLongPosition({
      entryPrice: '95.00',
      currentStopLoss: '80.00', // lower than the computed 85.00
    });
    const marketData = buildMarketData({ atr: 5, currentPrice: 100 });

    const result = svc.computeAndEnforceSl(position, config, marketData);

    // Raw computation: 95 - (5*2) = 85.00; enforced allows improvement → 85.00
    expect(result.newStopLoss).toBe('85.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.ATR_BASED);
  });

  it('SHORT: when computeTrailingStop returns a higher SL → current SL is preserved', () => {
    // ATR-based: entryPrice=105, atr=1, mult=2 → newSL=105+2=107.00
    // currentStopLoss=103.00 → 107.00 > 103.00 → enforce keeps 103.00
    const config: AtrBasedConfig = {
      mechanism: TrailingStopMechanism.ATR_BASED,
      multiplier: 2,
    };
    const position = buildShortPosition({
      entryPrice: '105.00',
      currentStopLoss: '103.00', // lower than the computed 107.00
    });
    const marketData = buildMarketData({ atr: 1, currentPrice: 90 });

    const result = svc.computeAndEnforceSl(position, config, marketData);

    // Raw computation: 105 + (1*2) = 107.00; enforced to 103.00
    expect(result.newStopLoss).toBe('103.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.ATR_BASED);
  });

  it('SHORT: when computeTrailingStop returns a lower SL → new SL is used', () => {
    // ATR-based: entryPrice=105, atr=5, mult=2 → newSL=105+10=115.00
    // currentStopLoss=120.00 → 115.00 < 120.00 → enforce allows 115.00
    const config: AtrBasedConfig = {
      mechanism: TrailingStopMechanism.ATR_BASED,
      multiplier: 2,
    };
    const position = buildShortPosition({
      entryPrice: '105.00',
      currentStopLoss: '120.00', // higher than the computed 115.00
    });
    const marketData = buildMarketData({ atr: 5, currentPrice: 100 });

    const result = svc.computeAndEnforceSl(position, config, marketData);

    // Raw computation: 105 + (5*2) = 115.00; enforced allows improvement → 115.00
    expect(result.newStopLoss).toBe('115.00');
    expect(result.mechanism).toBe(TrailingStopMechanism.ATR_BASED);
  });

  it('result preserves all other TrailingStopResult fields unchanged', () => {
    const config: AtrBasedConfig = {
      mechanism: TrailingStopMechanism.ATR_BASED,
      multiplier: 2,
    };
    const position = buildLongPosition({
      entryPrice: '95.00',
      currentStopLoss: '80.00',
    });
    const marketData = buildMarketData({ atr: 5, currentPrice: 100 });

    const result = svc.computeAndEnforceSl(position, config, marketData);

    expect(result.mechanism).toBe(TrailingStopMechanism.ATR_BASED);
    expect(typeof result.shouldExit).toBe('boolean');
    expect(result.exitQuantity).toBeUndefined();
  });
});
