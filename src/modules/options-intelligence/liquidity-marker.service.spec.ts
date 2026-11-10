/**
 * liquidity-marker.service.spec.ts
 *
 * Unit tests for LiquidityMarkerService (task 11.6).
 *
 * Covers:
 *  1.  Spread within threshold → isIlliquid = false, liquidityPenalty = 0.
 *  2.  Spread above threshold → isIlliquid = true, liquidityPenalty = default
 *      configured penalty (10).
 *  3.  Zero spread (bidPrice = askPrice) → isIlliquid = false.
 *  4.  Spread exactly equal to threshold → isIlliquid = false (strictly
 *      greater than, NOT >=).
 *  5.  Custom MAX_SPREAD_THRESHOLD_PCT via config.
 *  6.  Custom ILLIQUID_LIQUIDITY_PENALTY via config is applied when illiquid.
 *  7.  assessLiquidity returns correct spreadRupees and spreadPct values.
 *  8.  assessLiquidity returns all input fields verbatim (securityId,
 *      bidPrice, askPrice).
 *  9.  isIlliquid() convenience method returns false for liquid contract.
 * 10.  isIlliquid() convenience method returns true for illiquid contract.
 * 11.  Penalty is exactly 0 when contract is liquid regardless of configured
 *      ILLIQUID_LIQUIDITY_PENALTY.
 * 12.  Spread just below threshold (threshold - epsilon) → liquid.
 * 13.  Spread just above threshold (threshold + epsilon) → illiquid.
 *
 * Requirements: 7.6
 */

import { LiquidityMarkerService } from './liquidity-marker.service';
import { ConfigService } from '@nestjs/config';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a mock ConfigService whose `get` returns values from the provided
 * `overrides` map, falling back to `defaultValue` for unknown keys — matching
 * the real NestJS ConfigService behaviour.
 */
function makeConfigService(overrides: Record<string, string | number> = {}): ConfigService {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        return overrides[key] as unknown as T;
      }
      return defaultValue as T;
    },
  } as unknown as ConfigService;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('LiquidityMarkerService', () => {
  // Default configured values
  const DEFAULT_PENALTY = 10;

  // A representative security ID used throughout tests
  const SECURITY_ID = 'NIFTY-CE-25000';

  // ── assessLiquidity — spread within threshold ─────────────────────────────

  describe('assessLiquidity() — spread within threshold', () => {
    it('marks contract as liquid (isIlliquid = false) when spread is below default threshold', () => {
      // spreadPct = 1.5 / 100 * 100 = 1.5% < 2.0%
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 100, 101.5);
      expect(result.isIlliquid).toBe(false);
    });

    it('returns liquidityPenalty = 0 when spread is below default threshold', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 100, 101.5);
      expect(result.liquidityPenalty).toBe(0);
    });
  });

  // ── assessLiquidity — spread above threshold ──────────────────────────────

  describe('assessLiquidity() — spread above threshold', () => {
    it('marks contract as illiquid (isIlliquid = true) when spread exceeds default threshold', () => {
      // spreadPct = 3 / 100 * 100 = 3.0% > 2.0%
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 100, 103);
      expect(result.isIlliquid).toBe(true);
    });

    it('returns liquidityPenalty = DEFAULT_PENALTY when spread exceeds default threshold', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 100, 103);
      expect(result.liquidityPenalty).toBe(DEFAULT_PENALTY);
    });
  });

  // ── assessLiquidity — zero spread ─────────────────────────────────────────

  describe('assessLiquidity() — zero spread', () => {
    it('marks contract as liquid when bidPrice equals askPrice (zero spread)', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 100, 100);
      expect(result.isIlliquid).toBe(false);
    });

    it('returns spreadRupees = 0 and spreadPct = 0 for zero spread', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 100, 100);
      expect(result.spreadRupees).toBe(0);
      expect(result.spreadPct).toBe(0);
    });

    it('returns liquidityPenalty = 0 for zero spread', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 100, 100);
      expect(result.liquidityPenalty).toBe(0);
    });
  });

  // ── assessLiquidity — exact threshold (strictly greater than) ─────────────

  describe('assessLiquidity() — spread exactly equal to threshold', () => {
    it('is NOT illiquid when spreadPct equals the threshold exactly (strict > check)', () => {
      // bidPrice = 100, askPrice = 102 → spreadPct = 2.0% == default threshold 2.0%
      // Expected: liquid because the check is strictly greater than, not >=
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 100, 102);
      expect(result.isIlliquid).toBe(false);
    });

    it('returns liquidityPenalty = 0 when spreadPct equals threshold exactly', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 100, 102);
      expect(result.liquidityPenalty).toBe(0);
    });
  });

  // ── assessLiquidity — custom threshold via config ─────────────────────────

  describe('assessLiquidity() — custom MAX_SPREAD_THRESHOLD_PCT', () => {
    it('uses custom threshold from config: spread above custom threshold → illiquid', () => {
      // Custom threshold = 1.0%; spreadPct = 1.5% > 1.0% → illiquid
      const service = new LiquidityMarkerService(
        makeConfigService({ MAX_SPREAD_THRESHOLD_PCT: 1.0 }),
      );
      const result = service.assessLiquidity(SECURITY_ID, 100, 101.5);
      expect(result.isIlliquid).toBe(true);
    });

    it('uses custom threshold from config: spread below custom threshold → liquid', () => {
      // Custom threshold = 3.0%; spreadPct = 1.5% < 3.0% → liquid
      const service = new LiquidityMarkerService(
        makeConfigService({ MAX_SPREAD_THRESHOLD_PCT: 3.0 }),
      );
      const result = service.assessLiquidity(SECURITY_ID, 100, 101.5);
      expect(result.isIlliquid).toBe(false);
    });

    it('respects exact custom threshold: spreadPct == custom threshold → liquid', () => {
      // Custom threshold = 1.5%; spreadPct = 1.5% == 1.5% → NOT illiquid (strict >)
      const service = new LiquidityMarkerService(
        makeConfigService({ MAX_SPREAD_THRESHOLD_PCT: 1.5 }),
      );
      const result = service.assessLiquidity(SECURITY_ID, 100, 101.5);
      expect(result.isIlliquid).toBe(false);
    });
  });

  // ── assessLiquidity — custom penalty via config ───────────────────────────

  describe('assessLiquidity() — custom ILLIQUID_LIQUIDITY_PENALTY', () => {
    it('applies custom penalty when contract is illiquid', () => {
      // Spread above threshold, penalty configured to 7
      const service = new LiquidityMarkerService(
        makeConfigService({ ILLIQUID_LIQUIDITY_PENALTY: 7 }),
      );
      const result = service.assessLiquidity(SECURITY_ID, 100, 103);
      expect(result.isIlliquid).toBe(true);
      expect(result.liquidityPenalty).toBe(7);
    });

    it('returns liquidityPenalty = 0 regardless of configured penalty when contract is liquid', () => {
      // Spread within threshold, penalty configured to 7
      const service = new LiquidityMarkerService(
        makeConfigService({ ILLIQUID_LIQUIDITY_PENALTY: 7 }),
      );
      const result = service.assessLiquidity(SECURITY_ID, 100, 101.5);
      expect(result.isIlliquid).toBe(false);
      expect(result.liquidityPenalty).toBe(0);
    });
  });

  // ── assessLiquidity — computed spread fields ──────────────────────────────

  describe('assessLiquidity() — computed spread values', () => {
    it('returns correct spreadRupees (askPrice − bidPrice)', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 200, 205);
      expect(result.spreadRupees).toBeCloseTo(5, 10);
    });

    it('returns correct spreadPct ((spreadRupees / bidPrice) × 100)', () => {
      // bidPrice = 200, askPrice = 205 → spreadRupees = 5 → spreadPct = 2.5%
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 200, 205);
      expect(result.spreadPct).toBeCloseTo(2.5, 10);
    });

    it('returns input fields verbatim (securityId, bidPrice, askPrice)', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity('SEC-42', 150.5, 153.0);
      expect(result.securityId).toBe('SEC-42');
      expect(result.bidPrice).toBe(150.5);
      expect(result.askPrice).toBe(153.0);
    });
  });

  // ── assessLiquidity — boundary epsilon tests ──────────────────────────────

  describe('assessLiquidity() — spread just below/above threshold', () => {
    it('spread just below threshold (threshold − small epsilon) → liquid', () => {
      // threshold = 2.0%; bid = 1000, ask = 1019.99 → spreadPct ≈ 1.999% < 2.0%
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 1000, 1019.99);
      expect(result.isIlliquid).toBe(false);
    });

    it('spread just above threshold (threshold + small epsilon) → illiquid', () => {
      // threshold = 2.0%; bid = 1000, ask = 1020.01 → spreadPct ≈ 2.001% > 2.0%
      const service = new LiquidityMarkerService(makeConfigService());
      const result = service.assessLiquidity(SECURITY_ID, 1000, 1020.01);
      expect(result.isIlliquid).toBe(true);
    });
  });

  // ── isIlliquid() convenience method ──────────────────────────────────────

  describe('isIlliquid()', () => {
    it('returns false for a liquid contract (spread within threshold)', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      expect(service.isIlliquid(SECURITY_ID, 100, 101.5)).toBe(false);
    });

    it('returns true for an illiquid contract (spread above threshold)', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      expect(service.isIlliquid(SECURITY_ID, 100, 103)).toBe(true);
    });

    it('returns false when spread equals threshold exactly (strictly greater than check)', () => {
      // bidPrice = 100, askPrice = 102 → spreadPct = 2.0% == threshold
      const service = new LiquidityMarkerService(makeConfigService());
      expect(service.isIlliquid(SECURITY_ID, 100, 102)).toBe(false);
    });

    it('returns false for zero spread', () => {
      const service = new LiquidityMarkerService(makeConfigService());
      expect(service.isIlliquid(SECURITY_ID, 100, 100)).toBe(false);
    });

    it('respects custom threshold from config', () => {
      // Custom threshold = 1.0%; spread = 1.5% > 1.0% → illiquid
      const service = new LiquidityMarkerService(
        makeConfigService({ MAX_SPREAD_THRESHOLD_PCT: 1.0 }),
      );
      expect(service.isIlliquid(SECURITY_ID, 100, 101.5)).toBe(true);
    });
  });
});
