/**
 * signal-scanner.service.ts
 *
 * SignalScannerService — cron-based scanner that evaluates live instruments
 * against the strategy pipeline every 2 minutes during market hours.
 *
 * Pipeline:
 *   Redis mkt:snapshot:* (live ticks from DhanWebSocket, keyed by securityId)
 *     → look up instruments table (id, strikePrice, optionType, underlying)
 *     → near-ATM filter: skip if |strike − spot| / spot > 10%
 *     → directional filter: CE only in bull regimes, PE only in bear regimes
 *     → minimum LTP filter: skip options with premium < ₹20
 *     → load recent 1m candles from historical_candles (CandleQueryService)
 *     → compute indicators (VWAP, RSI, MACD, EMA9/21, ATR, RelVol, ORB)
 *     → evaluate entry conditions (RSI ≥ 55 for directional option momentum)
 *     → build SignalCandidateInput with real component scores
 *     → StrategyService.evaluateSignalCandidate()
 *
 * Key improvements in this version:
 *
 *   Near-ATM filter (Improvement 1):
 *     Instruments with |strike − spotPrice| / spotPrice > NEAR_ATM_PCT (10%)
 *     are skipped before any candle or indicator computation.  This eliminates
 *     deep OTM options (e.g. 17000-PE when NIFTY is at 21500) that have near-
 *     zero delta and historically produced 0% win rates in simulation.
 *
 *   Directional CE/PE selection (Improvement 2):
 *     The scanner now only processes CE instruments in bull regimes and PE
 *     instruments in bear regimes.  Previously both were processed regardless
 *     of market direction, causing opposing trades to cancel each other out and
 *     generating losses from time decay.
 *
 *   Directional RSI entry condition:
 *     For any directional option trade (CE or PE), the option premium must be
 *     in an uptrend (RSI ≥ 55) before entry.  This confirms that the option
 *     has momentum and that the underlying is moving in the expected direction.
 *
 * Requirements: DEFECT-002, DEFECT-003, signal pipeline coverage
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { MarketRegimeService } from '../market-regime/market-regime.service';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { StrategyService } from '../strategy/strategy.service';
import { SniperEntryService } from './sniper-entry.service';
import { LiveTradingService } from '../live-trading/live-trading.service';
import { CandleQueryService } from '../market-data/candle-query.service';
import { TechnicalAnalysisService } from '../technical-analysis/technical-analysis.service';
import { MarketRegime } from '../market-regime/market-regime.types';
import { SessionPhase } from '../session-manager/session-manager.types';
import { SignalCandidateInput } from '../strategy/strategy.types';
import { SignalComponentScores } from '../signal-scoring/signal-scoring.types';
import {
  OHLCV as _OHLCV,
  MACDResult,
  ORBResult,
} from '../technical-analysis/technical-analysis.types';
import { Instruments } from '../../database/entities/instruments.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default position size in lots — used as minimum floor. */
const DEFAULT_POSITION_SIZE = 1;
const SL_PCT = 0.015;
const TARGET_PCT = 0.03;

const MIN_CANDLES_FOR_INDICATORS = 20;
const MIN_CANDLES_FOR_MACD = 34;
const IST_OFFSET_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000;

/**
 * Maximum % deviation of option strike from underlying spot price.
 * Options with |strike − spot| / spot > 10% are deep OTM and are skipped.
 * Near-ATM filter — Improvement 1.
 */
const NEAR_ATM_PCT = 0.1;

/**
 * Minimum option premium (LTP) in INR.
 * Options trading below ₹20 are essentially worthless with spread dominating.
 */
const MIN_OPTION_LTP = 20;

/**
 * Minimum RSI required on the OPTION PREMIUM for a directional entry.
 * RSI ≥ 55 confirms the option has upward momentum (CE rising = underlying up,
 * PE rising = underlying down).  Below this threshold, the premium is drifting
 * or declining — not an ideal buying opportunity.
 */
const DIRECTIONAL_RSI_MIN = 55;

/**
 * Dhan security IDs for index spot prices.
 * Used to look up `mkt:snapshot:{securityId}` for near-ATM calculation.
 */
const SPOT_SECURITY_IDS: Record<string, string> = {
  NIFTY: '13',
  BANKNIFTY: '25',
};

/** Regimes where CE (call) purchases are directionally favoured. */
const CE_REGIMES = new Set<MarketRegime>([
  MarketRegime.STRONG_BULL,
  MarketRegime.WEAK_BULL,
  MarketRegime.BREAKOUT, // Most breakouts are to the upside
]);

/** Regimes where PE (put) purchases are directionally favoured. */
const PE_REGIMES = new Set<MarketRegime>([
  MarketRegime.STRONG_BEAR,
  MarketRegime.WEAK_BEAR,
  MarketRegime.REVERSAL, // Reversals typically follow bull runs
]);

/** Regime-to-regimeAlignment score (0–15). */
const REGIME_SCORE: Record<string, number> = {
  [MarketRegime.STRONG_BULL]: 15,
  [MarketRegime.WEAK_BULL]: 12,
  [MarketRegime.BREAKOUT]: 11,
  [MarketRegime.SIDEWAYS]: 8,
  [MarketRegime.LOW_VOL]: 6,
  [MarketRegime.HIGH_VOL]: 5,
  [MarketRegime.WEAK_BEAR]: 5,
  [MarketRegime.STRONG_BEAR]: 4,
};

/** Session phases where new entry scanning is permitted. */
const SCANNABLE_PHASES = new Set<SessionPhase>([
  SessionPhase.ORB_FORMATION,
  SessionPhase.MORNING_MOMENTUM,
  SessionPhase.MID_SESSION,
  SessionPhase.AFTERNOON,
  SessionPhase.AFTERNOON_LATE, // 14:30–15:00 IST — entries still allowed
]);

// ─────────────────────────────────────────────────────────────────────────────
// Local types
// ─────────────────────────────────────────────────────────────────────────────

/** Snapshot from Redis for one instrument. */
interface SnapshotData {
  ltp: number;
  bidPrice: number | null;
  askPrice: number | null;
  volume: number;
}

/**
 * Enriched instrument metadata cached at scan start.
 * Extends the previous `securityId → id` mapping to include the fields
 * required for near-ATM filtering and directional selection.
 */
interface InstrumentCacheEntry {
  /** DB UUID of the instrument. */
  id: string;
  /** Strike price in INR, or null for non-option instruments. */
  strikePrice: number | null;
  /** Option type: 'CE', 'PE', or null for non-option instruments. */
  optionType: 'CE' | 'PE' | null;
  /** Underlying asset symbol (e.g. 'NIFTY', 'BANKNIFTY'). */
  underlying: string;
}

/**
 * Pre-computed indicator snapshot for one instrument.
 */
export interface IndicatorSnapshot {
  vwap: number | null;
  rsi: number | null;
  atr: number | null;
  macd: MACDResult | null;
  ema9: number | null;
  ema21: number | null;
  relVol: number | null;
  orb: ORBResult | null;
  candleCount: number;
}

/** Neutral indicator snapshot used when candle data is unavailable. */
const EMPTY_INDICATORS: IndicatorSnapshot = {
  vwap: null,
  rsi: null,
  atr: null,
  macd: null,
  ema9: null,
  ema21: null,
  relVol: null,
  orb: null,
  candleCount: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SignalScannerService {
  private readonly logger = new Logger(SignalScannerService.name);

  /**
   * Instrument metadata cache: securityId → InstrumentCacheEntry.
   * Refreshed at the start of each scan cycle.
   * Now includes strikePrice, optionType, underlying for filtering.
   */
  private instrumentMetaCache = new Map<string, InstrumentCacheEntry>();

  /**
   * Spot price cache: underlying symbol → current spot price.
   * Populated from `mkt:snapshot:{securityId}` at the start of each scan.
   * Used by isNearATM() for near-ATM filtering.
   */
  private spotPriceCache = new Map<string, number>();

  constructor(
    private readonly redisService: RedisService,
    private readonly marketRegimeService: MarketRegimeService,
    private readonly sessionManagerService: SessionManagerService,
    private readonly strategyService: StrategyService,
    private readonly sniperEntryService: SniperEntryService,
    private readonly liveTradingService: LiveTradingService,
    private readonly candleQueryService: CandleQueryService,
    private readonly technicalAnalysisService: TechnicalAnalysisService,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  // ─── Cron: scan every 2 minutes, Mon–Fri ───────────────────────────────────

  @Cron('*/2 * * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scanForSignals(): Promise<void> {
    const phase = this.sessionManagerService.getCurrentPhase();

    if (!SCANNABLE_PHASES.has(phase)) {
      this.logger.debug(`[Scanner] Skipping scan — phase=${phase}`);
      return;
    }

    const regime = this.marketRegimeService.getCurrentRegime();
    const isOpeningPhase = phase === SessionPhase.OPENING_VOLATILITY;

    this.logger.log(`[Scanner] Starting scan — phase=${phase} regime=${regime}`);

    const snapshotKeys = await this.redisService.keys('mkt:snapshot:*');
    if (snapshotKeys.length === 0) {
      this.logger.warn('[Scanner] No market snapshots in Redis — data feed may be down');
      return;
    }

    // ── Build enriched instrument metadata cache ───────────────────────────
    const securityIds = snapshotKeys.map((k) => k.replace('mkt:snapshot:', ''));
    await this.refreshInstrumentCache(securityIds);

    if (this.instrumentMetaCache.size === 0) {
      this.logger.warn(
        `[Scanner] None of the ${securityIds.length} snapshot securityIds ` +
          `matched instruments in the DB — verify instruments table is seeded`,
      );
      return;
    }

    // ── Load underlying spot prices for near-ATM filter ────────────────────
    await this.loadSpotPrices();

    this.logger.log(
      `[Scanner] Cache loaded: ${this.instrumentMetaCache.size}/${securityIds.length} instruments | ` +
        `spots: ${[...this.spotPriceCache.entries()].map(([u, p]) => `${u}=${p}`).join(', ') || 'none'}`,
    );

    let evaluated = 0;
    let skipped = 0;
    let skippedOtm = 0;
    let skippedDirection = 0;
    let noInstrument = 0;

    for (const key of snapshotKeys) {
      const securityId = key.replace('mkt:snapshot:', '');
      const instrEntry = this.instrumentMetaCache.get(securityId);

      if (!instrEntry) {
        noInstrument++;
        continue;
      }

      // ── Improvement 2: Directional CE/PE selection ────────────────────────
      // Only trade CEs in bull regimes and PEs in bear regimes.
      // Instruments with no optionType (futures, indices) always pass.
      if (!this.isDirectionalMatch(instrEntry.optionType, regime)) {
        skippedDirection++;
        continue;
      }

      // ── Improvement 1: Near-ATM filter ───────────────────────────────────
      // Skip deep OTM options — they have near-zero delta and historically
      // produce 0% win rates regardless of signal quality.
      if (!this.isNearATM(instrEntry.strikePrice, instrEntry.underlying)) {
        skippedOtm++;
        continue;
      }

      const snapshot = await this.loadSnapshot(key);
      if (!snapshot || !this.isEligible(snapshot)) {
        skipped++;
        continue;
      }

      // ── Minimum LTP filter: skip penny/near-worthless options ─────────────
      if (instrEntry.optionType !== null && snapshot.ltp < MIN_OPTION_LTP) {
        skipped++;
        this.logger.debug(
          `[Scanner] Skipping ${securityId} — LTP ₹${snapshot.ltp} < minimum ₹${MIN_OPTION_LTP}`,
        );
        continue;
      }

      const indicators = await this.computeIndicators(instrEntry.id);

      const candidate = this.buildCandidate(
        instrEntry.id,
        securityId,
        snapshot,
        regime,
        isOpeningPhase,
        indicators,
        instrEntry.optionType,
      );

      try {
        await this.strategyService.evaluateSignalCandidate(candidate);
        evaluated++;
      } catch (err) {
        this.logger.error(
          `[Scanner] evaluateSignalCandidate failed for ${instrEntry.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `[Scanner] Scan complete — evaluated=${evaluated} ` +
        `skipped_direction=${skippedDirection} skipped_otm=${skippedOtm} ` +
        `skipped_other=${skipped} noInstrument=${noInstrument} total=${snapshotKeys.length}`,
    );
  }

  // ─── On-demand scan (dashboard debug trigger) ──────────────────────────────

  @OnEvent('debug.trigger_scan')
  async onDebugTriggerScan(): Promise<void> {
    this.logger.log('[Scanner] On-demand scan triggered by dashboard — bypassing phase guard');
    const snapshotKeys = await this.redisService.keys('mkt:snapshot:*');

    if (snapshotKeys.length === 0) {
      this.logger.warn(
        '[Scanner] No market snapshots — on-demand scan cannot evaluate any instruments',
      );
      return;
    }

    const regime = this.marketRegimeService.getCurrentRegime();
    const securityIds = snapshotKeys.map((k) => k.replace('mkt:snapshot:', ''));
    await this.refreshInstrumentCache(securityIds);
    await this.loadSpotPrices();

    if (this.instrumentMetaCache.size === 0) {
      this.logger.warn('[Scanner] No snapshot securityIds matched instruments in DB');
      return;
    }

    let evaluated = 0;
    for (const key of snapshotKeys) {
      const securityId = key.replace('mkt:snapshot:', '');
      const instrEntry = this.instrumentMetaCache.get(securityId);
      if (!instrEntry) continue;
      if (!this.isDirectionalMatch(instrEntry.optionType, regime)) continue;
      if (!this.isNearATM(instrEntry.strikePrice, instrEntry.underlying)) continue;

      const snapshot = await this.loadSnapshot(key);
      if (!snapshot || !this.isEligible(snapshot)) continue;
      if (instrEntry.optionType !== null && snapshot.ltp < MIN_OPTION_LTP) continue;

      const indicators = await this.computeIndicators(instrEntry.id);
      const candidate = this.buildCandidate(
        instrEntry.id,
        securityId,
        snapshot,
        regime,
        false,
        indicators,
        instrEntry.optionType,
      );
      try {
        await this.strategyService.evaluateSignalCandidate(candidate);
        evaluated++;
      } catch (err) {
        this.logger.error(`[Scanner] evaluateSignalCandidate failed: ${(err as Error).message}`);
      }
    }
    this.logger.log(`[Scanner] On-demand scan complete — evaluated=${evaluated}`);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Refresh the instrument metadata cache for the current scan cycle.
   * Now selects strikePrice, optionType, and underlying in addition to id.
   */
  private async refreshInstrumentCache(securityIds: string[]): Promise<void> {
    this.instrumentMetaCache.clear();
    if (securityIds.length === 0) return;

    try {
      const instruments = await this.instrumentsRepo
        .createQueryBuilder('i')
        .select(['i.id', 'i.securityId', 'i.strikePrice', 'i.optionType', 'i.underlying'])
        .where('i.security_id IN (:...ids)', { ids: securityIds })
        .getMany();

      for (const instr of instruments) {
        this.instrumentMetaCache.set(instr.securityId, {
          id: instr.id,
          strikePrice: instr.strikePrice != null ? parseFloat(instr.strikePrice) : null,
          optionType: instr.optionType,
          underlying: instr.underlying,
        });
      }
    } catch (err) {
      this.logger.error(`[Scanner] Failed to load instrument cache: ${(err as Error).message}`);
    }
  }

  /**
   * Fetch current spot prices for all configured index underlyings from Redis.
   * Falls back gracefully — if a spot price is unavailable, the near-ATM
   * filter passes all instruments for that underlying (no false negatives).
   */
  private async loadSpotPrices(): Promise<void> {
    this.spotPriceCache.clear();
    for (const [underlying, secId] of Object.entries(SPOT_SECURITY_IDS)) {
      try {
        const raw = await this.redisService.get(`mkt:snapshot:${secId}`);
        if (raw) {
          const parsed = JSON.parse(raw) as { ltp?: string };
          const spot = parseFloat(parsed.ltp ?? '0');
          if (!isNaN(spot) && spot > 0) {
            this.spotPriceCache.set(underlying, spot);
          }
        }
      } catch {
        // Non-critical — near-ATM filter will pass all instruments for this underlying
      }
    }
  }

  private async loadSnapshot(key: string): Promise<SnapshotData | null> {
    try {
      const raw = await this.redisService.get(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as {
        ltp?: string;
        bidPrice?: string | null;
        askPrice?: string | null;
        volume?: string;
      };

      const ltp = parseFloat(parsed.ltp ?? '0');
      const bidPrice = parsed.bidPrice ? parseFloat(parsed.bidPrice) : null;
      const askPrice = parsed.askPrice ? parseFloat(parsed.askPrice) : null;
      const volume = parseInt(parsed.volume ?? '0', 10);

      if (isNaN(ltp)) return null;
      return { ltp, bidPrice, askPrice, volume };
    } catch {
      return null;
    }
  }

  private isEligible(snapshot: SnapshotData): boolean {
    const marketSnapshot = {
      ltp: String(snapshot.ltp),
      bidPrice: snapshot.bidPrice !== null ? String(snapshot.bidPrice) : null,
      askPrice: snapshot.askPrice !== null ? String(snapshot.askPrice) : null,
      volume: String(snapshot.volume),
      oi: null,
      timestamp: Date.now(),
    };

    const result = this.sniperEntryService.evaluate({
      snapshot: marketSnapshot,
      direction: 'BUY',
    });

    if (!result.eligible) {
      this.logger.debug(
        `[Scanner] Sniper filter rejected — ${result.primaryFailureReason ?? result.failingFilters.join(', ')}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Near-ATM filter — Improvement 1.
   *
   * Returns true when the instrument's strike price is within NEAR_ATM_PCT
   * (10%) of the current spot price, or when the spot price is unavailable.
   *
   * Deep OTM options have near-zero delta and lose money almost regardless of
   * signal quality.  Filtering them out increases signal hit rate significantly
   * without reducing the trade universe for the strategies that actually work.
   *
   * @param strikePrice  Option strike price in INR, or null for non-options.
   * @param underlying   Underlying symbol (e.g. 'NIFTY', 'BANKNIFTY').
   */
  isNearATM(strikePrice: number | null, underlying: string): boolean {
    if (strikePrice === null) return true; // non-option (futures, index) — always pass
    const spotPrice = this.spotPriceCache.get(underlying);
    if (!spotPrice) return true; // no spot data — pass gracefully
    const pctFromATM = Math.abs(strikePrice - spotPrice) / spotPrice;
    return pctFromATM <= NEAR_ATM_PCT;
  }

  /**
   * Directional CE/PE selection — Improvement 2.
   *
   * Returns true when the instrument's option type is compatible with the
   * current market regime:
   *   - CE (call): only in STRONG_BULL, WEAK_BULL, BREAKOUT
   *   - PE (put):  only in STRONG_BEAR, WEAK_BEAR, REVERSAL
   *   - null (non-option): always passes
   *
   * In all other regimes (SIDEWAYS, LOW_VOL, HIGH_VOL, UNSTABLE), no options
   * are traded.  Options buying in uncertain regimes loses money to time decay
   * without directional edge.
   *
   * @param optionType  'CE', 'PE', or null.
   * @param regime      Current market regime.
   */
  isDirectionalMatch(optionType: 'CE' | 'PE' | null, regime: MarketRegime): boolean {
    if (optionType === null) return true; // non-option instruments always match
    if (optionType === 'CE') return CE_REGIMES.has(regime);
    if (optionType === 'PE') return PE_REGIMES.has(regime);
    return false; // unknown option type
  }

  /**
   * Fetches today's 1m candles for the instrument and computes all indicators.
   */
  async computeIndicators(instrumentId: string): Promise<IndicatorSnapshot> {
    const todayCandles = await this.candleQueryService.getTodayCandles(instrumentId);

    if (todayCandles.length < MIN_CANDLES_FOR_INDICATORS) {
      this.logger.debug(
        `[Scanner] Indicators unavailable for ${instrumentId} — ` +
          `only ${todayCandles.length} 1m candles (need ≥${MIN_CANDLES_FOR_INDICATORS})`,
      );
      return { ...EMPTY_INDICATORS, candleCount: todayCandles.length };
    }

    const vwap = this.technicalAnalysisService.computeVWAP(todayCandles);
    const rsi = this.technicalAnalysisService.computeRSI(todayCandles);
    const atr = this.technicalAnalysisService.computeATR(todayCandles);

    const macd =
      todayCandles.length >= MIN_CANDLES_FOR_MACD
        ? this.technicalAnalysisService.computeMACD(todayCandles)
        : null;

    const ema9 = this.technicalAnalysisService.computeEMA(todayCandles, 9);
    const ema21 = this.technicalAnalysisService.computeEMA(todayCandles, 21);

    let relVol: number | null = null;
    try {
      const multiDay = await this.candleQueryService.getMultiDayCandles(instrumentId, 5);
      if (multiDay.length > 0) {
        relVol = this.technicalAnalysisService.computeRelativeVolume(multiDay, 5);
      }
    } catch {
      // Non-critical
    }

    const orbSessionStart = this.getSessionOpenUtc();
    const orb = this.technicalAnalysisService.computeORBRange(todayCandles, orbSessionStart);

    return { vwap, rsi, atr, macd, ema9, ema21, relVol, orb, candleCount: todayCandles.length };
  }

  /**
   * Evaluates entry conditions from live indicators.
   *
   * When `optionType` is provided (CE or PE), applies a stricter RSI filter:
   *   - Requires option premium RSI ≥ 55 (option in uptrend = underlying moving
   *     in the expected direction for that option type).
   *
   * Without `optionType`, uses the original DEFECT-002 guards (RSI 25–75,
   * VWAP ±15%, relVol > 0.2) for backward compatibility.
   *
   * Fix for DEFECT-002.
   *
   * @param ltp         Current last-traded price.
   * @param indicators  Pre-computed indicator snapshot.
   * @param optionType  'CE', 'PE', or null/undefined for non-directional.
   */
  evaluateEntryConditions(
    ltp: number,
    indicators: IndicatorSnapshot,
    optionType?: 'CE' | 'PE' | null,
  ): { met: boolean; reason?: string } {
    // ── Graceful degradation: no candle data ─────────────────────────────────
    if (indicators.candleCount < MIN_CANDLES_FOR_INDICATORS) {
      return { met: true };
    }

    // ── RSI check ─────────────────────────────────────────────────────────────
    if (indicators.rsi !== null) {
      if (optionType === 'CE' || optionType === 'PE') {
        // Directional option: require RSI ≥ 55 to confirm premium uptrend.
        // For CE: rising premium = underlying going up = bullish confirmation.
        // For PE: rising premium = underlying going down = bearish confirmation.
        if (indicators.rsi < DIRECTIONAL_RSI_MIN) {
          return {
            met: false,
            reason:
              `RSI ${indicators.rsi.toFixed(1)} below ${DIRECTIONAL_RSI_MIN} — ` +
              `option premium not in uptrend (need RSI ≥ ${DIRECTIONAL_RSI_MIN} for ${optionType} momentum)`,
          };
        }
      } else {
        // Non-directional: original DEFECT-002 guards (25–75 extremes only)
        if (indicators.rsi < 25) {
          return {
            met: false,
            reason: `RSI ${indicators.rsi.toFixed(1)} below 25 — deeply oversold extreme`,
          };
        }
        if (indicators.rsi > 75) {
          return {
            met: false,
            reason: `RSI ${indicators.rsi.toFixed(1)} above 75 — deeply overbought extreme`,
          };
        }
      }
    }

    // ── VWAP deviation check ──────────────────────────────────────────────────
    if (indicators.vwap !== null && indicators.vwap > 0) {
      const vwapDeviation = Math.abs(ltp - indicators.vwap) / indicators.vwap;
      if (vwapDeviation > 0.15) {
        return {
          met: false,
          reason:
            `LTP ${ltp.toFixed(2)} is ${(vwapDeviation * 100).toFixed(1)}% from ` +
            `VWAP ${indicators.vwap.toFixed(2)} (threshold: 15%)`,
        };
      }
    }

    // ── Relative volume check ─────────────────────────────────────────────────
    if (indicators.relVol !== null && indicators.relVol < 0.2) {
      return {
        met: false,
        reason:
          `Relative volume ${indicators.relVol.toFixed(2)} below 0.20 — ` +
          `instrument volume critically low vs historical average`,
      };
    }

    return { met: true };
  }

  private buildCandidate(
    instrumentId: string,
    securityId: string,
    snapshot: SnapshotData,
    regime: MarketRegime,
    isOpeningPhase: boolean,
    indicators: IndicatorSnapshot,
    optionType?: 'CE' | 'PE' | null,
  ): SignalCandidateInput {
    const ltp = snapshot.ltp;
    const direction = 'BUY'; // Always BUY the option (CE or PE)

    const slDist = ltp * SL_PCT;
    const targetDist = ltp * TARGET_PCT;

    const entryPrice = ltp;
    const stopLossPrice = ltp - slDist;
    const targetPrice = ltp + targetDist;
    const safeSl = Math.max(stopLossPrice, 0.01);
    const rrRatio = targetDist / slDist; // 2.0

    const componentScores = this.computeComponentScores(snapshot, regime, rrRatio, indicators);
    const engine: 'LIVE' | 'PAPER' = this.liveTradingService.isArmed() ? 'LIVE' : 'PAPER';

    // Pass optionType to entry conditions for the stricter directional RSI check
    const entryEval = this.evaluateEntryConditions(ltp, indicators, optionType);

    const measuredInputs: Record<string, unknown> = {
      ltp,
      bidPrice: snapshot.bidPrice,
      askPrice: snapshot.askPrice,
      volume: snapshot.volume,
      regime,
      securityId,
      optionType: optionType ?? null,
      approxRrRatio: rrRatio,
      slPct: SL_PCT,
      targetPct: TARGET_PCT,
      scannerVersion: '3.0',
      engineMode: engine,
      indicators: {
        vwap: indicators.vwap,
        rsi: indicators.rsi,
        atr: indicators.atr,
        ema9: indicators.ema9,
        ema21: indicators.ema21,
        macdHistogram: indicators.macd?.histogram ?? null,
        relVol: indicators.relVol,
        orbHigh: indicators.orb?.orbHigh ?? null,
        orbLow: indicators.orb?.orbLow ?? null,
        candleCount: indicators.candleCount,
      },
      entryConditionsMet: entryEval.met,
      entryConditionsFailReason: entryEval.reason ?? null,
    };

    return {
      instrumentId,
      engine,
      direction: direction as 'BUY' | 'SELL',
      currentRegime: regime,
      isOpeningPhase,
      entryConditionsMet: entryEval.met,
      entryConditionsFailReason: entryEval.reason,
      entryPrice: entryPrice.toFixed(2),
      stopLossPrice: safeSl.toFixed(2),
      targetPrice: targetPrice.toFixed(2),
      positionSize: DEFAULT_POSITION_SIZE,
      componentScores,
      measuredInputs,
    };
  }

  /**
   * Compute per-component signal scores.
   * momentum and vwapTrendAlignment are indicator-driven (DEFECT-003 fix).
   */
  computeComponentScores(
    snapshot: SnapshotData,
    regime: MarketRegime,
    rrRatio: number,
    indicators: IndicatorSnapshot,
  ): SignalComponentScores {
    const regimeAlignment = REGIME_SCORE[regime] ?? 7;
    const priceStructure = snapshot.bidPrice !== null && snapshot.askPrice !== null ? 12 : 10;
    const volumeConfirmation = snapshot.volume > 100 ? 13 : snapshot.volume > 0 ? 10 : 7;

    // RSI-driven momentum score
    let momentum: number;
    if (indicators.rsi !== null) {
      const rsi = indicators.rsi;
      if (rsi >= 60 && rsi <= 75) momentum = 15;
      else if (rsi >= 55) momentum = 12;
      else if (rsi >= 50) momentum = 10;
      else if (rsi >= 40) momentum = 9;
      else if (rsi >= 25) momentum = 6;
      else momentum = 3;
    } else {
      momentum = 8;
    }

    // VWAP-deviation-driven alignment score
    let vwapTrendAlignment: number;
    if (indicators.vwap !== null && indicators.vwap > 0) {
      const vwapDev = (snapshot.ltp - indicators.vwap) / indicators.vwap;
      if (vwapDev >= 0.005) vwapTrendAlignment = 15;
      else if (vwapDev >= 0) vwapTrendAlignment = 12;
      else if (vwapDev >= -0.005) vwapTrendAlignment = 9;
      else vwapTrendAlignment = 6;
    } else {
      vwapTrendAlignment = 8;
    }

    let optionsFuturesConfirmation = 8;
    if (snapshot.bidPrice !== null && snapshot.askPrice !== null && snapshot.bidPrice > 0) {
      const spreadPct = (snapshot.askPrice! - snapshot.bidPrice) / snapshot.ltp;
      optionsFuturesConfirmation = spreadPct < 0.05 ? 12 : spreadPct < 0.1 ? 10 : 8;
    }

    let liquidityExecution = 8;
    if (snapshot.bidPrice !== null && snapshot.askPrice !== null) {
      const spreadPct = (snapshot.askPrice! - snapshot.bidPrice) / snapshot.ltp;
      liquidityExecution = spreadPct < 0.01 ? 10 : spreadPct < 0.05 ? 9 : 8;
    }

    const rrQuality = rrRatio >= 2.0 ? 10 : rrRatio >= 1.5 ? 8 : 5;

    return {
      regimeAlignment,
      priceStructure,
      volumeConfirmation,
      momentum,
      vwapTrendAlignment,
      optionsFuturesConfirmation,
      liquidityExecution,
      rrQuality,
    };
  }

  private getSessionOpenUtc(): Date {
    const nowUtc = new Date();
    const nowIstMs = nowUtc.getTime() + IST_OFFSET_MS;
    const istDate = new Date(nowIstMs);
    const sessionOpenUtcMs =
      Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate()) -
      IST_OFFSET_MS +
      (9 * 60 + 15) * 60 * 1000;
    return new Date(sessionOpenUtcMs);
  }
}
