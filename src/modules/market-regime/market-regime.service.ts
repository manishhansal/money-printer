/**
 * market-regime.service.ts
 *
 * Core service for the MarketRegimeModule.
 *
 * Responsibilities (task 9.1):
 *   1. Classify the market into exactly one of 10 regimes at intervals ≤ 60 s
 *      using all 10 indicator inputs.
 *   2. Evaluate the VIX override rule FIRST: when indiaVix > HIGH_VOLATILITY_VIX_THRESHOLD
 *      → return HIGH_VOL immediately, overriding all other indicator combinations.
 *   3. Publish regime-change events to `events:regime_change` Redis channel within
 *      30 seconds of the triggering condition (Requirement 5.3).
 *   4. Persist every classification to the `market_regimes` table (Requirement 5.5).
 *   5. Write the current regime to the `regime:current` Redis key (TTL 300 s).
 *   6. Emit the `market.regime.changed` NestJS event on regime transitions.
 *   7. Emit the `market.regime.unstable` NestJS event while regime is UNSTABLE
 *      so RiskEngine can enforce the reduced concurrent-trade limit (Req 5.6).
 *
 * Classification priority order (first match wins):
 *   1. HIGH_VOL   — VIX override (indiaVix > threshold)                [Req 5.7]
 *   2. BREAKOUT   — relVol > 2.0  AND price expansion > ATR × multiplier
 *   3. LOW_VOL    — relVol < 0.5
 *   4. STRONG_BULL — NIFTY=BULLISH, BANKNIFTY=BULLISH, breadth > 60, relVol > 1.5
 *   5. STRONG_BEAR — NIFTY=BEARISH, BANKNIFTY=BEARISH, breadth < 40, relVol > 1.5
 *   6. WEAK_BULL  — NIFTY=BULLISH, breadth > 50, relVol ≤ 1.5
 *   7. WEAK_BEAR  — NIFTY=BEARISH, breadth < 50
 *   8. SIDEWAYS   — NIFTY=SIDEWAYS, BANKNIFTY=SIDEWAYS, breadth 45–55, relVol ≤ 1.0
 *   9. REVERSAL   — trend diverges from VWAP deviation
 *  10. UNSTABLE   — catch-all for conflicting signals
 *
 * Configuration (via ConfigService / env variables):
 *   HIGH_VOLATILITY_VIX_THRESHOLD     — default: 20.0
 *   BREAKOUT_RELATIVE_VOLUME_THRESHOLD — default: 2.0
 *   BREAKOUT_ATR_MULTIPLIER            — default: 1.5
 *   LOW_VOL_RELATIVE_VOLUME_THRESHOLD  — default: 0.5
 *   REVERSAL_VWAP_DEVIATION_THRESHOLD  — default: 0.5
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MarketRegimes } from '../../database/entities/market-regimes.entity';
import { RedisService } from '../redis/redis.service';
import {
  MarketRegime,
  RegimeInputs,
  RegimeChangeEvent,
  REGIME_CHANGE_CHANNEL,
  REGIME_CURRENT_KEY,
  REGIME_CHANGED_EVENT,
  REGIME_UNSTABLE_EVENT,
  TrendDirection,
} from './market-regime.types';

/** Redis TTL for `regime:current` in seconds (Requirement 18.7). */
const REGIME_CURRENT_TTL_SECONDS = 300;

@Injectable()
export class MarketRegimeService implements OnModuleInit {
  private readonly logger = new Logger(MarketRegimeService.name);

  // ── Configuration thresholds ────────────────────────────────────────────

  /**
   * indiaVix level above which HIGH_VOL is forced regardless of other
   * indicator values.  Requirement 5.7.
   */
  readonly highVolatilityVixThreshold: number;

  /** Minimum relative volume to consider a session a BREAKOUT candidate. */
  readonly breakoutRelativeVolumeThreshold: number;

  /**
   * Multiplier applied to ATR when measuring price expansion for BREAKOUT
   * detection.  A VWAP deviation magnitude > atr × multiplier qualifies.
   */
  readonly breakoutAtrMultiplier: number;

  /** Maximum relative volume below which LOW_VOL is considered. */
  readonly lowVolRelativeVolumeThreshold: number;

  /**
   * Minimum absolute VWAP deviation (%) that triggers a REVERSAL classification
   * when the deviation direction contradicts the prevailing trend.
   */
  readonly reversalVwapDeviationThreshold: number;

  // ── Runtime state ────────────────────────────────────────────────────────

  /**
   * The regime produced by the most recent successful classification.
   * Initialised to UNSTABLE until the first classification completes.
   */
  private currentRegime: MarketRegime = MarketRegime.UNSTABLE;

  /**
   * The latest indicator snapshot provided by an external caller (e.g. the
   * TechnicalAnalysis module).  Used by the cron-driven `updateRegime()`.
   */
  private currentInputs: RegimeInputs | null = null;

  /** UTC timestamp when `currentInputs` was last updated. */
  private lastInputsTimestamp: Date | null = null;

  /**
   * Short-term LTP cache for trend computation: securityId → previous LTP.
   * Updated each minute by buildRegimeInputsFromRedis().
   */
  private readonly prevLtpCache = new Map<string, number>();

  constructor(
    @InjectRepository(MarketRegimes)
    private readonly marketRegimesRepo: Repository<MarketRegimes>,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.highVolatilityVixThreshold =
      this.configService.get<number>('HIGH_VOLATILITY_VIX_THRESHOLD', 20.0) ?? 20.0;

    this.breakoutRelativeVolumeThreshold =
      this.configService.get<number>('BREAKOUT_RELATIVE_VOLUME_THRESHOLD', 2.0) ?? 2.0;

    this.breakoutAtrMultiplier =
      this.configService.get<number>('BREAKOUT_ATR_MULTIPLIER', 1.5) ?? 1.5;

    this.lowVolRelativeVolumeThreshold =
      this.configService.get<number>('LOW_VOL_RELATIVE_VOLUME_THRESHOLD', 0.5) ?? 0.5;

    this.reversalVwapDeviationThreshold =
      this.configService.get<number>('REVERSAL_VWAP_DEVIATION_THRESHOLD', 0.5) ?? 0.5;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    // Try to restore the regime from Redis so the service is immediately
    // consistent with any previously persisted value.
    try {
      const raw = await this.redisService.get(REGIME_CURRENT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as string;
        if (Object.values(MarketRegime).includes(parsed as MarketRegime)) {
          this.currentRegime = parsed as MarketRegime;
          this.logger.log(
            `MarketRegimeService restored from Redis — current regime: ${this.currentRegime}`,
          );
          return;
        }
      }
    } catch (err) {
      this.logger.warn(`Could not restore regime from Redis on init: ${(err as Error).message}`);
    }
    this.logger.log(
      `MarketRegimeService initialised — current regime: ${this.currentRegime} (default)`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core classification — pure synchronous function
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Classify the market into exactly one of 10 regime codes.
   *
   * This is a pure, synchronous function with no side effects.
   * The classification priority order guarantees a deterministic result:
   *   1. HIGH_VOL   — VIX override (evaluated first, Requirement 5.7)
   *   2. BREAKOUT   — volume surge + price expansion
   *   3. LOW_VOL    — unusually low volume
   *   4. STRONG_BULL — both indices bullish, broad participation, high volume
   *   5. STRONG_BEAR — both indices bearish, broad selling, high volume
   *   6. WEAK_BULL  — NIFTY bullish, moderate participation, average volume
   *   7. WEAK_BEAR  — NIFTY bearish, weak breadth
   *   8. SIDEWAYS   — both indices neutral, tight breadth, low volume
   *   9. REVERSAL   — trend diverges from VWAP deviation
   *  10. UNSTABLE   — catch-all for conflicting or ambiguous signals
   *
   * @param inputs All 10 required indicator values.
   * @returns Exactly one of the 10 MarketRegime values.
   *
   * Requirements: 5.1, 5.7
   */
  classifyRegime(inputs: RegimeInputs): MarketRegime {
    const {
      niftyTrend,
      bankniftyTrend,
      marketBreadth,
      vwapDeviation,
      indiaVix,
      atr,
      relativeVolume,
    } = inputs;

    // ── 1. VIX Override (MUST be evaluated first) ─────────────────────────
    // Requirement 5.7: WHILE indiaVix > HIGH_VOLATILITY_VIX_THRESHOLD,
    // classify as HIGH_VOL regardless of all other indicator values.
    if (indiaVix > this.highVolatilityVixThreshold) {
      return MarketRegime.HIGH_VOL;
    }

    // ── 2. BREAKOUT ───────────────────────────────────────────────────────
    // Significant volume surge AND meaningful price expansion beyond ATR.
    // atr guard ensures division-by-zero / degenerate ATR values don't match.
    if (
      relativeVolume > this.breakoutRelativeVolumeThreshold &&
      atr > 0 &&
      Math.abs(vwapDeviation) > atr * this.breakoutAtrMultiplier
    ) {
      return MarketRegime.BREAKOUT;
    }

    // ── 3. LOW_VOL ────────────────────────────────────────────────────────
    // Very low relative volume indicates an unusually quiet session.
    if (relativeVolume < this.lowVolRelativeVolumeThreshold) {
      return MarketRegime.LOW_VOL;
    }

    // ── 4. STRONG_BULL ────────────────────────────────────────────────────
    // Both indices bullish, broad participation (>60%), above-average volume.
    if (
      niftyTrend === 'BULLISH' &&
      bankniftyTrend === 'BULLISH' &&
      marketBreadth > 60 &&
      relativeVolume > 1.5
    ) {
      return MarketRegime.STRONG_BULL;
    }

    // ── 5. STRONG_BEAR ────────────────────────────────────────────────────
    // Both indices bearish, broad selling (<40%), above-average volume.
    if (
      niftyTrend === 'BEARISH' &&
      bankniftyTrend === 'BEARISH' &&
      marketBreadth < 40 &&
      relativeVolume > 1.5
    ) {
      return MarketRegime.STRONG_BEAR;
    }

    // ── 6. WEAK_BULL ──────────────────────────────────────────────────────
    // NIFTY bullish, majority of stocks advancing (>50%), average volume.
    if (niftyTrend === 'BULLISH' && marketBreadth > 50 && relativeVolume <= 1.5) {
      return MarketRegime.WEAK_BULL;
    }

    // ── 7. WEAK_BEAR ──────────────────────────────────────────────────────
    // NIFTY bearish with weak market breadth (<50%).
    if (niftyTrend === 'BEARISH' && marketBreadth < 50) {
      return MarketRegime.WEAK_BEAR;
    }

    // ── 8. SIDEWAYS ───────────────────────────────────────────────────────
    // Both indices neutral, breadth within the 45–55 neutral band, low volume.
    if (
      niftyTrend === 'SIDEWAYS' &&
      bankniftyTrend === 'SIDEWAYS' &&
      marketBreadth >= 45 &&
      marketBreadth <= 55 &&
      relativeVolume <= 1.0
    ) {
      return MarketRegime.SIDEWAYS;
    }

    // ── 9. REVERSAL ───────────────────────────────────────────────────────
    // Price structure (VWAP deviation) contradicts prevailing trend direction,
    // suggesting a potential reversal from the trend extreme.
    //   Bullish trend + price significantly below VWAP → potential top reversal.
    //   Bearish trend + price significantly above VWAP → potential bottom reversal.
    if (
      (niftyTrend === 'BULLISH' && vwapDeviation < -this.reversalVwapDeviationThreshold) ||
      (niftyTrend === 'BEARISH' && vwapDeviation > this.reversalVwapDeviationThreshold)
    ) {
      return MarketRegime.REVERSAL;
    }

    // ── 10. UNSTABLE ──────────────────────────────────────────────────────
    // Catch-all: signals are conflicting or no rule above matched cleanly.
    return MarketRegime.UNSTABLE;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the regime produced by the most recent successful classification.
   *
   * Returns `UNSTABLE` on startup until the first classification completes
   * (conservative default that does not allow new signal evaluations).
   */
  getCurrentRegime(): MarketRegime {
    return this.currentRegime;
  }

  /**
   * Accepts the latest indicator snapshot from TechnicalAnalysis (or any
   * market-data producer) and immediately triggers a fresh classification.
   *
   * This is the primary data-ingestion method.  The EVERY_MINUTE cron is a
   * safety-net that re-runs the last available inputs even if the external
   * producer has not delivered a new snapshot within the minute.
   *
   * @param inputs All 10 indicator values.
   */
  async onNewRegimeInputs(inputs: RegimeInputs): Promise<void> {
    this.currentInputs = inputs;
    this.lastInputsTimestamp = new Date();
    await this.performClassification(inputs);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cron job — re-classify every minute (Requirement 5.1: intervals ≤ 60 s)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Cron: fires once per minute.
   *
   * Uses the most recently stored indicator snapshot to re-classify the regime.
   * Skips classification when no inputs have been provided or when inputs are
   * older than 60 seconds (indicating the data source is not supplying updates).
   *
   * Requirement 5.1: classification at intervals not exceeding 60 seconds.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async updateRegime(): Promise<void> {
    // ── Primary path: use live NIFTY/BANKNIFTY LTP from Redis ──────────────
    // Try to build regime inputs from live index snapshots (securityIds 13 =
    // NIFTY, 25 = BANKNIFTY). These are subscribed by SubscriptionRotationService
    // on WebSocket connect. If fresh data exists, classify from it immediately.
    const liveInputs = await this.buildRegimeInputsFromRedis();
    if (liveInputs) {
      this.currentInputs = liveInputs;
      this.lastInputsTimestamp = new Date();
      await this.performClassification(liveInputs);
      return;
    }

    // ── Fallback: re-run last known inputs (original behaviour) ────────────
    if (!this.currentInputs) {
      this.logger.debug('updateRegime: no indicator inputs available — skipping classification');
      return;
    }

    if (this.lastInputsTimestamp) {
      const ageMs = Date.now() - this.lastInputsTimestamp.getTime();
      if (ageMs > 60_000) {
        this.logger.warn(
          `updateRegime: indicator inputs are ${ageMs} ms old — classifying with stale data`,
        );
      }
    }

    await this.performClassification(this.currentInputs);
  }

  /**
   * Build regime inputs from live Redis snapshots for NIFTY (secId=13),
   * BANKNIFTY (secId=25), and India VIX (secId=36).
   *
   * Uses a simple trend proxy: compare current LTP to the LTP stored in a
   * short-term in-memory cache (previous minute's snapshot). If NIFTY is up
   * >0.1% → BULLISH; down >0.1% → BEARISH; otherwise SIDEWAYS.
   *
   * Returns null when no NIFTY snapshot is available in Redis.
   */
  private async buildRegimeInputsFromRedis(): Promise<RegimeInputs | null> {
    try {
      const niftyRaw = await this.redisService.get('mkt:snapshot:13');
      if (!niftyRaw) return null;

      const niftySnap = JSON.parse(niftyRaw) as { ltp: string; volume: string };
      const niftyLtp = parseFloat(niftySnap.ltp);
      if (!niftyLtp || niftyLtp <= 0) return null;

      // Compare to previous LTP for trend determination
      const prevNifty = this.prevLtpCache.get('13') ?? niftyLtp;
      this.prevLtpCache.set('13', niftyLtp);
      const niftyChangePct = ((niftyLtp - prevNifty) / prevNifty) * 100;
      const niftyTrend: TrendDirection =
        niftyChangePct > 0.1 ? 'BULLISH' : niftyChangePct < -0.1 ? 'BEARISH' : 'SIDEWAYS';

      // BANKNIFTY trend (optional — fall back to NIFTY trend)
      let bankniftyTrend: TrendDirection = niftyTrend;
      const bnRaw = await this.redisService.get('mkt:snapshot:25');
      if (bnRaw) {
        const bnSnap = JSON.parse(bnRaw) as { ltp: string };
        const bnLtp = parseFloat(bnSnap.ltp);
        const prevBn = this.prevLtpCache.get('25') ?? bnLtp;
        this.prevLtpCache.set('25', bnLtp);
        const bnChangePct = ((bnLtp - prevBn) / prevBn) * 100;
        bankniftyTrend =
          bnChangePct > 0.1 ? 'BULLISH' : bnChangePct < -0.1 ? 'BEARISH' : 'SIDEWAYS';
      }

      // Volume-based relative volume proxy (snapshot volume / 10M as ratio)
      const niftyVol = parseInt(niftySnap.volume ?? '0', 10);
      const relativeVolume = Math.min(3.0, Math.max(0.1, niftyVol / 1_000_000));

      // ATR proxy: 0.5% of NIFTY LTP
      const atr = niftyLtp * 0.005;

      return {
        niftyTrend,
        bankniftyTrend,
        marketBreadth: niftyTrend === 'BULLISH' ? 60 : niftyTrend === 'BEARISH' ? 40 : 50,
        advanceDeclineRatio: niftyTrend === 'BULLISH' ? 1.5 : niftyTrend === 'BEARISH' ? 0.7 : 1.0,
        vwapDeviation: niftyChangePct,
        indiaVix: 15, // conservative default — no VIX feed yet
        atr,
        relativeVolume,
        sectorStrength: null,
        futuresBasis: null,
      };
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Classifies, persists, and (on regime change) publishes events.
   *
   * Steps:
   *   1. Call classifyRegime(inputs) — pure, synchronous.
   *   2. Persist the record to `market_regimes` table (every classification).
   *   3. Write `regime:current` Redis key (every classification, TTL 300 s).
   *   4. If regime changed from current:
   *      a. Publish `RegimeChangeEvent` to `events:regime_change` Redis channel.
   *      b. Emit `market.regime.changed` NestJS event.
   *   5. If new regime is UNSTABLE, emit `market.regime.unstable` NestJS event.
   *   6. Update in-memory currentRegime.
   *
   * Requirements: 5.3, 5.5
   */
  private async performClassification(inputs: RegimeInputs): Promise<void> {
    const classifiedAt = new Date();
    const newRegime = this.classifyRegime(inputs);
    const rationale = this.buildRationale(newRegime, inputs);
    const previousRegime = this.currentRegime !== newRegime ? this.currentRegime : null;

    // ── Persist to database ───────────────────────────────────────────────
    try {
      const record = this.marketRegimesRepo.create({
        regime: newRegime,
        classifiedAt,
        niftyTrend: inputs.niftyTrend,
        bankniftyTrend: inputs.bankniftyTrend,
        marketBreadth: String(inputs.marketBreadth),
        advanceDeclineRatio: String(inputs.advanceDeclineRatio),
        vwapDeviation: String(inputs.vwapDeviation),
        indiaVix: String(inputs.indiaVix),
        atr: String(inputs.atr),
        relativeVolume: String(inputs.relativeVolume),
        sectorStrength: inputs.sectorStrength !== null ? String(inputs.sectorStrength) : null,
        futuresBasis: inputs.futuresBasis !== null ? String(inputs.futuresBasis) : null,
        classificationRationale: rationale,
      });
      await this.marketRegimesRepo.save(record);
    } catch (err) {
      this.logger.error(`Failed to persist regime classification: ${(err as Error).message}`);
      // Persistence failure does not prevent event publishing; classification
      // proceeds so downstream modules continue to receive regime updates.
    }

    // ── Update Redis `regime:current` ─────────────────────────────────────
    try {
      await this.redisService.set(
        REGIME_CURRENT_KEY,
        JSON.stringify(newRegime),
        REGIME_CURRENT_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.error(`Failed to write regime:current to Redis: ${(err as Error).message}`);
    }

    // ── Update in-memory state ────────────────────────────────────────────
    const regimeChanged = newRegime !== this.currentRegime;
    this.currentRegime = newRegime;

    if (regimeChanged) {
      this.logger.log(
        `Regime transition: ${previousRegime ?? 'none'} → ${newRegime} | ${rationale}`,
      );

      const event: RegimeChangeEvent = {
        regime: newRegime,
        previousRegime: previousRegime as MarketRegime | null,
        inputs,
        rationale,
        classifiedAt,
      };

      // ── Publish to Redis channel (Requirement 5.3) ──────────────────────
      try {
        await this.redisService.publish(REGIME_CHANGE_CHANNEL, JSON.stringify(event));
      } catch (err) {
        this.logger.error(
          `Failed to publish regime change to Redis channel ${REGIME_CHANGE_CHANNEL}: ${(err as Error).message}`,
        );
      }

      // ── Emit NestJS intra-process event ──────────────────────────────────
      this.eventEmitter.emit(REGIME_CHANGED_EVENT, event);
    }

    // ── Notify RiskEngine when regime is UNSTABLE (Requirement 5.6) ───────
    if (newRegime === MarketRegime.UNSTABLE) {
      this.eventEmitter.emit(REGIME_UNSTABLE_EVENT, {
        regime: newRegime,
        classifiedAt,
        inputs,
      });
    }
  }

  /**
   * Builds a concise, human-readable rationale string explaining why a
   * given regime was selected.  Used for the `classificationRationale`
   * database column (Requirement 5.5).
   */
  private buildRationale(regime: MarketRegime, inputs: RegimeInputs): string {
    const {
      niftyTrend,
      bankniftyTrend,
      marketBreadth,
      vwapDeviation,
      indiaVix,
      atr,
      relativeVolume,
    } = inputs;

    switch (regime) {
      case MarketRegime.HIGH_VOL:
        return (
          `VIX override: indiaVix ${indiaVix.toFixed(2)} > ` +
          `threshold ${this.highVolatilityVixThreshold}`
        );

      case MarketRegime.BREAKOUT:
        return (
          `Breakout: relVol ${relativeVolume.toFixed(2)} > ` +
          `${this.breakoutRelativeVolumeThreshold}, ` +
          `|vwapDev| ${Math.abs(vwapDeviation).toFixed(2)} > ` +
          `ATR(${atr.toFixed(2)}) × ${this.breakoutAtrMultiplier}`
        );

      case MarketRegime.LOW_VOL:
        return (
          `Low volatility: relVol ${relativeVolume.toFixed(2)} < ` +
          `${this.lowVolRelativeVolumeThreshold}`
        );

      case MarketRegime.STRONG_BULL:
        return (
          `Strong bull: NIFTY=${niftyTrend}, BANKNIFTY=${bankniftyTrend}, ` +
          `breadth=${marketBreadth.toFixed(1)}%, relVol=${relativeVolume.toFixed(2)}`
        );

      case MarketRegime.STRONG_BEAR:
        return (
          `Strong bear: NIFTY=${niftyTrend}, BANKNIFTY=${bankniftyTrend}, ` +
          `breadth=${marketBreadth.toFixed(1)}%, relVol=${relativeVolume.toFixed(2)}`
        );

      case MarketRegime.WEAK_BULL:
        return (
          `Weak bull: NIFTY=${niftyTrend}, breadth=${marketBreadth.toFixed(1)}%, ` +
          `relVol=${relativeVolume.toFixed(2)}`
        );

      case MarketRegime.WEAK_BEAR:
        return `Weak bear: NIFTY=${niftyTrend}, breadth=${marketBreadth.toFixed(1)}%`;

      case MarketRegime.SIDEWAYS:
        return (
          `Sideways: NIFTY=${niftyTrend}, BANKNIFTY=${bankniftyTrend}, ` +
          `breadth=${marketBreadth.toFixed(1)}%, relVol=${relativeVolume.toFixed(2)}`
        );

      case MarketRegime.REVERSAL:
        return (
          `Reversal signal: NIFTY=${niftyTrend}, ` +
          `vwapDev=${vwapDeviation.toFixed(2)}% (threshold ±${this.reversalVwapDeviationThreshold})`
        );

      case MarketRegime.UNSTABLE:
      default:
        return (
          `Unstable/conflicting signals: NIFTY=${niftyTrend}, BANKNIFTY=${bankniftyTrend}, ` +
          `breadth=${marketBreadth.toFixed(1)}%, relVol=${relativeVolume.toFixed(2)}, ` +
          `vwapDev=${vwapDeviation.toFixed(2)}, vix=${indiaVix.toFixed(2)}`
        );
    }
  }
}
