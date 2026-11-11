import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RedisService } from '../redis/redis.service';
import { MarketSnapshot, MARKET_TICK_RECEIVED_EVENT } from './market-data.types';
import { DhanTickData } from '../dhan/dhan-websocket.client';

/**
 * TTL constants (seconds) for every Redis key written by MarketDataCacheService.
 *
 * These values are requirements — not tuneable at runtime. They are exported
 * so that unit tests can assert against the exact constant rather than a magic
 * number.
 *
 * Requirements: 18.7
 */
export const CACHE_TTL = {
  /** `mkt:snapshot:{instrument_id}` — 2 seconds */
  MARKET_SNAPSHOT: 2,
  /** `mkt:optchain:{underlying}:{expiry}` — 10 seconds */
  OPTION_CHAIN: 10,
  /** `regime:current` — 300 seconds */
  REGIME_STATE: 300,
  /** `signal:score:{signal_id}` — 60 seconds */
  SIGNAL_SCORE: 60,
} as const;

/**
 * MarketDataCacheService
 *
 * Manages the Redis cache write/read path for all market data keys defined in
 * the system's Redis key-space design.
 *
 * Write methods serialise values to JSON and store them with the required TTL.
 * Read methods return `null` when the key is absent or has expired (Redis
 * handles expiry automatically via the EX option set at write time).
 *
 * Requirements: 18.7
 */
@Injectable()
export class MarketDataCacheService {
  private readonly logger = new Logger(MarketDataCacheService.name);

  constructor(private readonly redisService: RedisService) {}

  // --------------------------------------------------------------------------
  // Tick ingestion — market.tick.received → Redis
  // --------------------------------------------------------------------------

  /**
   * Bridge between the Dhan WebSocket feed and the Redis market-data cache.
   *
   * Listens to every `market.tick.received` event emitted by
   * DhanWebSocketClient and writes a {@link MarketSnapshot} to Redis for
   * downstream consumers (PaperEngine, PositionMonitor, SignalScoring…).
   *
   * Only ticks that carry a Last Traded Price are cached — standalone OI
   * packets (response code 5) and Prev-Close packets (code 6) have no LTP
   * and are skipped to avoid overwriting a valid snapshot with partial data.
   *
   * Key:  `mkt:snapshot:{securityId}`
   * TTL:  2 s (CACHE_TTL.MARKET_SNAPSHOT) — matches the tick rate.
   *
   * Requirements: 18.7
   */
  @OnEvent(MARKET_TICK_RECEIVED_EVENT)
  onTickReceived(tick: DhanTickData): void {
    // Skip packets without LTP (OI-only, PrevClose, etc.)
    if (tick.lastTradedPrice == null) return;

    const instrumentId = String(tick.securityId);

    // Extract best bid/ask from depth level 0 if present (Full packet)
    const depth = tick.depth as Array<{ bidPrice: number; askPrice: number }> | undefined;
    const bidPrice = depth?.[0]?.bidPrice != null ? String(depth[0].bidPrice) : null;
    const askPrice = depth?.[0]?.askPrice != null ? String(depth[0].askPrice) : null;

    const snapshot: MarketSnapshot = {
      ltp: String(tick.lastTradedPrice),
      bidPrice,
      askPrice,
      volume: String((tick.volume as number | undefined) ?? 0),
      oi:
        (tick.openInterest as number | undefined) != null
          ? String(tick.openInterest as number)
          : null,
      // Dhan LTT is epoch seconds; MarketSnapshot uses epoch milliseconds
      timestamp: tick.timestamp ? (tick.timestamp as number) * 1_000 : Date.now(),
    };

    // Fire-and-forget — errors are caught and logged; never rethrow on a
    // hot event path that fires hundreds of times per second.
    this.cacheMarketSnapshot(instrumentId, snapshot).catch((err: Error) => {
      this.logger.error(`Failed to cache snapshot for ${instrumentId}: ${err.message}`);
    });
  }

  // --------------------------------------------------------------------------
  // Write methods
  // --------------------------------------------------------------------------

  /**
   * Cache a live market data snapshot for an instrument.
   *
   * Key:   `mkt:snapshot:{instrumentId}`
   * TTL:   2 seconds (CACHE_TTL.MARKET_SNAPSHOT)
   * Value: JSON-serialised {@link MarketSnapshot}
   */
  async cacheMarketSnapshot(instrumentId: string, snapshot: MarketSnapshot): Promise<void> {
    const key = `mkt:snapshot:${instrumentId}`;
    await this.redisService.set(key, JSON.stringify(snapshot), CACHE_TTL.MARKET_SNAPSHOT);
    this.logger.debug(
      `Cached market snapshot for ${instrumentId} (TTL ${CACHE_TTL.MARKET_SNAPSHOT}s)`,
    );
  }

  /**
   * Cache a full option chain snapshot.
   *
   * Key:   `mkt:optchain:{underlying}:{expiry}`
   * TTL:   10 seconds (CACHE_TTL.OPTION_CHAIN)
   * Value: JSON-serialised chain data (opaque shape from Dhan feed)
   */
  async cacheOptionChain(underlying: string, expiry: string, chainData: unknown): Promise<void> {
    const key = `mkt:optchain:${underlying}:${expiry}`;
    await this.redisService.set(key, JSON.stringify(chainData), CACHE_TTL.OPTION_CHAIN);
    this.logger.debug(
      `Cached option chain for ${underlying}:${expiry} (TTL ${CACHE_TTL.OPTION_CHAIN}s)`,
    );
  }

  /**
   * Cache the current market regime state.
   *
   * Key:   `regime:current`
   * TTL:   300 seconds (CACHE_TTL.REGIME_STATE)
   * Value: JSON-serialised regime string (e.g. `"STRONG_BULL"`)
   */
  async cacheRegimeState(regime: string): Promise<void> {
    await this.redisService.set('regime:current', JSON.stringify(regime), CACHE_TTL.REGIME_STATE);
    this.logger.debug(`Cached regime state: ${regime} (TTL ${CACHE_TTL.REGIME_STATE}s)`);
  }

  /**
   * Cache a signal score result.
   *
   * Key:   `signal:score:{signalId}`
   * TTL:   60 seconds (CACHE_TTL.SIGNAL_SCORE)
   * Value: JSON-serialised score data (opaque shape from SignalScoring module)
   */
  async cacheSignalScore(signalId: string, scoreData: unknown): Promise<void> {
    const key = `signal:score:${signalId}`;
    await this.redisService.set(key, JSON.stringify(scoreData), CACHE_TTL.SIGNAL_SCORE);
    this.logger.debug(`Cached signal score for ${signalId} (TTL ${CACHE_TTL.SIGNAL_SCORE}s)`);
  }

  // --------------------------------------------------------------------------
  // Read methods
  // --------------------------------------------------------------------------

  /**
   * Read a cached market snapshot.
   * Returns `null` if the key is missing or has expired.
   */
  async getMarketSnapshot(instrumentId: string): Promise<MarketSnapshot | null> {
    const key = `mkt:snapshot:${instrumentId}`;
    const raw = await this.redisService.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as MarketSnapshot;
  }

  /**
   * Read a cached option chain snapshot.
   * Returns `null` if the key is missing or has expired.
   */
  async getOptionChain(underlying: string, expiry: string): Promise<unknown | null> {
    const key = `mkt:optchain:${underlying}:${expiry}`;
    const raw = await this.redisService.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  }

  /**
   * Read the current cached regime state.
   * Returns `null` if the key is missing or has expired.
   */
  async getCurrentRegime(): Promise<string | null> {
    const raw = await this.redisService.get('regime:current');
    if (raw === null) return null;
    return JSON.parse(raw) as string;
  }

  /**
   * Read a cached signal score.
   * Returns `null` if the key is missing or has expired.
   */
  async getSignalScore(signalId: string): Promise<unknown | null> {
    const key = `signal:score:${signalId}`;
    const raw = await this.redisService.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  }
}
