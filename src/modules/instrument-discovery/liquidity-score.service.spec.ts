/**
 * liquidity-score.service.spec.ts
 *
 * Unit tests and property-based tests for LiquidityScoreService.
 *
 * Covers:
 *  Unit tests:
 *   1. computeVolumeScore  — typical cases, zero avg, capped at 2×, edge values.
 *   2. computeOiScore      — typical cases, zero OI, OI at / above reference.
 *   3. computeSpreadScore  — typical cases, null prices, zero bid, spread ≥ max.
 *   4. computeDepthScore   — typical cases, zero depth, depth at / above reference.
 *   5. computeBestQtyScore — typical cases, null quantities, above reference.
 *   6. computeLiquidityScore — full composite: known inputs, zero inputs, max inputs.
 *
 *  Property-based test (fast-check):
 *   Property 1: Liquidity Score Range Invariant
 *     For any structurally valid LiquidityScoreInput, computeLiquidityScore
 *     must return a value in [0, 100].
 *
 * Requirements: 4.2
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fc from 'fast-check';
import { LiquidityScoreService, LiquidityScoreInput } from './liquidity-score.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ConfigService stub that returns defaults for all env keys. */
function buildMockConfigService() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: jest.fn().mockImplementation((_key: string, defaultVal?: any) => defaultVal),
  };
}

/** Fully-liquid reference input (all components at maximum). */
const FULL_LIQUID_INPUT: LiquidityScoreInput = {
  currentVolume: 1_000_000,
  avgVolume30Day: 500_000,
  openInterest: 500_000,
  bidPrice: 100,
  askPrice: 100, // zero spread → max spread score
  marketDepthBidQty5: 5_000,
  marketDepthAskQty5: 5_000,
  bestBidQty: 250,
  bestAskQty: 250,
};

/** Fully-illiquid reference input (all components at zero / null). */
const ZERO_INPUT: LiquidityScoreInput = {
  currentVolume: 0,
  avgVolume30Day: 0,
  openInterest: 0,
  bidPrice: null,
  askPrice: null,
  marketDepthBidQty5: 0,
  marketDepthAskQty5: 0,
  bestBidQty: null,
  bestAskQty: null,
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('LiquidityScoreService', () => {
  let service: LiquidityScoreService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiquidityScoreService,
        { provide: ConfigService, useValue: buildMockConfigService() },
      ],
    }).compile();

    service = module.get<LiquidityScoreService>(LiquidityScoreService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. computeVolumeScore
  // ─────────────────────────────────────────────────────────────────────────

  describe('computeVolumeScore()', () => {
    it('returns 50 when current volume equals the 30-day average', () => {
      expect(service.computeVolumeScore(10_000, 10_000)).toBeCloseTo(50);
    });

    it('returns 100 when current volume is exactly double the 30-day average', () => {
      expect(service.computeVolumeScore(20_000, 10_000)).toBeCloseTo(100);
    });

    it('returns 100 when current volume exceeds double the 30-day average (capped)', () => {
      expect(service.computeVolumeScore(50_000, 10_000)).toBeCloseTo(100);
    });

    it('returns 0 when current volume is zero', () => {
      expect(service.computeVolumeScore(0, 10_000)).toBeCloseTo(0);
    });

    it('uses denominator of 1 when avgVolume30Day is zero (avoids division by zero)', () => {
      // currentVolume=2 → ratio = min(2/1, 2.0) = 2.0 → score = 100
      expect(service.computeVolumeScore(2, 0)).toBeCloseTo(100);
    });

    it('returns 0 when both volumes are zero', () => {
      expect(service.computeVolumeScore(0, 0)).toBeCloseTo(0);
    });

    it('returns a proportional value for a volume below the 30-day average', () => {
      // 5000 / 10000 = 0.5 ratio → score = 25
      expect(service.computeVolumeScore(5_000, 10_000)).toBeCloseTo(25);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. computeOiScore
  // ─────────────────────────────────────────────────────────────────────────

  describe('computeOiScore()', () => {
    it('returns 0 when open interest is zero', () => {
      expect(service.computeOiScore(0)).toBeCloseTo(0);
    });

    it('returns 100 when open interest equals the reference (500_000)', () => {
      expect(service.computeOiScore(500_000)).toBeCloseTo(100);
    });

    it('returns 100 when open interest exceeds the reference (capped)', () => {
      expect(service.computeOiScore(1_000_000)).toBeCloseTo(100);
    });

    it('returns 50 when open interest is half the reference', () => {
      expect(service.computeOiScore(250_000)).toBeCloseTo(50);
    });

    it('returns a proportional value for a typical OI', () => {
      // 100_000 / 500_000 = 0.2 → 20
      expect(service.computeOiScore(100_000)).toBeCloseTo(20);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. computeSpreadScore
  // ─────────────────────────────────────────────────────────────────────────

  describe('computeSpreadScore()', () => {
    it('returns 0 when bidPrice is null', () => {
      expect(service.computeSpreadScore(null, 100)).toBeCloseTo(0);
    });

    it('returns 0 when askPrice is null', () => {
      expect(service.computeSpreadScore(100, null)).toBeCloseTo(0);
    });

    it('returns 0 when both prices are null', () => {
      expect(service.computeSpreadScore(null, null)).toBeCloseTo(0);
    });

    it('returns 0 when bidPrice is zero (guard against division by zero)', () => {
      expect(service.computeSpreadScore(0, 100)).toBeCloseTo(0);
    });

    it('returns 100 for a zero spread (bid === ask)', () => {
      expect(service.computeSpreadScore(100, 100)).toBeCloseTo(100);
    });

    it('returns 0 when spread equals maxSpreadPct (2%)', () => {
      // bid=100, ask=102 → spreadPct = 2% = maxSpreadPct → score = 0
      expect(service.computeSpreadScore(100, 102)).toBeCloseTo(0);
    });

    it('returns 0 when spread exceeds maxSpreadPct (clamped at 0, not negative)', () => {
      // bid=100, ask=110 → spreadPct = 10% > 2% → clamped to 0
      expect(service.computeSpreadScore(100, 110)).toBeCloseTo(0);
    });

    it('returns 50 for a spread equal to half of maxSpreadPct', () => {
      // bid=100, ask=101 → spreadPct = 1% = 2%/2 → score = max(0, 1 - 0.5) × 100 = 50
      expect(service.computeSpreadScore(100, 101)).toBeCloseTo(50);
    });

    it('computes correctly for a realistic NSE option spread', () => {
      // bid=150.00, ask=150.15 → spreadPct ≈ 0.1% → score ≈ 95
      const score = service.computeSpreadScore(150.0, 150.15);
      expect(score).toBeGreaterThan(90);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. computeDepthScore
  // ─────────────────────────────────────────────────────────────────────────

  describe('computeDepthScore()', () => {
    it('returns 0 when both depth quantities are zero', () => {
      expect(service.computeDepthScore(0, 0)).toBeCloseTo(0);
    });

    it('returns 100 when total depth equals the reference (10_000)', () => {
      expect(service.computeDepthScore(5_000, 5_000)).toBeCloseTo(100);
    });

    it('returns 100 when total depth exceeds the reference (capped)', () => {
      expect(service.computeDepthScore(8_000, 8_000)).toBeCloseTo(100);
    });

    it('returns 50 when total depth is half the reference', () => {
      expect(service.computeDepthScore(2_500, 2_500)).toBeCloseTo(50);
    });

    it('handles asymmetric bid/ask depth correctly', () => {
      // 3000 + 1000 = 4000; 4000 / 10000 = 0.4 → 40
      expect(service.computeDepthScore(3_000, 1_000)).toBeCloseTo(40);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. computeBestQtyScore
  // ─────────────────────────────────────────────────────────────────────────

  describe('computeBestQtyScore()', () => {
    it('returns 0 when both quantities are null', () => {
      expect(service.computeBestQtyScore(null, null)).toBeCloseTo(0);
    });

    it('returns 0 when both quantities are zero', () => {
      expect(service.computeBestQtyScore(0, 0)).toBeCloseTo(0);
    });

    it('treats null quantities as zero', () => {
      // bestBidQty=null → 0; bestAskQty=250 → total=250 / 500 = 0.5 → 50
      expect(service.computeBestQtyScore(null, 250)).toBeCloseTo(50);
    });

    it('returns 100 when total best quantity equals the reference (500)', () => {
      expect(service.computeBestQtyScore(250, 250)).toBeCloseTo(100);
    });

    it('returns 100 when total best quantity exceeds the reference (capped)', () => {
      expect(service.computeBestQtyScore(400, 400)).toBeCloseTo(100);
    });

    it('returns 50 when total best quantity is half the reference', () => {
      expect(service.computeBestQtyScore(125, 125)).toBeCloseTo(50);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. computeLiquidityScore — composite
  // ─────────────────────────────────────────────────────────────────────────

  describe('computeLiquidityScore()', () => {
    it('returns 100 for a fully-liquid instrument (all components maxed out)', () => {
      expect(service.computeLiquidityScore(FULL_LIQUID_INPUT)).toBeCloseTo(100);
    });

    it('returns 0 for a fully-illiquid instrument (all components at zero/null)', () => {
      expect(service.computeLiquidityScore(ZERO_INPUT)).toBeCloseTo(0);
    });

    it('returns a value in [0, 100] for a typical real-world input', () => {
      const input: LiquidityScoreInput = {
        currentVolume: 15_000,
        avgVolume30Day: 20_000,
        openInterest: 150_000,
        bidPrice: 200,
        askPrice: 200.5,
        marketDepthBidQty5: 1_200,
        marketDepthAskQty5: 1_000,
        bestBidQty: 80,
        bestAskQty: 60,
      };
      const score = service.computeLiquidityScore(input);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('applies the correct weights to each component', () => {
      // Craft an input where only the volume component is non-zero.
      // volume: currentVolume = avgVolume30Day × 2 → volumeScore = 100
      // OI: 0 → 0
      // spread: null → 0
      // depth: 0 → 0
      // bestQty: null → 0
      // composite = 0.25 × 100 = 25
      const input: LiquidityScoreInput = {
        currentVolume: 20_000,
        avgVolume30Day: 10_000,
        openInterest: 0,
        bidPrice: null,
        askPrice: null,
        marketDepthBidQty5: 0,
        marketDepthAskQty5: 0,
        bestBidQty: null,
        bestAskQty: null,
      };
      expect(service.computeLiquidityScore(input)).toBeCloseTo(25);
    });

    it('applies OI weight of 25%', () => {
      // Only OI component maxed; all others zero.
      const input: LiquidityScoreInput = {
        currentVolume: 0,
        avgVolume30Day: 0,
        openInterest: 500_000, // maxed
        bidPrice: null,
        askPrice: null,
        marketDepthBidQty5: 0,
        marketDepthAskQty5: 0,
        bestBidQty: null,
        bestAskQty: null,
      };
      expect(service.computeLiquidityScore(input)).toBeCloseTo(25);
    });

    it('applies spread weight of 20%', () => {
      // Only spread component maxed (zero spread); all others zero.
      const input: LiquidityScoreInput = {
        currentVolume: 0,
        avgVolume30Day: 0,
        openInterest: 0,
        bidPrice: 100,
        askPrice: 100, // zero spread → spreadScore = 100
        marketDepthBidQty5: 0,
        marketDepthAskQty5: 0,
        bestBidQty: null,
        bestAskQty: null,
      };
      expect(service.computeLiquidityScore(input)).toBeCloseTo(20);
    });

    it('applies depth weight of 15%', () => {
      // Only depth component maxed; all others zero.
      const input: LiquidityScoreInput = {
        currentVolume: 0,
        avgVolume30Day: 0,
        openInterest: 0,
        bidPrice: null,
        askPrice: null,
        marketDepthBidQty5: 5_000,
        marketDepthAskQty5: 5_000, // total = 10_000 = reference → depthScore = 100
        bestBidQty: null,
        bestAskQty: null,
      };
      expect(service.computeLiquidityScore(input)).toBeCloseTo(15);
    });

    it('applies best-qty weight of 15%', () => {
      // Only best-qty component maxed; all others zero.
      const input: LiquidityScoreInput = {
        currentVolume: 0,
        avgVolume30Day: 0,
        openInterest: 0,
        bidPrice: null,
        askPrice: null,
        marketDepthBidQty5: 0,
        marketDepthAskQty5: 0,
        bestBidQty: 250,
        bestAskQty: 250, // total = 500 = reference → bestQtyScore = 100
      };
      expect(service.computeLiquidityScore(input)).toBeCloseTo(15);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 1: Liquidity Score Range Invariant
  // Validates: Requirements 4.2
  // ─────────────────────────────────────────────────────────────────────────

  describe('Property 1: Liquidity Score Range Invariant', () => {
    /**
     * **Validates: Requirements 4.2**
     *
     * For any structurally valid LiquidityScoreInput, computeLiquidityScore
     * must return a value in the closed interval [0, 100].
     */
    it('always returns a value in [0, 100] for any valid input', () => {
      // Generator for a non-negative finite double (contracts or price).
      const nonNegativeFinite = fc
        .double({ min: 0, max: 1e9, noNaN: true, noDefaultInfinity: true })
        .filter((v) => isFinite(v) && v >= 0);

      // Generator for a positive bid price (must be > 0 for spread calc).
      const positiveBidPrice = fc
        .double({ min: 1e-4, max: 1e6, noNaN: true, noDefaultInfinity: true })
        .filter((v) => isFinite(v) && v > 0);

      // Generator for ask price that is >= bid price (within 10× to keep spread realistic).
      const askAboveBid = (bid: number) =>
        fc
          .double({ min: bid, max: bid + bid * 10 + 1000, noNaN: true, noDefaultInfinity: true })
          .filter((v) => isFinite(v) && v >= bid);

      // Nullable number generator (null or a non-negative finite number).
      const nullableNonNeg = fc.option(nonNegativeFinite, { nil: null });

      // Arbitrary for the bid/ask pair (both present with valid relationship, or both null).
      const bidAskArb = fc.oneof(
        // Both present and valid
        positiveBidPrice.chain((bid) =>
          askAboveBid(bid).map((ask) => ({
            bidPrice: bid as number | null,
            askPrice: ask as number | null,
          })),
        ),
        // Both null
        fc.constant({ bidPrice: null as number | null, askPrice: null as number | null }),
      );

      const inputArbitrary = fc
        .tuple(
          nonNegativeFinite, // currentVolume
          nonNegativeFinite, // avgVolume30Day
          nonNegativeFinite, // openInterest
          bidAskArb, // { bidPrice, askPrice }
          nonNegativeFinite, // marketDepthBidQty5
          nonNegativeFinite, // marketDepthAskQty5
          nullableNonNeg, // bestBidQty
          nullableNonNeg, // bestAskQty
        )
        .map(
          ([
            currentVolume,
            avgVolume30Day,
            openInterest,
            { bidPrice, askPrice },
            marketDepthBidQty5,
            marketDepthAskQty5,
            bestBidQty,
            bestAskQty,
          ]): LiquidityScoreInput => ({
            currentVolume,
            avgVolume30Day,
            openInterest,
            bidPrice,
            askPrice,
            marketDepthBidQty5,
            marketDepthAskQty5,
            bestBidQty,
            bestAskQty,
          }),
        );

      fc.assert(
        fc.property(inputArbitrary, (input) => {
          const score = service.computeLiquidityScore(input);
          return score >= 0 && score <= 100;
        }),
        { numRuns: 1000 },
      );
    });
  });
});
