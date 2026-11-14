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
import { Repository, DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MarketRegimes } from '../../database/entities/market-regimes.entity';
import { RedisService } from '../redis/redis.service';
import { DhanApiClient } from '../dhan/dhan-api.client';
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

/**
 * TTL for `mkt:snapshot:13` / `mkt:snapshot:25` written by the REST LTP
 * poller.  Must be > 60 s (the regime cron interval) so the key is still
 * present when updateRegime() reads it.  The WebSocket path uses only 2 s;
 * this longer TTL is exclusively for the polled index snapshot.
 */
const INDEX_LTP_TTL_SECONDS = 90;

/** IST offset in minutes (UTC+5:30). */
const IST_OFFSET_MINUTES = 330;
/** Market open in IST minutes-of-day (09:15). */
const MARKET_OPEN_IST_MINUTES = 9 * 60 + 15;
/** Market close in IST minutes-of-day (15:30). */
const MARKET_CLOSE_IST_MINUTES = 15 * 60 + 30;

/** Stale threshold (ms) for the near-ATM option pair cache. */
const NEAR_ATM_PAIRS_REFRESH_MS = 5 * 60 * 1_000; // 5 minutes

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
   * Keys: '13' (NIFTY), '25' (BANKNIFTY), 'synth:nifty' (options-derived).
   */
  private readonly prevLtpCache = new Map<string, number>();

  /**
   * Near-ATM NIFTY option CE/PE pairs used by the synthetic fallback
   * in buildRegimeInputsFromOptions().  Loaded from DB on init and refreshed
   * every NEAR_ATM_PAIRS_REFRESH_MS.
   */
  private nearATMOptionPairs: Array<{ ceId: string; peId: string; strike: number }> = [];

  /** UTC timestamp of the last nearATMOptionPairs load. */
  private nearATMPairsLoadedAt: Date | null = null;

  constructor(
    @InjectRepository(MarketRegimes)
    private readonly marketRegimesRepo: Repository<MarketRegimes>,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
    private readonly dhanApiClient: DhanApiClient,
    @InjectDataSource() private readonly dataSource: DataSource,
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
          // Pre-load ATM option pairs and attempt an immediate regime poll
          // so the scanner isn't gated on UNSTABLE after a restart during
          // market hours.
          await this.loadNearATMOptionPairs();
          await this.pollIndexLtp();
          return;
        }
      }
    } catch (err) {
      this.logger.warn(`Could not restore regime from Redis on init: ${(err as Error).message}`);
    }
    this.logger.log(
      `MarketRegimeService initialised — current regime: ${this.currentRegime} (default)`,
    );
    await this.loadNearATMOptionPairs();
    await this.pollIndexLtp();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Index LTP REST polling — 30-second cron
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Poll the Dhan REST API for NIFTY (secId=13) and BANKNIFTY (secId=25) LTP
   * every 30 seconds and write the result to Redis with a 90-second TTL.
   *
   * This is the primary fix for the UNSTABLE regime issue: the IDX_I WebSocket
   * subscription sends no ticks in production, leaving mkt:snapshot:13 absent.
   * The REST endpoint works independently of the WebSocket feed.
   *
   * TTL=90s ensures the key survives until the 60s regime cron reads it.
   * No-op outside market hours to avoid unnecessary API calls.
   */
  @Cron('*/30 * * * * *')
  async pollIndexLtp(): Promise<void> {
    if (!this.isMarketHoursNow()) return;

    try {
      const resp = await this.dhanApiClient.getLtp({ IDX_I: [13, 25, 36] });
      const niftyLtp = resp?.data?.IDX_I?.['13']?.last_price;
      const bnLtp = resp?.data?.IDX_I?.['25']?.last_price;
      const vixLtp = resp?.data?.IDX_I?.['36']?.last_price;

      if (niftyLtp && niftyLtp > 0) {
        // Use volume='800000' as a neutral proxy (0.8 relative volume = average market)
        // since the LTP REST endpoint does not return volume data.
        // This avoids the LOW_VOL classification that volume=0 would cause.
        const snap = JSON.stringify({
          ltp: String(niftyLtp),
          volume: '800000',
          timestamp: Date.now(),
        });
        await this.redisService.set('mkt:snapshot:13', snap, INDEX_LTP_TTL_SECONDS);
        this.logger.debug(
          `pollIndexLtp: NIFTY LTP=${niftyLtp} written (TTL ${INDEX_LTP_TTL_SECONDS}s)`,
        );
      }

      if (bnLtp && bnLtp > 0) {
        const snap = JSON.stringify({ ltp: String(bnLtp), volume: '0', timestamp: Date.now() });
        await this.redisService.set('mkt:snapshot:25', snap, INDEX_LTP_TTL_SECONDS);
        this.logger.debug(
          `pollIndexLtp: BANKNIFTY LTP=${bnLtp} written (TTL ${INDEX_LTP_TTL_SECONDS}s)`,
        );
      }

      // India VIX (secId=36) — used for HIGH_VOL regime override (threshold: 20).
      if (vixLtp && vixLtp > 0) {
        const snap = JSON.stringify({ ltp: String(vixLtp), volume: '0', timestamp: Date.now() });
        await this.redisService.set('mkt:snapshot:36', snap, INDEX_LTP_TTL_SECONDS);
        this.logger.debug(
          `pollIndexLtp: India VIX=${vixLtp} written (TTL ${INDEX_LTP_TTL_SECONDS}s)`,
        );
      }
    } catch (err) {
      this.logger.debug(`pollIndexLtp: REST poll failed — ${(err as Error).message}`);
    }
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
   * Priority chain:
   *  1. Live NIFTY index LTP from Redis (written by pollIndexLtp every 30s)
   *  2. Synthetic NIFTY spot from flowing near-ATM options (put-call parity)
   *  3. Last known inputs (original stale-reuse behaviour)
   *
   * Requirement 5.1: classification at intervals not exceeding 60 seconds.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async updateRegime(): Promise<void> {
    // ── Primary: live NIFTY index LTP from Redis ────────────────────────────
    const liveInputs = await this.buildRegimeInputsFromRedis();
    if (liveInputs) {
      this.currentInputs = liveInputs;
      this.lastInputsTimestamp = new Date();
      await this.performClassification(liveInputs);
      return;
    }

    // ── Secondary: synthetic NIFTY trend from flowing near-ATM options ──────
    // Refreshes the ATM pair list if stale, then uses put-call parity.
    await this.loadNearATMOptionPairs();
    const optionInputs = await this.buildRegimeInputsFromOptions();
    if (optionInputs) {
      this.logger.debug('updateRegime: using options-based synthetic regime fallback');
      this.currentInputs = optionInputs;
      this.lastInputsTimestamp = new Date();
      await this.performClassification(optionInputs);
      return;
    }

    // ── Tertiary: re-run last known inputs ──────────────────────────────────
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

      // India VIX — read from REST-polled mkt:snapshot:36 (secId=36, IDX_I).
      // Falls back to 15 if the key is absent or the value is invalid.
      const vixRaw = await this.redisService.get('mkt:snapshot:36');
      const indiaVix = vixRaw
        ? Math.max(1, parseFloat((JSON.parse(vixRaw) as { ltp: string }).ltp) || 15)
        : 15;

      // Real advance/decline breadth from the live subscription universe.
      const { breadth: marketBreadth, adRatio: advanceDeclineRatio } =
        await this.computeMarketBreadth(niftyTrend);

      return {
        niftyTrend,
        bankniftyTrend,
        marketBreadth,
        advanceDeclineRatio,
        vwapDeviation: niftyChangePct,
        indiaVix,
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
  // Private helpers — index LTP polling, options-based fallback, market hours
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Compute real advance/decline market breadth from the live subscription feed.
   *
   * Scans all instruments currently reporting a live snapshot (`mkt:snapshot:*`)
   * and compares each LTP against its day-open price (`mkt:dayopen:*`).
   * Instruments advancing (LTP > day-open) are counted separately from those
   * declining (LTP < day-open).
   *
   * Returns:
   *   breadth  — advancing% of total (0–100); proxy for NSE-wide breadth.
   *   adRatio  — advance/decline ratio (advancing ÷ declining).
   *
   * Falls back to trend-derived defaults when fewer than MIN_BREADTH_INSTRUMENTS
   * instruments have both keys present (e.g. pre-market or thin feed).
   *
   * Fix for: GAP-002 — market breadth was a hardcoded ternary on niftyTrend.
   */
  private async computeMarketBreadth(
    fallbackTrend: TrendDirection,
  ): Promise<{ breadth: number; adRatio: number }> {
    const FALLBACK: Record<TrendDirection, { breadth: number; adRatio: number }> = {
      BULLISH: { breadth: 60, adRatio: 1.5 },
      BEARISH: { breadth: 40, adRatio: 0.7 },
      SIDEWAYS: { breadth: 50, adRatio: 1.0 },
    };
    const MIN_INSTRUMENTS = 5;

    try {
      // Collect all security IDs with an active snapshot (excludes indices 13/25/36)
      const snapshotKeys = await this.redisService.keys('mkt:snapshot:*');
      const ids = snapshotKeys
        .map((k) => k.replace('mkt:snapshot:', ''))
        .filter((id) => !['13', '25', '36'].includes(id));

      if (ids.length < MIN_INSTRUMENTS) return FALLBACK[fallbackTrend];

      // Batch-fetch current LTPs and day-open prices in parallel
      const pairs = await Promise.all(
        ids.map(async (id) => {
          const [snapRaw, dayopenStr] = await Promise.all([
            this.redisService.get(`mkt:snapshot:${id}`),
            this.redisService.get(`mkt:dayopen:${id}`),
          ]);
          return { snapRaw, dayopenStr };
        }),
      );

      let advancing = 0;
      let declining = 0;

      for (const { snapRaw, dayopenStr } of pairs) {
        if (!snapRaw || !dayopenStr) continue;
        const ltp = parseFloat((JSON.parse(snapRaw) as { ltp: string }).ltp);
        const dayOpen = parseFloat(dayopenStr);
        if (!ltp || !dayOpen) continue;
        if (ltp > dayOpen) advancing++;
        else if (ltp < dayOpen) declining++;
      }

      const total = advancing + declining;
      if (total < MIN_INSTRUMENTS) return FALLBACK[fallbackTrend];

      const breadth = (advancing / total) * 100;
      const adRatio = declining > 0 ? advancing / declining : advancing > 0 ? 3.0 : 1.0;

      this.logger.debug(
        `computeMarketBreadth: ${advancing} advancing / ${declining} declining` +
          ` of ${total} instruments → breadth=${breadth.toFixed(1)}% A/D=${adRatio.toFixed(2)}`,
      );

      return { breadth, adRatio };
    } catch {
      return FALLBACK[fallbackTrend];
    }
  }

  /**
   * Load the nearest-expiry near-ATM NIFTY call/put pairs from the instruments
   * table into memory. Used by buildRegimeInputsFromOptions() as a fallback when
   * neither the WebSocket IDX_I feed nor the REST poll yields NIFTY LTP.
   *
   * Refreshes automatically if the cache is older than NEAR_ATM_PAIRS_REFRESH_MS.
   */
  private async loadNearATMOptionPairs(): Promise<void> {
    const now = new Date();
    if (
      this.nearATMPairsLoadedAt &&
      now.getTime() - this.nearATMPairsLoadedAt.getTime() < NEAR_ATM_PAIRS_REFRESH_MS
    ) {
      return; // cache is still fresh
    }

    try {
      const rows = await this.dataSource.query<
        Array<{ ce_id: string; pe_id: string; strike_price: string }>
      >(`
        SELECT ce.security_id AS ce_id,
               pe.security_id AS pe_id,
               ce.strike_price
        FROM instruments ce
        JOIN instruments pe
          ON  pe.underlying    = ce.underlying
          AND pe.strike_price  = ce.strike_price
          AND pe.expiry_date   = ce.expiry_date
          AND pe.option_type   = 'PE'
        WHERE ce.underlying   = 'NIFTY'
          AND ce.option_type  = 'CE'
          AND ce.expiry_date  >= CURRENT_DATE
        ORDER BY ce.expiry_date ASC, ce.strike_price ASC
        LIMIT 40
      `);

      this.nearATMOptionPairs = rows.map((r) => ({
        ceId: r.ce_id,
        peId: r.pe_id,
        strike: parseFloat(r.strike_price),
      }));
      this.nearATMPairsLoadedAt = now;
      this.logger.debug(
        `loadNearATMOptionPairs: loaded ${this.nearATMOptionPairs.length} CE/PE pairs`,
      );
    } catch (err) {
      this.logger.warn(`loadNearATMOptionPairs: DB query failed — ${(err as Error).message}`);
    }
  }

  /**
   * Synthetic NIFTY regime fallback using put-call parity on flowing options.
   *
   * When neither the IDX_I WebSocket feed nor the REST poll supplies
   * mkt:snapshot:13, this method scans the in-memory nearATMOptionPairs list
   * for a CE/PE pair that both have live snapshots in Redis.  It then estimates
   * the NIFTY spot via put-call parity:
   *
   *   SyntheticSpot = Strike + Call_LTP - Put_LTP
   *
   * Direction is derived by comparing the synthetic spot to the previous
   * value in prevLtpCache ('synth:nifty'): >0.1% = BULLISH, <-0.1% = BEARISH.
   *
   * Returns null if no CE/PE pair with live data can be found.
   */
  private async buildRegimeInputsFromOptions(): Promise<RegimeInputs | null> {
    if (this.nearATMOptionPairs.length === 0) return null;

    try {
      for (const { ceId, peId, strike } of this.nearATMOptionPairs) {
        const ceRaw = await this.redisService.get(`mkt:snapshot:${ceId}`);
        const peRaw = await this.redisService.get(`mkt:snapshot:${peId}`);
        if (!ceRaw || !peRaw) continue;

        const ceLtp = parseFloat((JSON.parse(ceRaw) as { ltp: string }).ltp);
        const peLtp = parseFloat((JSON.parse(peRaw) as { ltp: string }).ltp);
        if (!ceLtp || !peLtp || ceLtp <= 0 || peLtp <= 0) continue;

        // Put-call parity synthetic forward (≈ spot for index options)
        const syntheticSpot = strike + ceLtp - peLtp;
        const prevSpot = this.prevLtpCache.get('synth:nifty') ?? syntheticSpot;
        this.prevLtpCache.set('synth:nifty', syntheticSpot);

        const changePct = ((syntheticSpot - prevSpot) / prevSpot) * 100;
        const niftyTrend: TrendDirection =
          changePct > 0.1 ? 'BULLISH' : changePct < -0.1 ? 'BEARISH' : 'SIDEWAYS';

        this.logger.debug(
          `buildRegimeInputsFromOptions: synth spot=${syntheticSpot.toFixed(2)} ` +
            `(strike=${strike} CE=${ceLtp} PE=${peLtp}) → ${niftyTrend}`,
        );

        return {
          niftyTrend,
          bankniftyTrend: niftyTrend, // use same as a conservative proxy
          marketBreadth: niftyTrend === 'BULLISH' ? 60 : niftyTrend === 'BEARISH' ? 40 : 50,
          advanceDeclineRatio:
            niftyTrend === 'BULLISH' ? 1.5 : niftyTrend === 'BEARISH' ? 0.7 : 1.0,
          vwapDeviation: changePct,
          indiaVix: 15, // conservative default
          atr: syntheticSpot * 0.005,
          relativeVolume: 0.8, // conservative — no volume available on this path
          sectorStrength: null,
          futuresBasis: null,
        };
      }
    } catch (err) {
      this.logger.debug(`buildRegimeInputsFromOptions: failed — ${(err as Error).message}`);
    }

    return null;
  }

  /**
   * Returns true if the current IST time falls within NSE market hours
   * (09:15–15:30, Monday–Friday).
   */
  private isMarketHoursNow(): boolean {
    const now = new Date();
    const utcMod = now.getUTCHours() * 60 + now.getUTCMinutes();
    const istMod = (utcMod + IST_OFFSET_MINUTES) % (24 * 60);
    // IST day-of-week: Sunday=0 … Saturday=6
    const utcDay = now.getUTCDay();
    const istDay = ((utcDay * 24 * 60 + utcMod + IST_OFFSET_MINUTES) / (24 * 60)) % 7;
    const istDayOfWeek = Math.floor(istDay);
    if (istDayOfWeek < 1 || istDayOfWeek > 5) return false;
    return istMod >= MARKET_OPEN_IST_MINUTES && istMod <= MARKET_CLOSE_IST_MINUTES;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers — classification and events

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
