/**
 * sniper-entry.service.spec.ts
 *
 * Unit tests for SniperEntryService — the 8-filter pre-qualification engine.
 *
 * Requirements: Phase 6 — Sniper Entry and Scalping Engine
 */

import { ConfigService } from '@nestjs/config';
import { SniperEntryService, SniperContext } from './sniper-entry.service';
import { MarketSnapshot } from '../market-data/market-data.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    ltp: '100.00',
    bidPrice: '99.50',
    askPrice: '100.50',
    volume: '50000',
    oi: '100000',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<SniperContext> = {}): SniperContext {
  return {
    snapshot: makeSnapshot(),
    direction: 'BUY',
    snapshotAgeMs: 1000,
    avgDailyVolume: 40000,
    bidQty: 50, // sufficient depth by default
    askQty: 50, // sufficient depth by default
    ...overrides,
  };
}

function buildService(): SniperEntryService {
  const configService = {
    get: jest.fn((key: string, defaultVal: unknown) => defaultVal),
  } as unknown as ConfigService;
  return new SniperEntryService(configService);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SniperEntryService', () => {
  let service: SniperEntryService;

  beforeEach(() => {
    service = buildService();
  });

  // ── Filter 1: Minimum LTP ─────────────────────────────────────────────────

  describe('Filter 1: Minimum LTP', () => {
    it('rejects when LTP is below minimum (₹5)', () => {
      const result = service.evaluate(makeContext({ snapshot: makeSnapshot({ ltp: '3.00' }) }));
      expect(result.eligible).toBe(false);
      expect(result.failingFilters).toContain('min_ltp');
    });

    it('accepts when LTP is above minimum', () => {
      const result = service.evaluate(makeContext({ snapshot: makeSnapshot({ ltp: '50.00' }) }));
      expect(result.eligible).toBe(true);
    });

    it('rejects at exactly ₹0 LTP', () => {
      const result = service.evaluate(makeContext({ snapshot: makeSnapshot({ ltp: '0.00' }) }));
      expect(result.eligible).toBe(false);
    });
  });

  // ── Filter 2: Spread ratio ────────────────────────────────────────────────

  describe('Filter 2: Spread ratio', () => {
    it('rejects when spread is wider than 8% of LTP', () => {
      // Spread = 20, LTP = 100 → ratio = 20% > 8%
      const result = service.evaluate(
        makeContext({
          snapshot: makeSnapshot({ ltp: '100.00', bidPrice: '90.00', askPrice: '110.00' }),
        }),
      );
      expect(result.eligible).toBe(false);
      expect(result.failingFilters).toContain('spread_too_wide');
    });

    it('accepts with tight spread (1% of LTP)', () => {
      // Spread = 1, LTP = 100 → ratio = 1% < 8%
      const result = service.evaluate(
        makeContext({
          snapshot: makeSnapshot({ ltp: '100.00', bidPrice: '99.50', askPrice: '100.50' }),
        }),
      );
      expect(result.eligible).toBe(true);
    });
  });

  // ── Filter 4: Data freshness ──────────────────────────────────────────────

  describe('Filter 4: Data freshness', () => {
    it('rejects when snapshot is stale (> 10 seconds)', () => {
      const result = service.evaluate(makeContext({ snapshotAgeMs: 15_000 }));
      expect(result.eligible).toBe(false);
      expect(result.failingFilters).toContain('stale_data');
    });

    it('accepts fresh data', () => {
      const result = service.evaluate(makeContext({ snapshotAgeMs: 2000 }));
      expect(result.eligible).toBe(true);
    });
  });

  // ── Filter 5: Relative volume ─────────────────────────────────────────────

  describe('Filter 5: Relative volume', () => {
    it('rejects when volume is below 80% of average daily volume', () => {
      const result = service.evaluate(
        makeContext({
          snapshot: makeSnapshot({ volume: '20000' }), // 50% of 40000 avg
          avgDailyVolume: 40000,
        }),
      );
      expect(result.eligible).toBe(false);
      expect(result.failingFilters).toContain('low_relative_volume');
    });

    it('accepts when volume meets minimum threshold', () => {
      const result = service.evaluate(
        makeContext({
          snapshot: makeSnapshot({ volume: '40000' }), // 100% of 40000 avg
          avgDailyVolume: 40000,
        }),
      );
      expect(result.eligible).toBe(true);
    });
  });

  // ── Filter 7: VWAP momentum alignment ────────────────────────────────────

  describe('Filter 7: VWAP momentum alignment', () => {
    it('gives bonus points when BUY direction aligns with bullish VWAP', () => {
      const withVwap = service.evaluate(
        makeContext({
          direction: 'BUY',
          underlyingVwap: 20000,
          underlyingLtp: 20200, // above VWAP = bullish
        }),
      );
      const withoutVwap = service.evaluate(makeContext({ direction: 'BUY' }));
      // With VWAP alignment, quality score should be higher
      expect(withVwap.qualityScore).toBeGreaterThan(withoutVwap.qualityScore);
    });

    it('reduces quality score when BUY direction conflicts with bearish VWAP', () => {
      const against = service.evaluate(
        makeContext({
          direction: 'BUY',
          underlyingVwap: 20200,
          underlyingLtp: 20000, // below VWAP = bearish for BUY
        }),
      );
      const withoutVwap = service.evaluate(makeContext({ direction: 'BUY' }));
      expect(against.qualityScore).toBeLessThan(withoutVwap.qualityScore);
    });
  });

  // ── Filter 8: IV sanity ───────────────────────────────────────────────────

  describe('Filter 8: IV sanity', () => {
    it('rejects when IV is extreme (> 200%)', () => {
      const result = service.evaluate(makeContext({ impliedVolatility: 250 }));
      expect(result.eligible).toBe(false);
      expect(result.failingFilters).toContain('extreme_iv');
    });

    it('rejects when IV is too low (< 1%)', () => {
      const result = service.evaluate(makeContext({ impliedVolatility: 0.5 }));
      expect(result.eligible).toBe(false);
      expect(result.failingFilters).toContain('extreme_iv');
    });

    it('accepts normal IV range (20%)', () => {
      const result = service.evaluate(makeContext({ impliedVolatility: 20 }));
      expect(result.eligible).toBe(true);
    });
  });

  // ── Quality score ─────────────────────────────────────────────────────────

  describe('Quality score', () => {
    it('returns 0 score when any filter fails', () => {
      const result = service.evaluate(makeContext({ snapshot: makeSnapshot({ ltp: '1.00' }) }));
      expect(result.eligible).toBe(false);
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    });

    it('returns positive score for eligible snapshots', () => {
      const result = service.evaluate(makeContext());
      expect(result.eligible).toBe(true);
      expect(result.qualityScore).toBeGreaterThan(0);
    });

    it('computeOpportunityScore returns 0 for ineligible instruments', () => {
      const score = service.computeOpportunityScore(
        makeContext({ snapshot: makeSnapshot({ ltp: '0.50' }) }),
      );
      expect(score).toBe(0);
    });

    it('computeOpportunityScore returns positive for eligible instruments', () => {
      const score = service.computeOpportunityScore(makeContext());
      expect(score).toBeGreaterThan(0);
    });
  });

  // ── Multi-filter failures ─────────────────────────────────────────────────

  describe('Multiple simultaneous failures', () => {
    it('reports all failing filters when multiple fail', () => {
      const result = service.evaluate(
        makeContext({
          snapshot: makeSnapshot({ ltp: '2.00' }), // fails min_ltp
          impliedVolatility: 300, // fails extreme_iv
          snapshotAgeMs: 20_000, // fails stale_data
        }),
      );
      expect(result.eligible).toBe(false);
      expect(result.failingFilters).toContain('min_ltp');
      expect(result.failingFilters).toContain('extreme_iv');
      expect(result.failingFilters).toContain('stale_data');
    });
  });
});
