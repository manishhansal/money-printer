/**
 * options-flow.service.ts
 *
 * OptionsFlowService — periodic aggregator for NSE options-flow metrics.
 *
 * Responsibilities (task 31.2):
 *  - Maintain an internal subscription list of monitored instruments.
 *  - Every ≤60 seconds (via @Cron), read `mkt:optchain:{underlying}:{expiry}`
 *    from Redis and compute: netOiChange, putCallRatio, ivSkew, and
 *    largeBlockDetected for each subscribed instrument.
 *  - Expose getDashboard() that marks snapshots as stale when their
 *    snapshotTime is more than 60 seconds old.
 *  - Set suppressOptionsFuturesScore = true whenever any snapshot is stale
 *    so the SignalScoring module can suppress the Options/Futures Confirmation
 *    score contribution (Requirement 20.7).
 *
 * Redis key read:  `mkt:optchain:{underlying}:{expiry}`
 * Data written by: MarketDataCacheService.cacheOptionChain()
 *
 * Requirements: 20.6, 20.7
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../redis/redis.service';
import {
  InstrumentSubscription,
  OptionsFlowDashboard,
  OptionsFlowSnapshot,
} from './options-flow.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum age in milliseconds before a snapshot is considered stale.
 * Requirement 20.7: "data is older than 60 seconds".
 */
export const SNAPSHOT_MAX_AGE_MS = 60_000;

/**
 * Default large-block volume threshold (contracts).
 * Overridden by LARGE_BLOCK_VOLUME_THRESHOLD env var.
 */
const DEFAULT_LARGE_BLOCK_THRESHOLD = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Internal option-chain shape (matches Dhan option-chain response stored by
// MarketDataCacheService — `mkt:optchain:{underlying}:{expiry}`)
// ─────────────────────────────────────────────────────────────────────────────

interface OptionLeg {
  oi: number;
  previous_oi: number;
  implied_volatility: number;
  volume: number;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
}

interface OptionStrike {
  ce?: OptionLeg;
  pe?: OptionLeg;
}

interface OptionChainData {
  data: {
    last_price: number;
    oc: Record<string, OptionStrike>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class OptionsFlowService {
  private readonly logger = new Logger(OptionsFlowService.name);

  /** Registered instruments to monitor. Keyed by instrumentId. */
  private readonly subscriptions = new Map<string, InstrumentSubscription>();

  /** Computed snapshots from the most recent refresh cycle. Keyed by instrumentId. */
  private readonly snapshotCache = new Map<string, OptionsFlowSnapshot>();

  /** Configured large-block volume threshold (read once at construction). */
  private readonly largeBlockThreshold: number;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.largeBlockThreshold = this.configService.get<number>(
      'LARGE_BLOCK_VOLUME_THRESHOLD',
      DEFAULT_LARGE_BLOCK_THRESHOLD,
    );
    this.logger.log(
      `OptionsFlowService initialised — large-block threshold: ${this.largeBlockThreshold} contracts`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Subscription management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register an instrument for options-flow monitoring.
   *
   * @param instrumentId   Internal UUID (instruments table primary key).
   * @param tradingSymbol  Exchange trading symbol, e.g. "NIFTY24JAN21000CE".
   * @param underlying     NSE underlying name, e.g. "NIFTY", "BANKNIFTY".
   * @param expiry         Expiry date string used in the Redis key, e.g. "2024-12-26".
   *
   * Requirements: 20.6
   */
  subscribeInstrument(
    instrumentId: string,
    tradingSymbol: string,
    underlying: string,
    expiry: string,
  ): void {
    this.subscriptions.set(instrumentId, {
      instrumentId,
      tradingSymbol,
      underlying,
      expiry,
    });
    this.logger.log(
      `Subscribed instrument ${instrumentId} (${tradingSymbol}) — ` +
        `Redis key: mkt:optchain:${underlying}:${expiry}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scheduled refresh
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Refresh options-flow snapshots for all subscribed instruments.
   *
   * Fires every ≤60 seconds via cron.  For each instrument, reads
   * `mkt:optchain:{underlying}:{expiry}` from Redis, computes the four metrics,
   * and updates the in-process snapshot cache.
   *
   * Requirements: 20.6, 20.7
   */
  @Cron('*/60 * * * * *')
  async refreshFlow(): Promise<void> {
    if (this.subscriptions.size === 0) {
      return;
    }

    const refreshedAt = new Date();

    for (const sub of this.subscriptions.values()) {
      try {
        const chain = await this.fetchOptionChain(sub.underlying, sub.expiry);
        if (!chain) {
          this.logger.warn(
            `No option-chain data in Redis for ${sub.underlying}:${sub.expiry} — skipping`,
          );
          continue;
        }

        const snapshot = this.computeSnapshot(sub, chain, refreshedAt);
        this.snapshotCache.set(sub.instrumentId, snapshot);

        this.logger.debug(
          `Refreshed options flow for ${sub.tradingSymbol}: ` +
            `PCR=${snapshot.putCallRatio.toFixed(3)}, ` +
            `skew=${snapshot.ivSkew.toFixed(2)}, ` +
            `largeBlock=${snapshot.largeBlockDetected}`,
        );
      } catch (err) {
        this.logger.error(`refreshFlow: failed for ${sub.instrumentId}: ${(err as Error).message}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dashboard read
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the current dashboard, with staleness flags applied at read time.
   *
   * - isStale is set to true for any snapshot whose snapshotTime is more than
   *   60 seconds in the past.
   * - suppressOptionsFuturesScore is true when at least one snapshot is stale.
   *
   * Requirements: 20.6, 20.7
   */
  getDashboard(): OptionsFlowDashboard {
    const now = new Date();
    const snapshots: OptionsFlowSnapshot[] = [];

    for (const cached of this.snapshotCache.values()) {
      const ageMs = now.getTime() - cached.snapshotTime.getTime();
      const isStale = ageMs > SNAPSHOT_MAX_AGE_MS;
      snapshots.push({ ...cached, isStale });
    }

    const suppressOptionsFuturesScore = snapshots.some((s) => s.isStale);

    return {
      snapshots,
      generatedAt: now,
      suppressOptionsFuturesScore,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Read option-chain data from Redis for the given underlying + expiry.
   * Returns null when the key is absent or cannot be parsed.
   */
  private async fetchOptionChain(
    underlying: string,
    expiry: string,
  ): Promise<OptionChainData | null> {
    const key = `mkt:optchain:${underlying}:${expiry}`;
    const raw = await this.redisService.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as OptionChainData;
    } catch {
      this.logger.error(`Failed to parse option chain JSON for key ${key}`);
      return null;
    }
  }

  /**
   * Compute an OptionsFlowSnapshot from the given option-chain data.
   */
  private computeSnapshot(
    sub: InstrumentSubscription,
    chain: OptionChainData,
    snapshotTime: Date,
  ): OptionsFlowSnapshot {
    const strikes = Object.values(chain.data.oc);

    let totalCallOI = 0;
    let totalPutOI = 0;
    let netOiChange = 0;
    let maxVolume = 0;

    for (const strike of strikes) {
      if (strike.ce) {
        totalCallOI += strike.ce.oi;
        netOiChange += strike.ce.oi - strike.ce.previous_oi;
        if (strike.ce.volume > maxVolume) maxVolume = strike.ce.volume;
      }
      if (strike.pe) {
        totalPutOI += strike.pe.oi;
        netOiChange += strike.pe.oi - strike.pe.previous_oi;
        if (strike.pe.volume > maxVolume) maxVolume = strike.pe.volume;
      }
    }

    const putCallRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    const ivSkew = this.computeIvSkew(strikes);

    const largeBlockDetected = maxVolume > this.largeBlockThreshold;

    return {
      instrumentId: sub.instrumentId,
      tradingSymbol: sub.tradingSymbol,
      netOiChange,
      putCallRatio,
      ivSkew,
      largeBlockDetected,
      largeBlockVolume: largeBlockDetected ? maxVolume : undefined,
      snapshotTime,
      isStale: false, // freshly computed; getDashboard() re-evaluates at read time
    };
  }

  /**
   * Compute IV skew: 25-delta put IV minus 25-delta call IV.
   *
   * The 25-delta call is the CE leg whose delta is closest to 0.25.
   * The 25-delta put  is the PE leg whose |delta| is closest to 0.25.
   *
   * Returns 0 when a suitable leg cannot be found.
   */
  private computeIvSkew(strikes: OptionStrike[]): number {
    let best25dCe: OptionLeg | null = null;
    let best25dCeDiff = Infinity;

    let best25dPe: OptionLeg | null = null;
    let best25dPeDiff = Infinity;

    for (const strike of strikes) {
      if (strike.ce) {
        const diff = Math.abs(strike.ce.greeks.delta - 0.25);
        if (diff < best25dCeDiff) {
          best25dCeDiff = diff;
          best25dCe = strike.ce;
        }
      }
      if (strike.pe) {
        const diff = Math.abs(Math.abs(strike.pe.greeks.delta) - 0.25);
        if (diff < best25dPeDiff) {
          best25dPeDiff = diff;
          best25dPe = strike.pe;
        }
      }
    }

    if (!best25dCe || !best25dPe) return 0;

    return best25dPe.implied_volatility - best25dCe.implied_volatility;
  }
}
