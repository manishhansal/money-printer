/**
 * RiskManagementService unit + property-based tests.
 *
 * Coverage:
 *   computePositionSize
 *     - Unit: concrete formula examples
 *     - Unit: zero per-unit risk → 0
 *     - Unit: invalid lot_size   → 0
 *     - Unit: floors (does not round up)
 *     - Property 12: formula invariant for all valid inputs  (Req 9.2)
 *     - Property 13: invalid params always rejected          (Req 9.9, 9.11)
 *
 *   evaluatePreEntryGates
 *     - Unit: each of the 8 gates in isolation
 *     - Unit: all gates pass → returns approved with suggestedQuantity
 *     - Unit: gate ordering — first-failing gate is returned
 *
 * Requirements: 9.2, 9.5, 9.9, 9.11
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import fc from 'fast-check';

import { RiskManagementService } from './risk-management.service';
import { PreEntryGateInput } from './risk-management.types';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Default config values — mirrors the service defaults. */
const CONFIG: Record<string, number> = {
  RISK_PERCENTAGE_DEFAULT: 1.0,
  MAX_PER_TRADE_LOSS_RUPEES: 5000,
  MAX_EXPOSURE_PCT: 20,
  MAX_CORRELATED_PCT: 10,
  MAX_CONCURRENT_TRADES: 5,
  MAX_CONCENTRATION_PCT: 15,
};

function buildConfigService(overrides: Partial<Record<string, number>> = {}) {
  const merged = { ...CONFIG, ...overrides };
  return {
    get: jest.fn(<T>(key: string): T | undefined => merged[key] as unknown as T),
  };
}

async function buildService(
  configOverrides: Partial<Record<string, number>> = {},
): Promise<RiskManagementService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RiskManagementService,
      { provide: ConfigService, useValue: buildConfigService(configOverrides) },
    ],
  }).compile();

  return module.get<RiskManagementService>(RiskManagementService);
}

/**
 * Builds a passing PreEntryGateInput whose only gate that could fail is
 * the one under test.  Callers override the single field they care about.
 *
 * Default:
 *   - compositeScore: 85        (passes SIGNAL_SCORE)
 *   - entry=40, stop=30, |diff|=10  (passes ZERO_PER_UNIT_RISK)
 *   - lotSize: 25               (passes INVALID_LOT_SIZE)
 *   - dynamicCapital: "100000.00"
 *   - riskPercentage: "1.00"    → risk_amount = 1000 ≤ 5000   (passes PER_TRADE_LOSS)
 *   - suggestedQty = FLOOR(1000 / (10 × 25)) = 4 lots
 *   - order_exposure = 40 × 4 × 25 = 4000 INR
 *   - currentTotalExposure: "0.00"
 *       0 + 4000 ≤ 20% × 100000 = 20000                       (passes TOTAL_EXPOSURE)
 *   - currentCorrelatedExposure: "0.00"
 *       0 + 4000 ≤ 10% × 100000 = 10000                       (passes CORRELATED_EXPOSURE)
 *   - openPositionsCount: 0                                    (passes CONCURRENT_TRADES)
 *   - currentInstrumentExposure: "0.00"
 *       0 + 4000 ≤ 15% × 100000 = 15000                       (passes CONCENTRATION)
 */
function passingInput(overrides: Partial<PreEntryGateInput> = {}): PreEntryGateInput {
  return {
    compositeScore: 85,
    entryPrice: '40.00',
    stopLossPrice: '30.00',
    lotSize: 25,
    dynamicCapital: '100000.00',
    riskPercentage: '1.00',
    currentTotalExposure: '0.00',
    currentCorrelatedExposure: '0.00',
    currentInstrumentExposure: '0.00',
    openPositionsCount: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// computePositionSize — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RiskManagementService — computePositionSize', () => {
  let service: RiskManagementService;

  beforeEach(async () => {
    service = await buildService();
  });

  it('computes quantity for the canonical example (Req 9.2)', () => {
    // capital=100000, risk=1% → risk_amount=1000
    // |100-95|×50 = 250 per-unit-risk
    // 1000/250 = 4 lots
    expect(service.computePositionSize('100000.00', '1.00', '100.00', '95.00', 50)).toBe(4);
  });

  it('floors the result — does NOT round up fractional lots', () => {
    // risk_amount = 100000 × 1 / 100 = 1000
    // per_unit_risk = |100-97| × 75 = 225
    // 1000/225 = 4.444... → floor = 4
    expect(service.computePositionSize('100000.00', '1.00', '100.00', '97.00', 75)).toBe(4);
  });

  it('returns 0 when entry equals stop (zero per-unit risk)', () => {
    expect(service.computePositionSize('100000.00', '1.00', '100.00', '100.00', 50)).toBe(0);
  });

  it('returns 0 when lot_size is 0 (invalid)', () => {
    expect(service.computePositionSize('100000.00', '1.00', '100.00', '95.00', 0)).toBe(0);
  });

  it('returns 0 when lot_size is negative (invalid)', () => {
    expect(service.computePositionSize('100000.00', '1.00', '100.00', '95.00', -1)).toBe(0);
  });

  it('works when stop is above entry (short trade direction)', () => {
    // |95 - 100| = 5 → same per-unit risk as long direction
    expect(service.computePositionSize('100000.00', '1.00', '95.00', '100.00', 50)).toBe(4);
  });

  it('handles small risk percentages correctly', () => {
    // risk_amount = 100000 × 0.50 / 100 = 500
    // per_unit_risk = 5 × 50 = 250
    // 500/250 = 2
    expect(service.computePositionSize('100000.00', '0.50', '100.00', '95.00', 50)).toBe(2);
  });

  it('handles large capital and lot sizes', () => {
    // capital = 5,000,000 INR, risk = 2%, entry = 200, stop = 195, lot = 25
    // risk_amount = 5000000 × 2/100 = 100000
    // per_unit = (200-195) × 25 = 125
    // 100000/125 = 800
    expect(service.computePositionSize('5000000.00', '2.00', '200.00', '195.00', 25)).toBe(800);
  });

  it('returns 0 when risk_amount < per_unit_risk (quantity would be < 1)', () => {
    // risk_amount = 1000 × 1/100 = 10
    // per_unit = 5 × 100 = 500
    // 10/500 = 0.02 → floor = 0
    expect(service.computePositionSize('1000.00', '1.00', '100.00', '95.00', 100)).toBe(0);
  });

  // ─── Property 12: Position Sizing Formula Correctness ──────────────────────

  it('Property 12: quantity = FLOOR(capital × risk% / (|entry−stop| × lot)) for all valid inputs', () => {
    // **Validates: Requirements 9.2**
    //
    // Strategy: generate integer-valued prices (no decimal) to keep all
    // intermediate arithmetic exact in both BigInt and Number.  The reference
    // invariant is checked using integer-only comparisons to avoid any
    // floating-point rounding uncertainty.
    //
    // Invariant:
    //   result × diffWhole × lotSize × 100 ≤ capitalWhole × riskPctWhole
    //   AND
    //   (result + 1) × diffWhole × lotSize × 100 > capitalWhole × riskPctWhole
    //
    // (Both sides are multiplied by 100 so that riskPct stays integer.)
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }), // capitalWhole: INR integer
        fc.integer({ min: 1, max: 100 }), // riskPctWhole: whole % 1–100
        fc.integer({ min: 10, max: 100_000 }), // entryWhole: INR integer
        fc.integer({ min: 1, max: 5_000 }), // diffWhole: |entry − stop| ≥ 1
        fc.boolean(), // stopAboveEntry
        fc.integer({ min: 1, max: 1_000 }), // lotSize
        (capitalWhole, riskPctWhole, entryWhole, diffWhole, stopAboveEntry, lotSize) => {
          const stopWhole = stopAboveEntry ? entryWhole + diffWhole : entryWhole - diffWhole;

          // Skip if stop would go ≤ 0 (non-tradable; diffWhole may exceed entryWhole)
          if (stopWhole <= 0) return;

          const capital = `${capitalWhole}.00`;
          const riskPct = `${riskPctWhole}.00`;
          const entry = `${entryWhole}.00`;
          const stop = `${stopWhole}.00`;

          const result = service.computePositionSize(capital, riskPct, entry, stop, lotSize);

          // Reference invariant using integer arithmetic only (no floating-point)
          const lhsBudget = capitalWhole * riskPctWhole; // capital × riskPct (in %-units)
          const perUnitCost = diffWhole * lotSize * 100; // per-unit risk × 100

          // Floor lower bound: result × per_unit_risk ≤ risk_amount
          expect(result * perUnitCost).toBeLessThanOrEqual(lhsBudget);

          // Floor upper bound: (result + 1) × per_unit_risk > risk_amount
          expect((result + 1) * perUnitCost).toBeGreaterThan(lhsBudget);
        },
      ),
      { numRuns: 2000 },
    );
  });

  // ─── Property 13: Invalid parameters → rejection (quantity = 0) ───────────

  it('Property 13: zero per-unit risk always returns 0 regardless of other inputs', () => {
    // **Validates: Requirements 9.9**
    //
    // When entry == stop the absolute per-unit risk is zero; no valid
    // quantity can be computed.  For any capital and risk percentage,
    // the result MUST be 0.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }).map((v) => `${v}.00`), // capital
        fc.integer({ min: 1, max: 100 }).map((v) => `${v}.00`), // riskPct
        fc.integer({ min: 1, max: 100_000 }).map((v) => `${v}.00`), // entry = stop (same price)
        fc.integer({ min: 1, max: 1_000 }), // lotSize (positive)
        (capital, riskPct, price, lotSize) => {
          // entry and stop are the same price → zero per-unit risk
          const result = service.computePositionSize(capital, riskPct, price, price, lotSize);
          expect(result).toBe(0);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('Property 13: invalid lot_size (≤ 0) always returns 0 regardless of other inputs', () => {
    // **Validates: Requirements 9.11**
    //
    // When lot_size is zero or negative, the instrument is not configured for
    // trading.  The service MUST return 0 for any combination of other inputs.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }).map((v) => `${v}.00`), // capital
        fc.integer({ min: 1, max: 100 }).map((v) => `${v}.00`), // riskPct
        fc.integer({ min: 1, max: 100_000 }).map((v) => `${v}.00`), // entry
        fc.integer({ min: 1, max: 100_000 }).map((v) => `${v}.00`), // stop (may equal entry)
        fc.integer({ min: -1_000, max: 0 }), // lotSize ≤ 0
        (capital, riskPct, entry, stop, invalidLotSize) => {
          const result = service.computePositionSize(capital, riskPct, entry, stop, invalidLotSize);
          expect(result).toBe(0);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluatePreEntryGates — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RiskManagementService — evaluatePreEntryGates', () => {
  let service: RiskManagementService;

  beforeEach(async () => {
    service = await buildService();
  });

  // ── All gates passing ─────────────────────────────────────────────────────

  it('returns approved with suggestedQuantity when all 8 gates pass', () => {
    // entry=40, stop=30, lot=25 → qty = FLOOR(1000 / (10×25)) = 4 lots
    const result = service.evaluatePreEntryGates(passingInput());
    expect(result).toEqual({ approved: true, suggestedQuantity: 4 });
  });

  it('suggestedQuantity matches computePositionSize for the same inputs', () => {
    const input = passingInput();
    const gateResult = service.evaluatePreEntryGates(input);
    const sizing = service.computePositionSize(
      input.dynamicCapital,
      input.riskPercentage,
      input.entryPrice,
      input.stopLossPrice,
      input.lotSize,
    );
    expect(gateResult).toEqual({ approved: true, suggestedQuantity: sizing });
  });

  // ── Gate 1: SIGNAL_SCORE ──────────────────────────────────────────────────

  it('rejects on SIGNAL_SCORE when compositeScore is 79', () => {
    const result = service.evaluatePreEntryGates(passingInput({ compositeScore: 79 }));
    expect(result).toMatchObject({ approved: false, failingGate: 'SIGNAL_SCORE' });
  });

  it('rejects on SIGNAL_SCORE when compositeScore is 0', () => {
    const result = service.evaluatePreEntryGates(passingInput({ compositeScore: 0 }));
    expect(result).toMatchObject({ approved: false, failingGate: 'SIGNAL_SCORE' });
  });

  it('passes SIGNAL_SCORE when compositeScore is exactly 80', () => {
    const result = service.evaluatePreEntryGates(passingInput({ compositeScore: 80 }));
    expect(result).toMatchObject({ approved: true });
  });

  it('passes SIGNAL_SCORE when compositeScore is 100', () => {
    const result = service.evaluatePreEntryGates(passingInput({ compositeScore: 100 }));
    expect(result).toMatchObject({ approved: true });
  });

  // ── Gate 2: ZERO_PER_UNIT_RISK ────────────────────────────────────────────

  it('rejects on ZERO_PER_UNIT_RISK when entry equals stop', () => {
    const result = service.evaluatePreEntryGates(
      passingInput({ entryPrice: '100.00', stopLossPrice: '100.00' }),
    );
    expect(result).toMatchObject({
      approved: false,
      failingGate: 'ZERO_PER_UNIT_RISK',
      reason: 'zero per-unit risk',
    });
  });

  it('passes ZERO_PER_UNIT_RISK when entry and stop differ by 0.0001', () => {
    const result = service.evaluatePreEntryGates(
      passingInput({ entryPrice: '100.0001', stopLossPrice: '100.0000' }),
    );
    // Gate 2 passes; subsequent gates may or may not pass (PER_TRADE_LOSS will
    // reject since risk_amount ≈ 1000/lot×diff is extreme, but that's a
    // different gate — what matters is gate 2 does NOT fire)
    if (result.approved === false) {
      expect(result.failingGate).not.toBe('ZERO_PER_UNIT_RISK');
    }
  });

  // ── Gate 3: INVALID_LOT_SIZE ──────────────────────────────────────────────

  it('rejects on INVALID_LOT_SIZE when lotSize is 0', () => {
    const result = service.evaluatePreEntryGates(passingInput({ lotSize: 0 }));
    expect(result).toMatchObject({
      approved: false,
      failingGate: 'INVALID_LOT_SIZE',
      reason: 'invalid lot_size configuration',
    });
  });

  it('rejects on INVALID_LOT_SIZE when lotSize is negative', () => {
    const result = service.evaluatePreEntryGates(passingInput({ lotSize: -50 }));
    expect(result).toMatchObject({ approved: false, failingGate: 'INVALID_LOT_SIZE' });
  });

  // ── Gate 4: PER_TRADE_LOSS ────────────────────────────────────────────────

  it('rejects on PER_TRADE_LOSS when risk_amount exceeds the configured limit', () => {
    // risk_amount = 1000000 × 10/100 = 100000 > 5000
    const result = service.evaluatePreEntryGates(
      passingInput({ dynamicCapital: '1000000.00', riskPercentage: '10.00' }),
    );
    expect(result).toMatchObject({ approved: false, failingGate: 'PER_TRADE_LOSS' });
  });

  it('passes PER_TRADE_LOSS when risk_amount equals the configured limit exactly', () => {
    // risk_amount = 500000 × 1/100 = 5000 ≤ 5000
    const result = service.evaluatePreEntryGates(
      passingInput({ dynamicCapital: '500000.00', riskPercentage: '1.00' }),
    );
    if (result.approved === false) {
      expect(result.failingGate).not.toBe('PER_TRADE_LOSS');
    }
  });

  it('respects a custom MAX_PER_TRADE_LOSS_RUPEES config override', async () => {
    const customService = await buildService({ MAX_PER_TRADE_LOSS_RUPEES: 100 });
    // risk_amount = 100000 × 1/100 = 1000 > 100
    const result = customService.evaluatePreEntryGates(passingInput());
    expect(result).toMatchObject({ approved: false, failingGate: 'PER_TRADE_LOSS' });
  });

  // ── Gate 5: TOTAL_EXPOSURE ────────────────────────────────────────────────

  it('rejects on TOTAL_EXPOSURE when combined exposure exceeds the threshold', () => {
    // threshold = 100000 × 20% = 20000
    // order_exposure = 40 × 4 × 25 = 4000
    // currentTotalExposure = 16001 → total = 20001 > 20000
    const result = service.evaluatePreEntryGates(
      passingInput({ currentTotalExposure: '16001.00' }),
    );
    expect(result).toMatchObject({ approved: false, failingGate: 'TOTAL_EXPOSURE' });
  });

  it('passes TOTAL_EXPOSURE when combined exposure equals the threshold exactly', () => {
    // 16000 + 4000 = 20000 = 20% × 100000 — exactly at the limit (≤ passes)
    const result = service.evaluatePreEntryGates(
      passingInput({ currentTotalExposure: '16000.00' }),
    );
    if (result.approved === false) {
      expect(result.failingGate).not.toBe('TOTAL_EXPOSURE');
    }
  });

  it('respects a custom MAX_EXPOSURE_PCT config override', async () => {
    const customService = await buildService({ MAX_EXPOSURE_PCT: 3 });
    // threshold = 100000 × 3% = 3000; order_exposure = 40 × 4 × 25 = 4000 > 3000
    const result = customService.evaluatePreEntryGates(passingInput());
    expect(result).toMatchObject({ approved: false, failingGate: 'TOTAL_EXPOSURE' });
  });

  // ── Gate 6: CORRELATED_EXPOSURE ───────────────────────────────────────────

  it('rejects on CORRELATED_EXPOSURE when same-underlying exposure exceeds the threshold', () => {
    // threshold = 100000 × 10% = 10000; order_exposure = 40 × 4 × 25 = 4000
    // currentCorrelatedExposure = 6001 → 6001 + 4000 = 10001 > 10000
    // Gate 5: 0 + 4000 = 4000 ≤ 20000 ✓ passes
    const result = service.evaluatePreEntryGates(
      passingInput({ currentCorrelatedExposure: '6001.00' }),
    );
    expect(result).toMatchObject({ approved: false, failingGate: 'CORRELATED_EXPOSURE' });
  });

  it('passes CORRELATED_EXPOSURE when same-underlying exposure is within the threshold', () => {
    // threshold = 100000 × 10% = 10000; 0 + 4000 = 4000 ≤ 10000 ✓
    const result = service.evaluatePreEntryGates(
      passingInput({ currentCorrelatedExposure: '0.00' }),
    );
    if (result.approved === false) {
      expect(result.failingGate).not.toBe('CORRELATED_EXPOSURE');
    }
  });

  it('respects a custom MAX_CORRELATED_PCT config override', async () => {
    const customService = await buildService({ MAX_CORRELATED_PCT: 3 });
    // threshold = 100000 × 3% = 3000; order_exposure = 40 × 4 × 25 = 4000 > 3000
    // Gate 5 passes: 0 + 4000 ≤ 20000 ✓
    // Gate 6 fails: 0 + 4000 > 3000 ✗
    const result = customService.evaluatePreEntryGates(passingInput());
    expect(result).toMatchObject({ approved: false, failingGate: 'CORRELATED_EXPOSURE' });
  });

  // ── Gate 7: CONCURRENT_TRADES ─────────────────────────────────────────────

  it('rejects on CONCURRENT_TRADES when open count equals the maximum', async () => {
    // Use high exposure limits to avoid hitting gates 5/6 before gate 7
    const customService = await buildService({ MAX_CORRELATED_PCT: 100, MAX_EXPOSURE_PCT: 100 });
    const result = customService.evaluatePreEntryGates(
      passingInput({ openPositionsCount: 5 }), // 5 ≥ MAX_CONCURRENT_TRADES=5 → fails
    );
    expect(result).toMatchObject({ approved: false, failingGate: 'CONCURRENT_TRADES' });
  });

  it('passes CONCURRENT_TRADES when open count is one below the maximum', async () => {
    const customService = await buildService({
      MAX_CORRELATED_PCT: 100,
      MAX_EXPOSURE_PCT: 100,
      MAX_CONCENTRATION_PCT: 100,
    });
    const result = customService.evaluatePreEntryGates(
      passingInput({ openPositionsCount: 4 }), // 4 < 5 → passes
    );
    if (result.approved === false) {
      expect(result.failingGate).not.toBe('CONCURRENT_TRADES');
    }
  });

  it('respects a custom MAX_CONCURRENT_TRADES config override', async () => {
    const customService = await buildService({
      MAX_CORRELATED_PCT: 100,
      MAX_EXPOSURE_PCT: 100,
      MAX_CONCURRENT_TRADES: 2,
    });
    const result = customService.evaluatePreEntryGates(
      passingInput({ openPositionsCount: 2 }), // 2 ≥ 2 → fails
    );
    expect(result).toMatchObject({ approved: false, failingGate: 'CONCURRENT_TRADES' });
  });

  // ── Gate 8: CONCENTRATION ─────────────────────────────────────────────────

  it('rejects on CONCENTRATION when single-instrument exposure exceeds the threshold', async () => {
    // threshold = 100000 × 15% = 15000; order_exposure = 40 × 4 × 25 = 4000
    // currentInstrumentExposure = 11001 → 11001 + 4000 = 15001 > 15000
    // Gates 5 & 6 pass with MAX_EXPOSURE_PCT=100, MAX_CORRELATED_PCT=100
    const customService = await buildService({
      MAX_EXPOSURE_PCT: 100,
      MAX_CORRELATED_PCT: 100,
    });
    const result = customService.evaluatePreEntryGates(
      passingInput({ currentInstrumentExposure: '11001.00' }),
    );
    expect(result).toMatchObject({ approved: false, failingGate: 'CONCENTRATION' });
  });

  it('passes CONCENTRATION when single-instrument exposure is within the threshold', async () => {
    const customService = await buildService({
      MAX_EXPOSURE_PCT: 100,
      MAX_CORRELATED_PCT: 100,
      MAX_CONCENTRATION_PCT: 100,
    });
    const result = customService.evaluatePreEntryGates(passingInput({ openPositionsCount: 0 }));
    expect(result).toMatchObject({ approved: true });
  });

  // ── Gate ordering — first failing gate wins ──────────────────────────────

  it('returns SIGNAL_SCORE gate when score fails, even if other gates would also fail', () => {
    const result = service.evaluatePreEntryGates(
      passingInput({
        compositeScore: 50, // fails gate 1
        entryPrice: '100.00',
        stopLossPrice: '100.00', // would also fail gate 2
      }),
    );
    // Gate 1 is checked first → SIGNAL_SCORE is returned
    expect(result).toMatchObject({ approved: false, failingGate: 'SIGNAL_SCORE' });
  });

  it('returns ZERO_PER_UNIT_RISK before INVALID_LOT_SIZE when both fail', () => {
    const result = service.evaluatePreEntryGates(
      passingInput({
        entryPrice: '100.00',
        stopLossPrice: '100.00', // gate 2 fails
        lotSize: 0, // gate 3 would also fail
      }),
    );
    // Gate 2 is checked before gate 3 → ZERO_PER_UNIT_RISK is returned
    expect(result).toMatchObject({ approved: false, failingGate: 'ZERO_PER_UNIT_RISK' });
  });

  // ── Reason strings (Req 9.9, 9.11) ───────────────────────────────────────

  it('returns reason "zero per-unit risk" for ZERO_PER_UNIT_RISK gate', () => {
    const result = service.evaluatePreEntryGates(
      passingInput({ entryPrice: '100.00', stopLossPrice: '100.00' }),
    );
    expect(result).toMatchObject({ approved: false, reason: 'zero per-unit risk' });
  });

  it('returns reason "invalid lot_size configuration" for INVALID_LOT_SIZE gate', () => {
    const result = service.evaluatePreEntryGates(passingInput({ lotSize: 0 }));
    expect(result).toMatchObject({ approved: false, reason: 'invalid lot_size configuration' });
  });
});
