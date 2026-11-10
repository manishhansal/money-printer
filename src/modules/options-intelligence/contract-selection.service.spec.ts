/**
 * contract-selection.service.spec.ts
 *
 * Unit tests for ContractSelectionService (task 11.2).
 *
 * Covers:
 *  1. All 4 criteria pass → selected = true, failingCriteria = []
 *  2. Delta below minDelta → selected = false, failingCriteria includes "delta"
 *  3. Delta above maxDelta → selected = false, failingCriteria includes "delta"
 *  4. IV rank below minIvPercentile → selected = false, failingCriteria includes "iv_rank"
 *  5. IV rank above maxIvPercentile → selected = false, failingCriteria includes "iv_rank"
 *  6. OI below minOiContracts → selected = false, failingCriteria includes "oi"
 *  7. bidQty below minDepthQty → selected = false, failingCriteria includes "market_depth"
 *  8. askQty below minDepthQty → selected = false, failingCriteria includes "market_depth"
 *  9. Both bidQty and askQty below minDepthQty → single "market_depth" entry
 * 10. Multiple criteria fail → all failing criteria listed
 * 11. All 4 criteria fail → all 4 identifiers present
 * 12. PE contract, negative delta, abs within range → selected = true
 * 13. PE contract, negative delta, abs outside range → selected = false, "delta" listed
 * 14. PE contract boundary: delta = -minDelta → passes (inclusive lower bound)
 * 15. Boundary: delta exactly at minDelta → passes
 * 16. Boundary: delta exactly at maxDelta → passes
 * 17. Boundary: ivPercentileRank exactly at minIvPercentile → passes
 * 18. Boundary: ivPercentileRank exactly at maxIvPercentile → passes
 * 19. Boundary: oi exactly at minOiContracts → passes
 * 20. Boundary: bidQty and askQty exactly at minDepthQty → passes
 * 21. Result always references the original candidate object
 *
 * Requirements: 7.2
 */

import {
  ContractSelectionService,
  ContractCandidate,
  ContractSelectionConfig,
  CRITERION_DELTA,
  CRITERION_IV_RANK,
  CRITERION_OI,
  CRITERION_MARKET_DEPTH,
} from './contract-selection.service';

// ─────────────────────────────────────────────────────────────────────────────
// Base fixtures — all criteria pass when used unmodified with baseConfig / baseIvRank
// ─────────────────────────────────────────────────────────────────────────────

/** CE candidate whose base values satisfy every criterion. */
const baseCandidate: ContractCandidate = {
  securityId: '49081',
  underlying: 'NIFTY',
  optionType: 'CE',
  strikePrice: 25650,
  delta: 0.45, // abs = 0.45, within [0.20, 0.60]
  oi: 50_000, // ≥ 10 000
  impliedVolatility: 18.5,
  bidPrice: 199,
  askPrice: 201,
  bidQty: 100, // ≥ 50
  askQty: 100, // ≥ 50
};

const baseConfig: ContractSelectionConfig = {
  minDelta: 0.2,
  maxDelta: 0.6,
  minIvPercentile: 20,
  maxIvPercentile: 80,
  minOiContracts: 10_000,
  minDepthQty: 50,
};

/** IV rank that passes criterion 2 with baseConfig. */
const baseIvRank = 50; // within [20, 80]

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Shallow-clone candidate with overridden fields. */
function candidate(overrides: Partial<ContractCandidate>): ContractCandidate {
  return { ...baseCandidate, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ContractSelectionService', () => {
  let service: ContractSelectionService;

  beforeEach(() => {
    // No NestJS DI needed — the service has no injected dependencies.
    service = new ContractSelectionService();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('all criteria pass', () => {
    it('returns selected=true and empty failingCriteria', () => {
      const result = service.selectContract(baseCandidate, baseConfig, baseIvRank);

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).toEqual([]);
    });

    it('returns the original candidate object in the result', () => {
      const result = service.selectContract(baseCandidate, baseConfig, baseIvRank);

      expect(result.candidate).toBe(baseCandidate);
    });
  });

  // ── Criterion 1: delta ────────────────────────────────────────────────────

  describe('criterion 1 — delta range', () => {
    it('fails when abs(delta) is below minDelta', () => {
      const result = service.selectContract(
        candidate({ delta: 0.1 }), // abs = 0.10 < minDelta 0.20
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_DELTA);
      expect(result.failingCriteria).toHaveLength(1);
    });

    it('fails when abs(delta) is above maxDelta', () => {
      const result = service.selectContract(
        candidate({ delta: 0.8 }), // abs = 0.80 > maxDelta 0.60
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_DELTA);
      expect(result.failingCriteria).toHaveLength(1);
    });

    it('passes when abs(delta) is exactly at minDelta (inclusive lower bound)', () => {
      const result = service.selectContract(
        candidate({ delta: 0.2 }), // abs = 0.20 = minDelta
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).not.toContain(CRITERION_DELTA);
    });

    it('passes when abs(delta) is exactly at maxDelta (inclusive upper bound)', () => {
      const result = service.selectContract(
        candidate({ delta: 0.6 }), // abs = 0.60 = maxDelta
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).not.toContain(CRITERION_DELTA);
    });
  });

  // ── Criterion 2: IV percentile rank ───────────────────────────────────────

  describe('criterion 2 — IV percentile rank', () => {
    it('fails when ivPercentileRank is below minIvPercentile', () => {
      const result = service.selectContract(
        baseCandidate,
        baseConfig,
        10, // below minIvPercentile 20
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_IV_RANK);
      expect(result.failingCriteria).toHaveLength(1);
    });

    it('fails when ivPercentileRank is above maxIvPercentile', () => {
      const result = service.selectContract(
        baseCandidate,
        baseConfig,
        90, // above maxIvPercentile 80
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_IV_RANK);
      expect(result.failingCriteria).toHaveLength(1);
    });

    it('passes when ivPercentileRank is exactly at minIvPercentile (inclusive lower bound)', () => {
      const result = service.selectContract(baseCandidate, baseConfig, 20);

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).not.toContain(CRITERION_IV_RANK);
    });

    it('passes when ivPercentileRank is exactly at maxIvPercentile (inclusive upper bound)', () => {
      const result = service.selectContract(baseCandidate, baseConfig, 80);

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).not.toContain(CRITERION_IV_RANK);
    });
  });

  // ── Criterion 3: open interest ────────────────────────────────────────────

  describe('criterion 3 — open interest', () => {
    it('fails when oi is below minOiContracts', () => {
      const result = service.selectContract(
        candidate({ oi: 5_000 }), // below minOiContracts 10 000
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_OI);
      expect(result.failingCriteria).toHaveLength(1);
    });

    it('passes when oi is exactly at minOiContracts (inclusive)', () => {
      const result = service.selectContract(
        candidate({ oi: 10_000 }), // exactly at minOiContracts
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).not.toContain(CRITERION_OI);
    });
  });

  // ── Criterion 4: market depth ─────────────────────────────────────────────

  describe('criterion 4 — market depth', () => {
    it('fails when bidQty is below minDepthQty', () => {
      const result = service.selectContract(
        candidate({ bidQty: 10 }), // below minDepthQty 50
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_MARKET_DEPTH);
      expect(result.failingCriteria).toHaveLength(1);
    });

    it('fails when askQty is below minDepthQty', () => {
      const result = service.selectContract(
        candidate({ askQty: 10 }), // below minDepthQty 50
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_MARKET_DEPTH);
      expect(result.failingCriteria).toHaveLength(1);
    });

    it('produces only one "market_depth" entry when both bidQty and askQty fail', () => {
      const result = service.selectContract(
        candidate({ bidQty: 10, askQty: 10 }),
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(false);
      // Single entry — not duplicated for each failing side
      expect(result.failingCriteria.filter((c) => c === CRITERION_MARKET_DEPTH)).toHaveLength(1);
    });

    it('passes when both bidQty and askQty are exactly at minDepthQty (inclusive)', () => {
      const result = service.selectContract(
        candidate({ bidQty: 50, askQty: 50 }), // exactly at minDepthQty
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).not.toContain(CRITERION_MARKET_DEPTH);
    });
  });

  // ── Multiple criteria failing ──────────────────────────────────────────────

  describe('multiple failing criteria', () => {
    it('lists all 3 failing criteria when delta, iv_rank, and oi fail', () => {
      const result = service.selectContract(
        candidate({ delta: 0.05, oi: 100 }), // delta below min, oi below min
        baseConfig,
        5, // iv_rank below min
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_DELTA);
      expect(result.failingCriteria).toContain(CRITERION_IV_RANK);
      expect(result.failingCriteria).toContain(CRITERION_OI);
      expect(result.failingCriteria).toHaveLength(3);
    });

    it('lists all 4 criteria when every criterion fails', () => {
      const result = service.selectContract(
        candidate({
          delta: 0.05, // abs = 0.05 < minDelta 0.20
          oi: 100, // below minOiContracts 10 000
          bidQty: 5, // below minDepthQty 50
          askQty: 5, // below minDepthQty 50
        }),
        baseConfig,
        5, // below minIvPercentile 20
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_DELTA);
      expect(result.failingCriteria).toContain(CRITERION_IV_RANK);
      expect(result.failingCriteria).toContain(CRITERION_OI);
      expect(result.failingCriteria).toContain(CRITERION_MARKET_DEPTH);
      expect(result.failingCriteria).toHaveLength(4);
    });

    it('does not short-circuit — evaluates all criteria even after first failure', () => {
      // delta fails; if short-circuiting occurred, oi and iv_rank would be absent
      const result = service.selectContract(candidate({ delta: 0.05, oi: 100 }), baseConfig, 5);

      // Confirm all 3 failing criteria are present, not just the first
      expect(result.failingCriteria).toHaveLength(3);
    });
  });

  // ── PE contracts — absolute value delta check ─────────────────────────────

  describe('PE contracts — abs(delta) evaluation', () => {
    it('returns selected=true for a PE contract whose abs(delta) is within range', () => {
      const result = service.selectContract(
        candidate({ optionType: 'PE', delta: -0.45 }), // abs = 0.45, within [0.20, 0.60]
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).toEqual([]);
    });

    it('returns selected=false for a PE contract whose abs(delta) exceeds maxDelta', () => {
      const result = service.selectContract(
        candidate({ optionType: 'PE', delta: -0.8 }), // abs = 0.80 > maxDelta 0.60
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_DELTA);
    });

    it('returns selected=false for a PE contract whose abs(delta) is below minDelta', () => {
      const result = service.selectContract(
        candidate({ optionType: 'PE', delta: -0.05 }), // abs = 0.05 < minDelta 0.20
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_DELTA);
    });

    it('passes at the lower boundary: PE delta = -(minDelta)', () => {
      const result = service.selectContract(
        candidate({ optionType: 'PE', delta: -0.2 }), // abs = 0.20 = minDelta
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).not.toContain(CRITERION_DELTA);
    });

    it('passes at the upper boundary: PE delta = -(maxDelta)', () => {
      const result = service.selectContract(
        candidate({ optionType: 'PE', delta: -0.6 }), // abs = 0.60 = maxDelta
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(true);
      expect(result.failingCriteria).not.toContain(CRITERION_DELTA);
    });

    it('treats a deep-ITM PE (delta near -1.0) the same as a CE with delta near 1.0', () => {
      // abs(-0.95) = 0.95 > maxDelta 0.60 → should fail criterion 1
      const result = service.selectContract(
        candidate({ optionType: 'PE', delta: -0.95 }),
        baseConfig,
        baseIvRank,
      );

      expect(result.selected).toBe(false);
      expect(result.failingCriteria).toContain(CRITERION_DELTA);
    });
  });
});
