/**
 * Unit and property-based tests for MarketDataCacheService.
 *
 * Covers:
 *   - Write path: correct Redis key patterns and TTL values for all four key types
 *   - Read path:  correct key lookup and JSON deserialisation; null on cache miss
 *   - Stale/missing keys: service returns null when Redis returns null
 *
 * Property 24: Redis Cache TTL Compliance
 *   For any write of a market data snapshot to Redis, the TTL shall not exceed
 *   2 seconds. For any write of an option chain snapshot, the TTL shall not
 *   exceed 10 seconds. For any write of market regime state, the TTL shall not
 *   exceed 300 seconds. For any write of a signal score, the TTL shall not
 *   exceed 60 seconds.
 *
 * **Validates: Requirements 18.7**
 */

import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { MarketDataCacheService, CACHE_TTL } from './market-data-cache.service';
import { RedisService } from '../redis/redis.service';
import { MarketSnapshot } from './market-data.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRedisServiceMock() {
  return {
    get: jest.fn<Promise<string | null>, [string]>(),
    set: jest.fn<Promise<void>, [string, string, number?]>().mockResolvedValue(undefined),
  };
}

/** Build a fully specified MarketSnapshot for use in example-based tests. */
function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    ltp: '22500.00',
    bidPrice: '22499.50',
    askPrice: '22500.50',
    volume: '1500000',
    oi: null,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a safe identifier string (letters, digits, underscores, hyphens)
 * that can be embedded as a Redis key segment without special characters.
 */
const safeIdArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/).filter((s) => s.length > 0);

/** Generates a MarketSnapshot with arbitrary (but structurally valid) values. */
const snapshotArb: fc.Arbitrary<MarketSnapshot> = fc.record({
  ltp: fc.float({ min: 1, max: 100_000, noNaN: true }).map((v) => v.toFixed(2)),
  bidPrice: fc.option(
    fc.float({ min: 1, max: 100_000, noNaN: true }).map((v) => v.toFixed(2)),
    { nil: null },
  ),
  askPrice: fc.option(
    fc.float({ min: 1, max: 100_000, noNaN: true }).map((v) => v.toFixed(2)),
    { nil: null },
  ),
  volume: fc.integer({ min: 0, max: 1_000_000_000 }).map((v) => String(v)),
  oi: fc.option(
    fc.integer({ min: 0, max: 100_000_000 }).map((v) => String(v)),
    { nil: null },
  ),
  timestamp: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MarketDataCacheService', () => {
  let service: MarketDataCacheService;
  let redisMock: ReturnType<typeof createRedisServiceMock>;

  beforeEach(async () => {
    redisMock = createRedisServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [MarketDataCacheService, { provide: RedisService, useValue: redisMock }],
    }).compile();

    service = module.get<MarketDataCacheService>(MarketDataCacheService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Unit tests — write path
  // --------------------------------------------------------------------------

  describe('cacheMarketSnapshot()', () => {
    it('writes to mkt:snapshot:{instrumentId} with TTL=2', async () => {
      const snapshot = makeSnapshot();
      await service.cacheMarketSnapshot('NIFTY', snapshot);
      expect(redisMock.set).toHaveBeenCalledTimes(1);
      expect(redisMock.set).toHaveBeenCalledWith(
        'mkt:snapshot:NIFTY',
        JSON.stringify(snapshot),
        CACHE_TTL.MARKET_SNAPSHOT,
      );
    });

    it('correctly embeds instrumentId in the key', async () => {
      await service.cacheMarketSnapshot('BANKNIFTY', makeSnapshot());
      const [key] = redisMock.set.mock.calls[0];
      expect(key).toBe('mkt:snapshot:BANKNIFTY');
    });
  });

  describe('cacheOptionChain()', () => {
    it('writes to mkt:optchain:{underlying}:{expiry} with TTL=10', async () => {
      const chain = { strikes: [22500, 23000] };
      await service.cacheOptionChain('NIFTY', '2024-12-26', chain);
      expect(redisMock.set).toHaveBeenCalledWith(
        'mkt:optchain:NIFTY:2024-12-26',
        JSON.stringify(chain),
        CACHE_TTL.OPTION_CHAIN,
      );
    });
  });

  describe('cacheRegimeState()', () => {
    it('writes to regime:current with TTL=300', async () => {
      await service.cacheRegimeState('STRONG_BULL');
      expect(redisMock.set).toHaveBeenCalledWith(
        'regime:current',
        JSON.stringify('STRONG_BULL'),
        CACHE_TTL.REGIME_STATE,
      );
    });
  });

  describe('cacheSignalScore()', () => {
    it('writes to signal:score:{signalId} with TTL=60', async () => {
      const score = { value: 82, confidence: 0.9 };
      await service.cacheSignalScore('sig-001', score);
      expect(redisMock.set).toHaveBeenCalledWith(
        'signal:score:sig-001',
        JSON.stringify(score),
        CACHE_TTL.SIGNAL_SCORE,
      );
    });
  });

  // --------------------------------------------------------------------------
  // Unit tests — read path
  // --------------------------------------------------------------------------

  describe('getMarketSnapshot()', () => {
    it('returns parsed snapshot when key exists', async () => {
      const snapshot = makeSnapshot();
      redisMock.get.mockResolvedValue(JSON.stringify(snapshot));
      const result = await service.getMarketSnapshot('NIFTY');
      expect(result).toEqual(snapshot);
      expect(redisMock.get).toHaveBeenCalledWith('mkt:snapshot:NIFTY');
    });

    it('returns null when key is absent (cache miss / stale)', async () => {
      redisMock.get.mockResolvedValue(null);
      const result = await service.getMarketSnapshot('NIFTY');
      expect(result).toBeNull();
    });
  });

  describe('getOptionChain()', () => {
    it('returns parsed chain when key exists', async () => {
      const chain = { strikes: [22500] };
      redisMock.get.mockResolvedValue(JSON.stringify(chain));
      const result = await service.getOptionChain('NIFTY', '2024-12-26');
      expect(result).toEqual(chain);
      expect(redisMock.get).toHaveBeenCalledWith('mkt:optchain:NIFTY:2024-12-26');
    });

    it('returns null on cache miss', async () => {
      redisMock.get.mockResolvedValue(null);
      expect(await service.getOptionChain('NIFTY', '2024-12-26')).toBeNull();
    });
  });

  describe('getCurrentRegime()', () => {
    it('returns regime string when key exists', async () => {
      redisMock.get.mockResolvedValue(JSON.stringify('HIGH_VOL'));
      const result = await service.getCurrentRegime();
      expect(result).toBe('HIGH_VOL');
      expect(redisMock.get).toHaveBeenCalledWith('regime:current');
    });

    it('returns null on cache miss', async () => {
      redisMock.get.mockResolvedValue(null);
      expect(await service.getCurrentRegime()).toBeNull();
    });
  });

  describe('getSignalScore()', () => {
    it('returns parsed score data when key exists', async () => {
      const score = { value: 75, confidence: 0.85 };
      redisMock.get.mockResolvedValue(JSON.stringify(score));
      const result = await service.getSignalScore('sig-42');
      expect(result).toEqual(score);
      expect(redisMock.get).toHaveBeenCalledWith('signal:score:sig-42');
    });

    it('returns null on cache miss', async () => {
      redisMock.get.mockResolvedValue(null);
      expect(await service.getSignalScore('sig-42')).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Stale snapshot returns null
  // --------------------------------------------------------------------------

  describe('stale / expired key behaviour', () => {
    it('getMarketSnapshot returns null after TTL expiry (Redis returns null)', async () => {
      // Simulate that the key has already expired: Redis.get returns null
      redisMock.get.mockResolvedValue(null);
      expect(await service.getMarketSnapshot('EXPIRED_INSTRUMENT')).toBeNull();
    });

    it('getOptionChain returns null after TTL expiry', async () => {
      redisMock.get.mockResolvedValue(null);
      expect(await service.getOptionChain('NIFTY', '2020-01-01')).toBeNull();
    });

    it('getCurrentRegime returns null after TTL expiry', async () => {
      redisMock.get.mockResolvedValue(null);
      expect(await service.getCurrentRegime()).toBeNull();
    });

    it('getSignalScore returns null after TTL expiry', async () => {
      redisMock.get.mockResolvedValue(null);
      expect(await service.getSignalScore('old-signal')).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Property 24: Redis Cache TTL Compliance
  // **Validates: Requirements 18.7**
  //
  // For any inputs, the TTL passed to Redis must not exceed the spec limit:
  //   market snapshot ≤ 2 s, option chain ≤ 10 s, regime ≤ 300 s, signal ≤ 60 s
  // --------------------------------------------------------------------------

  describe('Property 24: Redis Cache TTL Compliance', () => {
    it('market snapshot write TTL never exceeds 2 seconds for any instrumentId / snapshot', async () => {
      await fc.assert(
        fc.asyncProperty(safeIdArb, snapshotArb, async (instrumentId, snapshot) => {
          redisMock.set.mockClear();
          await service.cacheMarketSnapshot(instrumentId, snapshot);
          const [_key, _value, ttl] = redisMock.set.mock.calls[0];
          // TTL must be present and within spec
          expect(ttl).toBeDefined();
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(2);
        }),
        { numRuns: 100 },
      );
    });

    it('option chain write TTL never exceeds 10 seconds for any underlying / expiry / data', async () => {
      await fc.assert(
        fc.asyncProperty(
          safeIdArb,
          safeIdArb,
          fc.anything(),
          async (underlying, expiry, chainData) => {
            redisMock.set.mockClear();
            await service.cacheOptionChain(underlying, expiry, chainData);
            const [_key, _value, ttl] = redisMock.set.mock.calls[0];
            expect(ttl).toBeDefined();
            expect(ttl).toBeGreaterThan(0);
            expect(ttl).toBeLessThanOrEqual(10);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('regime state write TTL never exceeds 300 seconds for any regime string', async () => {
      const regimeArb = fc.constantFrom(
        'STRONG_BULL',
        'WEAK_BULL',
        'STRONG_BEAR',
        'WEAK_BEAR',
        'SIDEWAYS',
        'HIGH_VOL',
        'LOW_VOL',
        'BREAKOUT',
        'REVERSAL',
        'UNSTABLE',
      );
      await fc.assert(
        fc.asyncProperty(regimeArb, async (regime) => {
          redisMock.set.mockClear();
          await service.cacheRegimeState(regime);
          const [_key, _value, ttl] = redisMock.set.mock.calls[0];
          expect(ttl).toBeDefined();
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(300);
        }),
        { numRuns: 50 },
      );
    });

    it('signal score write TTL never exceeds 60 seconds for any signalId / score data', async () => {
      await fc.assert(
        fc.asyncProperty(safeIdArb, fc.anything(), async (signalId, scoreData) => {
          redisMock.set.mockClear();
          await service.cacheSignalScore(signalId, scoreData);
          const [_key, _value, ttl] = redisMock.set.mock.calls[0];
          expect(ttl).toBeDefined();
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(60);
        }),
        { numRuns: 100 },
      );
    });

    it('key pattern for market snapshot always starts with mkt:snapshot: for any instrumentId', async () => {
      await fc.assert(
        fc.asyncProperty(safeIdArb, snapshotArb, async (instrumentId, snapshot) => {
          redisMock.set.mockClear();
          await service.cacheMarketSnapshot(instrumentId, snapshot);
          const [key] = redisMock.set.mock.calls[0];
          expect(key).toBe(`mkt:snapshot:${instrumentId}`);
        }),
        { numRuns: 100 },
      );
    });

    it('key pattern for option chain always starts with mkt:optchain: for any underlying and expiry', async () => {
      await fc.assert(
        fc.asyncProperty(safeIdArb, safeIdArb, fc.anything(), async (underlying, expiry, data) => {
          redisMock.set.mockClear();
          await service.cacheOptionChain(underlying, expiry, data);
          const [key] = redisMock.set.mock.calls[0];
          expect(key).toBe(`mkt:optchain:${underlying}:${expiry}`);
        }),
        { numRuns: 100 },
      );
    });

    it('regime state key is always exactly regime:current for any regime value', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1 }), async (regime) => {
          redisMock.set.mockClear();
          await service.cacheRegimeState(regime);
          const [key] = redisMock.set.mock.calls[0];
          expect(key).toBe('regime:current');
        }),
        { numRuns: 100 },
      );
    });

    it('signal score key always starts with signal:score: for any signalId', async () => {
      await fc.assert(
        fc.asyncProperty(safeIdArb, fc.anything(), async (signalId, data) => {
          redisMock.set.mockClear();
          await service.cacheSignalScore(signalId, data);
          const [key] = redisMock.set.mock.calls[0];
          expect(key).toBe(`signal:score:${signalId}`);
        }),
        { numRuns: 100 },
      );
    });
  });
});
