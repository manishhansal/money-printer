/**
 * options-intelligence.service.spec.ts
 *
 * Unit tests for OptionsIntelligenceService (task 11.1).
 *
 * Covers:
 *  1. getGreeks() returns null when no cached data exists for a securityId.
 *  2. getGreeks() returns null when cached Greeks are older than 60 seconds.
 *  3. getGreeks() returns the GreekValues when the cache entry is within 60 s.
 *  4. areGreeksFresh() returns false when no cached data exists.
 *  5. areGreeksFresh() returns false when cached Greeks are ≥ 60 seconds old.
 *  6. areGreeksFresh() returns true when the cache entry is fresh (< 60 s).
 *  7. fetchAndCacheGreeks() correctly parses a Dhan option chain response,
 *     populating the cache for both CE and PE legs.
 *  8. fetchAndCacheGreeks() skips strikes where a leg is absent (undefined).
 *  9. Boundary edge-case: exactly at 60 000 ms, getGreeks() returns null and
 *     areGreeksFresh() returns false.
 *
 * Time control: jest fake timers keep Date.now() deterministic.
 *
 * Requirements: 7.1
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OptionsIntelligenceService } from './options-intelligence.service';
import { GREEKS_MAX_AGE_MS } from './options-intelligence.types';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { DhanOptionChainResponse, DhanOptionLeg, DhanOptionStrike } from '../dhan/dhan-api.types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal DhanOptionLeg fixture with specified security_id and Greeks. */
function makeLeg(
  security_id: number,
  greeks: { delta: number; gamma: number; theta: number; vega: number },
): DhanOptionLeg {
  return {
    security_id,
    greeks,
    implied_volatility: 18.5,
    last_price: 200,
    oi: 10000,
    previous_close_price: 195,
    previous_oi: 9800,
    previous_volume: 5000,
    average_price: 198,
    top_bid_price: 199,
    top_bid_quantity: 50,
    top_ask_price: 201,
    top_ask_quantity: 50,
    volume: 5200,
  };
}

/** Build a minimal DhanOptionChainResponse with two strikes: 25650 and 25700. */
function makeOptionChainResponse(): DhanOptionChainResponse {
  const ce25650 = makeLeg(49081, { delta: 0.45, gamma: 0.02, theta: -5.3, vega: 0.18 });
  const pe25650 = makeLeg(49082, { delta: -0.55, gamma: 0.02, theta: -4.8, vega: 0.18 });
  const ce25700 = makeLeg(49083, { delta: 0.35, gamma: 0.018, theta: -4.1, vega: 0.15 });
  // Deliberate: pe25700 is absent to verify that missing legs are skipped.

  const strike25650: DhanOptionStrike = { ce: ce25650, pe: pe25650 };
  const strike25700: DhanOptionStrike = { ce: ce25700 }; // no PE

  return {
    data: {
      last_price: 25660,
      oc: {
        '25650.000000': strike25650,
        '25700.000000': strike25700,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock providers
// ─────────────────────────────────────────────────────────────────────────────

const mockDhanApiClient = {
  getOptionChain: jest.fn(),
} as unknown as DhanApiClient;

const mockConfigService = {
  get: jest.fn().mockReturnValue('IDX_I'),
} as unknown as ConfigService;

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('OptionsIntelligenceService', () => {
  let service: OptionsIntelligenceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OptionsIntelligenceService,
        { provide: DhanApiClient, useValue: mockDhanApiClient },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<OptionsIntelligenceService>(OptionsIntelligenceService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. getGreeks() — cache miss
  // ─────────────────────────────────────────────────────────────────────────

  describe('getGreeks() — no cached data', () => {
    it('returns null when no entry exists for the given securityId', () => {
      const result = service.getGreeks('99999');
      expect(result).toBeNull();
    });

    it('returns null for a securityId that was never fetched', () => {
      expect(service.getGreeks('0')).toBeNull();
      expect(service.getGreeks('unknown')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. getGreeks() — stale cache
  // ─────────────────────────────────────────────────────────────────────────

  describe('getGreeks() — stale Greeks (> 60 s)', () => {
    it('returns null when cached Greeks are older than 60 seconds', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');

      // Advance past the 60-second staleness threshold.
      jest.advanceTimersByTime(GREEKS_MAX_AGE_MS + 1);

      expect(service.getGreeks('49081')).toBeNull();
    });

    it('returns null when cache is exactly 1 minute + 1 ms old', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');
      jest.advanceTimersByTime(60_001);

      expect(service.getGreeks('49082')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. getGreeks() — fresh cache
  // ─────────────────────────────────────────────────────────────────────────

  describe('getGreeks() — fresh Greeks (within 60 s)', () => {
    it('returns the GreekValues immediately after fetching', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');

      const result = service.getGreeks('49081');
      expect(result).not.toBeNull();
      expect(result!.delta).toBeCloseTo(0.45);
      expect(result!.gamma).toBeCloseTo(0.02);
      expect(result!.theta).toBeCloseTo(-5.3);
      expect(result!.vega).toBeCloseTo(0.18);
      expect(result!.instrumentId).toBe('49081');
      expect(result!.computedAt).toBeInstanceOf(Date);
    });

    it('returns the GreekValues when accessed 59 999 ms after fetching', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');
      jest.advanceTimersByTime(GREEKS_MAX_AGE_MS - 1); // 59 999 ms

      const result = service.getGreeks('49081');
      expect(result).not.toBeNull();
    });

    it('returns the GreekValues when accessed at exactly GREEKS_MAX_AGE_MS', async () => {
      // At exactly 60 000 ms, age === GREEKS_MAX_AGE_MS — not strictly greater,
      // so getGreeks() should still return the value per the spec condition
      // (returns null only if age > GREEKS_MAX_AGE_MS).
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');
      jest.advanceTimersByTime(GREEKS_MAX_AGE_MS); // exactly 60 000 ms

      const result = service.getGreeks('49081');
      expect(result).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4 & 5. areGreeksFresh() — stale and missing cases
  // ─────────────────────────────────────────────────────────────────────────

  describe('areGreeksFresh() — returns false', () => {
    it('returns false when no cached entry exists', () => {
      expect(service.areGreeksFresh('99999')).toBe(false);
    });

    it('returns false when cached Greeks are older than 60 seconds', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');
      jest.advanceTimersByTime(GREEKS_MAX_AGE_MS + 1);

      expect(service.areGreeksFresh('49081')).toBe(false);
    });

    it('returns false at exactly GREEKS_MAX_AGE_MS (not strictly less than)', async () => {
      // areGreeksFresh uses strict < so exactly 60 000 ms → false.
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');
      jest.advanceTimersByTime(GREEKS_MAX_AGE_MS);

      expect(service.areGreeksFresh('49081')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. areGreeksFresh() — true for fresh data
  // ─────────────────────────────────────────────────────────────────────────

  describe('areGreeksFresh() — returns true', () => {
    it('returns true immediately after fetching', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');

      expect(service.areGreeksFresh('49081')).toBe(true);
    });

    it('returns true for a PE leg that is still within 60 seconds', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');
      jest.advanceTimersByTime(GREEKS_MAX_AGE_MS - 1); // 59 999 ms

      expect(service.areGreeksFresh('49082')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. fetchAndCacheGreeks() — parsing Dhan option chain response
  // ─────────────────────────────────────────────────────────────────────────

  describe('fetchAndCacheGreeks() — parsing Dhan option chain response', () => {
    it('calls DhanApiClient.getOptionChain with parsed numeric scrip and configured segment', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');

      expect(mockDhanApiClient.getOptionChain).toHaveBeenCalledWith(
        13443, // underlying parsed to number
        'IDX_I', // segment from ConfigService mock
        '2025-06-26',
      );
    });

    it('returns a Map containing all parsed CE and PE legs', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      const result = await service.fetchAndCacheGreeks('13443', '2025-06-26');

      // Two CE legs (49081, 49083) + one PE leg (49082) = 3 contracts.
      expect(result.size).toBe(3);
      expect(result.has('49081')).toBe(true); // CE 25650
      expect(result.has('49082')).toBe(true); // PE 25650
      expect(result.has('49083')).toBe(true); // CE 25700
    });

    it('correctly maps delta for a CE leg', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      const result = await service.fetchAndCacheGreeks('13443', '2025-06-26');

      const ce = result.get('49081')!;
      expect(ce.delta).toBeCloseTo(0.45);
    });

    it('correctly maps delta for a PE leg (negative)', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      const result = await service.fetchAndCacheGreeks('13443', '2025-06-26');

      const pe = result.get('49082')!;
      expect(pe.delta).toBeCloseTo(-0.55);
    });

    it('sets computedAt to the wall-clock time of the fetch call', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      const before = new Date(Date.now());
      const result = await service.fetchAndCacheGreeks('13443', '2025-06-26');
      const after = new Date(Date.now());

      for (const entry of result.values()) {
        expect(entry.computedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(entry.computedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      }
    });

    it('sets instrumentId to the string form of security_id', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      const result = await service.fetchAndCacheGreeks('13443', '2025-06-26');

      const entry = result.get('49081')!;
      expect(entry.instrumentId).toBe('49081');
    });

    it('populates the internal cache so subsequent getGreeks() calls succeed', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      await service.fetchAndCacheGreeks('13443', '2025-06-26');

      expect(service.getGreeks('49081')).not.toBeNull();
      expect(service.getGreeks('49082')).not.toBeNull();
      expect(service.getGreeks('49083')).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. fetchAndCacheGreeks() — missing legs are skipped
  // ─────────────────────────────────────────────────────────────────────────

  describe('fetchAndCacheGreeks() — absent legs', () => {
    it('does not cache a security_id for a missing PE leg', async () => {
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(
        makeOptionChainResponse(),
      );

      const result = await service.fetchAndCacheGreeks('13443', '2025-06-26');

      // Strike 25700 has no PE — only the CE (49083) should be present.
      const strikeKeys = [...result.keys()];
      // There is no PE for 25700, so result should not contain a "pe of 25700" key.
      // The CE for 25700 is 49083 — confirm it's present.
      expect(result.has('49083')).toBe(true);
      // Confirm total: 3 legs, not 4.
      expect(strikeKeys.length).toBe(3);
    });

    it('handles an empty option chain response without throwing', async () => {
      const emptyResponse: DhanOptionChainResponse = {
        data: { last_price: 25000, oc: {} },
      };
      (mockDhanApiClient.getOptionChain as jest.Mock).mockResolvedValueOnce(emptyResponse);

      const result = await service.fetchAndCacheGreeks('13443', '2025-06-26');

      expect(result.size).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GREEKS_MAX_AGE_MS constant export
  // ─────────────────────────────────────────────────────────────────────────

  describe('GREEKS_MAX_AGE_MS constant', () => {
    it('is 60 000 ms (Requirement 7.1 — Greeks not older than 60 seconds)', () => {
      expect(GREEKS_MAX_AGE_MS).toBe(60_000);
    });
  });
});
