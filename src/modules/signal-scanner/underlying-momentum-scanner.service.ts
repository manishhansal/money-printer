/**
 * underlying-momentum-scanner.service.ts
 *
 * UnderlyingMomentumScannerService — the new underlying-first momentum scanner.
 *
 * # Architecture (corrects ARCH-001)
 *
 * The existing SignalScannerService scans Redis for mkt:snapshot:* keys that
 * include OPTION instruments, then applies option-specific filters (strike,
 * premium RSI) to decide direction. This is fundamentally backwards.
 *
 * This service inverts the pipeline:
 *
 *   1. Load eligible UNDERLYING instruments (indices + F&O stocks) from DB.
 *   2. For each underlying, load its current market snapshot from Redis.
 *   3. Load multi-timeframe candles (1m, 5m, 15m, 1d) from historical_candles.
 *   4. Compute ALL required indicators on the UNDERLYING.
 *   5. Evaluate each active strategy's entry conditions on the UNDERLYING.
 *   6. Build a ranked list of bullish and bearish candidates.
 *   7. For each top candidate, look up the appropriate option contract.
 *   8. Validate option liquidity.
 *   9. Dispatch qualified signals to StrategyService for scoring.
 *
 * # Relationship to existing SignalScannerService
 *
 * This service runs alongside the existing scanner (which continues to operate
 * on option snapshots for backward compatibility). The new scanner is registered
 * on a separate cron schedule and feeds the same downstream pipeline
 * (StrategyService → SignalScoringService → PipelineWiringService).
 *
 * Over time, this service should replace the existing one once validated.
 *
 * # Multi-timeframe alignment
 *
 * Signals are only generated when at least TWO timeframes agree on direction:
 *   - 1m: entry timing
 *   - 5m: primary momentum confirmation
 *   - 15m: trend structure confirmation
 *   - 1d: broader context
 *
 * Requirements: Phase 3 — Momentum Strategy Implementation
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';

import { RedisService } from '../redis/redis.service';
import { TechnicalAnalysisService } from '../technical-analysis/technical-analysis.service';
import { CandleQueryService } from '../market-data/candle-query.service';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { ExpiryManagementService } from '../instrument-discovery/expiry-management.service';
import { StrategyEntryConditionsService } from './strategy-entry-conditions.service';
import { StrategyService } from '../strategy/strategy.service';
import { MarketRegimeService } from '../market-regime/market-regime.service';

import { Instruments } from '../../database/entities/instruments.entity';
import { SessionPhase } from '../session-manager/session-manager.types';
import { MarketRegime } from '../market-regime/market-regime.types';
import { SignalCandidateInput } from '../strategy/strategy.types';
import { SignalComponentScores } from '../signal-scoring/signal-scoring.types';
import { OHLCV } from '../technical-analysis/technical-analysis.types';
import {
  UnderlyingIndicators,
  EntryConditionResult,
  MomentumDirection,
} from './strategy-entry-conditions.service';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** IST offset in milliseconds (UTC+05:30). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000;

/** Session phases where this scanner is allowed to run. */
const SCANNABLE_PHASES = new Set<SessionPhase>([
  SessionPhase.ORB_FORMATION,
  SessionPhase.MORNING_MOMENTUM,
  SessionPhase.MID_SESSION,
  SessionPhase.AFTERNOON,
  SessionPhase.AFTERNOON_LATE,
]);

/** Market regimes where trading is completely suspended (no signals). */
const BLOCKED_REGIMES = new Set<MarketRegime>([MarketRegime.UNSTABLE]);

/** Default stop-loss distance: 1.5% of underlying option premium. */
const SL_PCT = 0.015;

/** Default target: 3% (2:1 R:R minimum). */
const TARGET_PCT = 0.03;

/** Minimum candles required at 1m granularity before scanning. */
const MIN_CANDLES_1M = 20;

/** Minimum candles required at 5m granularity for confirmation. */
const MIN_CANDLES_5M = 10;

/** Maximum age of a Redis snapshot before it's considered stale (ms). */
const MAX_SNAPSHOT_AGE_MS = 30_000;

/** Index underlying security IDs (Dhan standard). */
const INDEX_SECURITY_IDS: Record<string, string> = {
  NIFTY: '13',
  BANKNIFTY: '25',
  FINNIFTY: '27',
  MIDCPNIFTY: '442',
};

// ─────────────────────────────────────────────────────────────────────────────
// Local types
// ─────────────────────────────────────────────────────────────────────────────

interface SnapshotData {
  ltp: number;
  bidPrice: number | null;
  askPrice: number | null;
  volume: number;
  snapshotTs: number;
}

/** A ranked momentum candidate from the underlying scan. */
export interface MomentumCandidate {
  instrumentId: string;
  securityId: string;
  symbol: string;
  instrumentType: string;
  direction: MomentumDirection;
  currentPrice: number;
  score: number;
  strategyCode: string;
  strategyReason: string;
  indicators: UnderlyingIndicators;
  /** Whether the multi-timeframe confirmation passed. */
  multiTfConfirmed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class UnderlyingMomentumScannerService {
  private readonly logger = new Logger(UnderlyingMomentumScannerService.name);

  /** NIFTY 1m candle cache for relative-strength calculation. */
  private niftyCandles1m: OHLCV[] = [];

  constructor(
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
    private readonly redisService: RedisService,
    private readonly taService: TechnicalAnalysisService,
    private readonly candleQueryService: CandleQueryService,
    private readonly sessionManager: SessionManagerService,
    private readonly expiryManager: ExpiryManagementService,
    private readonly entryConditions: StrategyEntryConditionsService,
    private readonly strategyService: StrategyService,
    private readonly marketRegimeService: MarketRegimeService,
  ) {}

  // ─── Cron: scan every 3 minutes, Mon–Fri ───────────────────────────────────

  /**
   * Main scan cycle — runs every 3 minutes (offset from existing 2-min scanner).
   * Uses underlying-first evaluation: assess the underlying, then select option.
   */
  @Cron('1-59/3 * * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scanUnderlyings(): Promise<void> {
    const phase = this.sessionManager.getCurrentPhase();
    if (!SCANNABLE_PHASES.has(phase)) {
      this.logger.debug(`[UnderlScanner] Skipping — phase=${phase}`);
      return;
    }

    const regime = this.marketRegimeService.getCurrentRegime();
    if (BLOCKED_REGIMES.has(regime as MarketRegime)) {
      this.logger.debug(`[UnderlScanner] Skipping — blocked regime=${regime}`);
      return;
    }

    this.logger.log(`[UnderlScanner] Starting underlying scan — regime=${regime} phase=${phase}`);

    // Load eligible underlyings from DB
    const underlyings = await this.loadEligibleUnderlyings();
    if (underlyings.length === 0) {
      this.logger.warn('[UnderlScanner] No eligible underlying instruments found in DB');
      return;
    }

    // Pre-load NIFTY candles for relative-strength computation
    await this.refreshNiftyCandles();

    const candidates: MomentumCandidate[] = [];
    let scanned = 0;
    let skippedNoData = 0;
    let skippedInsufficientCandles = 0;

    for (const instrument of underlyings) {
      const snapshot = await this.loadSnapshot(instrument.securityId);
      if (!snapshot) {
        skippedNoData++;
        continue;
      }

      if (this.isSnapshotStale(snapshot)) {
        skippedNoData++;
        continue;
      }

      // Load multi-timeframe candles for the underlying
      const candles = await this.candleQueryService.getMultiTimeframeCandles(instrument.id);

      if (candles['1m'].length < MIN_CANDLES_1M || candles['5m'].length < MIN_CANDLES_5M) {
        skippedInsufficientCandles++;
        this.logger.debug(
          `[UnderlScanner] Skipping ${instrument.tradingSymbol} — insufficient candles ` +
            `(1m=${candles['1m'].length} 5m=${candles['5m'].length})`,
        );
        continue;
      }

      // Compute all required indicators on the UNDERLYING
      const indicators = await this.computeIndicators(instrument, snapshot, candles);

      // Evaluate each strategy's entry conditions
      const strategyResults = this.evaluateAllStrategies(indicators, candles['1m']);

      for (const result of strategyResults) {
        if (!result.met || !result.direction) continue;

        // Multi-timeframe confirmation: 5m must agree with 1m direction
        const mtfConfirmed = this.checkMultiTimeframeConfirmation(
          candles,
          result.direction,
          indicators,
        );

        const score = this.scoreCandidate(indicators, result, mtfConfirmed);

        candidates.push({
          instrumentId: instrument.id,
          securityId: instrument.securityId,
          symbol: instrument.underlying,
          instrumentType: instrument.instrumentType,
          direction: result.direction,
          currentPrice: snapshot.ltp,
          score,
          strategyCode: result.strategyCode,
          strategyReason: result.reason,
          indicators,
          multiTfConfirmed: mtfConfirmed,
        });
      }

      scanned++;
    }

    // Sort candidates by score (highest first)
    candidates.sort((a, b) => b.score - a.score);

    this.logger.log(
      `[UnderlScanner] Complete — scanned=${scanned} candidates=${candidates.length} ` +
        `skippedNoData=${skippedNoData} skippedCandles=${skippedInsufficientCandles}`,
    );

    if (candidates.length === 0) {
      this.logger.log('[UnderlScanner] No momentum candidates found — no trade today');
      return;
    }

    // Dispatch top-ranked candidates (up to 3) to strategy evaluation
    const topCandidates = candidates.slice(0, 3);
    for (const candidate of topCandidates) {
      if (!candidate.multiTfConfirmed) {
        this.logger.debug(
          `[UnderlScanner] Skipping ${candidate.symbol} ${candidate.direction} — no MTF confirmation`,
        );
        continue;
      }
      await this.dispatchCandidate(candidate, regime);
    }
  }

  /**
   * On-demand scan triggered by debug events.
   */
  @OnEvent('debug.trigger_underlying_scan')
  async onDebugScan(): Promise<void> {
    this.logger.log('[UnderlScanner] On-demand scan triggered');
    await this.scanUnderlyings();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: data loading
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load all eligible underlying instruments from the DB.
   * Includes: INDEX type (for regime/direction) and optionally
   * active F&O stocks (via their underlying symbol).
   */
  private async loadEligibleUnderlyings(): Promise<Instruments[]> {
    try {
      // Load INDEX instruments (NIFTY, BANKNIFTY, etc.) and F&O underlyings
      const instruments = await this.instrumentsRepo.find({
        where: { isActive: true, isTradable: true },
        select: ['id', 'securityId', 'tradingSymbol', 'underlying', 'instrumentType', 'expiryDate'],
        order: { liquidityScore: 'DESC' },
        take: 50,
      });

      // Filter to only underlying instruments (INDEX type) for now.
      // F&O stocks can be added when their spot prices are available in Redis.
      return instruments.filter(
        (i) => i.instrumentType === 'INDEX' || this.isUnderlyingStockSymbol(i),
      );
    } catch (err) {
      this.logger.error(`[UnderlScanner] Failed to load underlyings: ${(err as Error).message}`);
      return [];
    }
  }

  private isUnderlyingStockSymbol(instrument: Instruments): boolean {
    // Underlyings are identified by having no expiry date and being F&O eligible
    return instrument.expiryDate === null && instrument.instrumentType === 'INDEX';
  }

  private async loadSnapshot(securityId: string): Promise<SnapshotData | null> {
    try {
      const raw = await this.redisService.get(`mkt:snapshot:${securityId}`);
      if (!raw) return null;
      const snap = JSON.parse(raw) as {
        ltp: string;
        bidPrice?: string;
        askPrice?: string;
        volume?: string;
        ts?: number;
      };
      const ltp = parseFloat(snap.ltp);
      if (!ltp || ltp <= 0) return null;
      return {
        ltp,
        bidPrice: snap.bidPrice ? parseFloat(snap.bidPrice) : null,
        askPrice: snap.askPrice ? parseFloat(snap.askPrice) : null,
        volume: parseInt(snap.volume ?? '0', 10),
        snapshotTs: snap.ts ?? Date.now(),
      };
    } catch {
      return null;
    }
  }

  private isSnapshotStale(snapshot: SnapshotData): boolean {
    return Date.now() - snapshot.snapshotTs > MAX_SNAPSHOT_AGE_MS;
  }

  private async refreshNiftyCandles(): Promise<void> {
    // Look up NIFTY instrument by securityId
    try {
      const niftyInstr = await this.instrumentsRepo.findOne({
        where: { securityId: INDEX_SECURITY_IDS.NIFTY, isActive: true },
        select: ['id'],
      });
      if (niftyInstr) {
        this.niftyCandles1m = await this.candleQueryService.getRecentCandles(
          niftyInstr.id,
          '1m',
          60,
        );
      }
    } catch {
      // Non-fatal — relative strength won't be available
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: indicator computation
  // ─────────────────────────────────────────────────────────────────────────

  private async computeIndicators(
    instrument: Instruments,
    snapshot: SnapshotData,
    candles: Record<string, OHLCV[]>,
  ): Promise<UnderlyingIndicators> {
    const c1m = candles['1m'];
    const c5m = candles['5m'];

    const sessionStart = this.getSessionStart();

    // Core indicators (from 1m candles)
    const vwap = this.taService.computeVWAP(c1m);
    const rsi = this.taService.computeRSI(c1m);
    const atr = this.taService.computeATR(c1m);
    const ema9 = this.taService.computeEMA(c1m, 9);
    const ema21 = this.taService.computeEMA(c1m, 21);
    const ema50 = this.taService.computeEMA50(c1m);
    const macd = this.taService.computeMACD(c1m);
    const adx = this.taService.computeADX(c1m);
    const roc = this.taService.computeROC(c1m)?.roc ?? null;
    const relVol = this.taService.computeRelativeVolume(c1m, 5);
    const orb = this.taService.computeORBRange(c1m, sessionStart, 15);

    // 5m indicators for multi-TF confirmation
    const rsi5m = c5m.length >= 15 ? this.taService.computeRSI(c5m) : null;
    void rsi5m; // used by checkMultiTimeframeConfirmation via 5m candles directly

    // Previous day levels
    const prevDayLevels = await this.candleQueryService.getPreviousDayHighLow(instrument.id);

    // Relative strength (stock vs NIFTY)
    let relativeStrengthVsNifty: number | null = null;
    if (this.niftyCandles1m.length >= 16 && c1m.length >= 16) {
      relativeStrengthVsNifty = this.taService.computeRelativeStrength(
        c1m,
        this.niftyCandles1m,
        15,
      );
    }

    return {
      vwap,
      ema9,
      ema21,
      ema50,
      rsi,
      macd,
      adx,
      atr,
      relVol,
      roc,
      orb,
      prevDayHigh: prevDayLevels?.high ?? null,
      prevDayLow: prevDayLevels?.low ?? null,
      currentPrice: snapshot.ltp,
      relativeStrengthVsNifty,
      candleCount1m: c1m.length,
      candleCount5m: c5m.length,
    };
  }

  /** Returns today's session start time (09:15 IST) as a UTC Date. */
  private getSessionStart(): Date {
    const nowIstMs = Date.now() + IST_OFFSET_MS;
    const istDate = new Date(nowIstMs);
    // Session starts at 09:15 IST = 03:45 UTC
    return new Date(
      Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate(), 3, 45, 0),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: strategy evaluation
  // ─────────────────────────────────────────────────────────────────────────

  private evaluateAllStrategies(
    indicators: UnderlyingIndicators,
    candles1m: OHLCV[],
  ): EntryConditionResult[] {
    return [
      this.entryConditions.evaluateORB(indicators, candles1m),
      this.entryConditions.evaluateVWAPReclaim(indicators, candles1m),
      this.entryConditions.evaluateMomentumExpansion(indicators),
      this.entryConditions.evaluateBreakoutRetest(indicators, candles1m),
      this.entryConditions.evaluateRelativeStrength(indicators),
      this.entryConditions.evaluateTrendContinuation(indicators, candles1m),
    ].filter((r) => r.met);
  }

  /**
   * Check multi-timeframe confirmation.
   * Requires that the 5m timeframe agrees with the 1m direction signal.
   *
   * Bullish confirmation: 5m RSI > 50 AND 5m price > 5m VWAP.
   * Bearish confirmation: 5m RSI < 50 AND 5m price < 5m VWAP.
   */
  private checkMultiTimeframeConfirmation(
    candles: Record<string, OHLCV[]>,
    direction: MomentumDirection,
    indicators: UnderlyingIndicators,
  ): boolean {
    const c5m = candles['5m'];
    if (c5m.length < 15) return false; // insufficient 5m data — skip confirmation

    const rsi5m = this.taService.computeRSI(c5m);
    const vwap5m = this.taService.computeVWAP(c5m);
    const lastClose5m = c5m[c5m.length - 1].close;

    if (direction === 'BULLISH') {
      return (
        (rsi5m === null || rsi5m > 50) &&
        (vwap5m === null || lastClose5m > vwap5m) &&
        (indicators.ema9 === null ||
          indicators.ema21 === null ||
          indicators.ema9 >= indicators.ema21)
      );
    } else {
      return (
        (rsi5m === null || rsi5m < 50) &&
        (vwap5m === null || lastClose5m < vwap5m) &&
        (indicators.ema9 === null ||
          indicators.ema21 === null ||
          indicators.ema9 <= indicators.ema21)
      );
    }
  }

  /**
   * Score a candidate (0–100) based on indicator quality.
   * Higher score = stronger, more confirmed opportunity.
   */
  private scoreCandidate(
    indicators: UnderlyingIndicators,
    result: EntryConditionResult,
    mtfConfirmed: boolean,
  ): number {
    let score = 0;

    // Multi-TF confirmation: +20 points
    if (mtfConfirmed) score += 20;

    // RSI alignment: +15 points
    const rsi = indicators.rsi;
    if (rsi !== null) {
      if (result.direction === 'BULLISH' && rsi >= 60) score += 15;
      else if (result.direction === 'BULLISH' && rsi >= 55) score += 10;
      else if (result.direction === 'BEARISH' && rsi <= 40) score += 15;
      else if (result.direction === 'BEARISH' && rsi <= 45) score += 10;
    }

    // Relative volume: +15 points
    const rv = indicators.relVol;
    if (rv !== null) {
      if (rv >= 1.5) score += 15;
      else if (rv >= 1.2) score += 10;
      else if (rv >= 1.0) score += 5;
    }

    // ADX trend strength: +15 points
    const adx = indicators.adx;
    if (adx !== null) {
      if (adx.adx >= 30) score += 15;
      else if (adx.adx >= 20) score += 10;
      else if (adx.adx >= 15) score += 5;
    }

    // MACD alignment: +10 points
    const macd = indicators.macd;
    if (macd !== null) {
      const histPositive = result.direction === 'BULLISH' ? macd.histogram > 0 : macd.histogram < 0;
      if (histPositive) score += 10;
    }

    // VWAP alignment: +10 points
    const vwap = indicators.vwap;
    if (vwap !== null) {
      const priceAbove = indicators.currentPrice > vwap;
      if (result.direction === 'BULLISH' && priceAbove) score += 10;
      else if (result.direction === 'BEARISH' && !priceAbove) score += 10;
    }

    // Relative strength (stocks): +15 points
    const rs = indicators.relativeStrengthVsNifty;
    if (rs !== null) {
      if (result.direction === 'BULLISH' && rs >= 1.0) score += 15;
      else if (result.direction === 'BULLISH' && rs >= 0.5) score += 10;
      else if (result.direction === 'BEARISH' && rs <= -1.0) score += 15;
      else if (result.direction === 'BEARISH' && rs <= -0.5) score += 10;
    }

    return Math.min(100, score);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: signal dispatch
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Look up the appropriate option contract for the candidate and dispatch
   * a signal to StrategyService for scoring.
   *
   * Currently uses the nearest ATM option in the instruments table.
   * TODO: integrate ExpiryManagementService for expiry-aware selection.
   */
  private async dispatchCandidate(candidate: MomentumCandidate, regime: string): Promise<void> {
    const optionType = candidate.direction === 'BULLISH' ? 'CE' : 'PE';
    const isIndex = candidate.instrumentType === 'INDEX';

    // Validate expiry
    const expiryInfo = isIndex
      ? await this.expiryManager.getCurrentWeeklyExpiry(candidate.symbol, true)
      : await this.expiryManager.getCurrentMonthlyExpiry(candidate.symbol, false);

    if (!expiryInfo) {
      this.logger.warn(
        `[UnderlScanner] No valid ${isIndex ? 'weekly' : 'monthly'} expiry for ${candidate.symbol} — skipping`,
      );
      return;
    }

    if (this.expiryManager.isContractExpired(expiryInfo.date)) {
      this.logger.warn(
        `[UnderlScanner] Expiry ${expiryInfo.date} for ${candidate.symbol} has expired — skipping`,
      );
      return;
    }

    // Look up ATM/near-ATM option contract in the instruments table
    const optionInstrument = await this.findNearestOptionContract(
      candidate.symbol,
      candidate.currentPrice,
      optionType,
      expiryInfo.date,
    );

    if (!optionInstrument) {
      this.logger.debug(
        `[UnderlScanner] No ${optionType} option found for ${candidate.symbol} at ${candidate.currentPrice.toFixed(0)} expiry=${expiryInfo.date}`,
      );
      return;
    }

    // Verify option has a live snapshot
    const optionSnapshot = await this.loadSnapshot(optionInstrument.securityId);
    if (!optionSnapshot || optionSnapshot.ltp < 10) {
      this.logger.debug(
        `[UnderlScanner] Option ${optionInstrument.tradingSymbol} has no live price or LTP < ₹10`,
      );
      return;
    }

    // Build signal candidate using option prices but UNDERLYING indicators
    const entryPrice = optionSnapshot.askPrice ?? optionSnapshot.ltp;
    const stopLoss = entryPrice * (1 - SL_PCT);
    const target = entryPrice * (1 + TARGET_PCT);

    const signalInput: SignalCandidateInput = {
      instrumentId: optionInstrument.id,
      currentRegime: regime,
      engine: 'PAPER',
      direction: 'BUY',
      entryPrice: entryPrice.toFixed(2),
      stopLossPrice: stopLoss.toFixed(2),
      targetPrice: target.toFixed(2),
      positionSize: 1,
      entryConditionsMet: true,
      componentScores: this.buildComponentScores(candidate, optionSnapshot),
      measuredInputs: {
        securityId: optionInstrument.securityId,
        underlyingSymbol: candidate.symbol,
        underlyingSecurityId: candidate.securityId,
        underlyingPrice: candidate.currentPrice,
        strategyCode: candidate.strategyCode,
        strategyReason: candidate.strategyReason,
        momentumScore: candidate.score,
        multiTfConfirmed: candidate.multiTfConfirmed,
        direction: candidate.direction,
        expiryDate: expiryInfo.date,
        optionType,
        // Core indicator snapshot
        vwap: candidate.indicators.vwap,
        rsi: candidate.indicators.rsi,
        adx: candidate.indicators.adx?.adx,
        plusDI: candidate.indicators.adx?.plusDI,
        minusDI: candidate.indicators.adx?.minusDI,
        macdHistogram: candidate.indicators.macd?.histogram,
        atr: candidate.indicators.atr,
        relVol: candidate.indicators.relVol,
        roc: candidate.indicators.roc,
        relativeStrengthVsNifty: candidate.indicators.relativeStrengthVsNifty,
        orbHigh: candidate.indicators.orb?.orbHigh,
        orbLow: candidate.indicators.orb?.orbLow,
        prevDayHigh: candidate.indicators.prevDayHigh,
        prevDayLow: candidate.indicators.prevDayLow,
      },
      isOpeningPhase:
        this.sessionManager.getCurrentPhase() === SessionPhase.ORB_FORMATION ||
        this.sessionManager.getCurrentPhase() === SessionPhase.MORNING_MOMENTUM,
    };

    this.logger.log(
      `[UnderlScanner] Dispatching ${candidate.symbol} ${candidate.direction} → ` +
        `${optionInstrument.tradingSymbol} LTP=₹${optionSnapshot.ltp.toFixed(2)} ` +
        `score=${candidate.score} strategy=${candidate.strategyCode}`,
    );

    try {
      await this.strategyService.evaluateSignalCandidate(signalInput);
    } catch (err) {
      this.logger.error(
        `[UnderlScanner] evaluateSignalCandidate failed for ${optionInstrument.tradingSymbol}: ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Find the nearest ATM option contract in the instruments table.
   * Selects the option with strike closest to `spotPrice`.
   */
  private async findNearestOptionContract(
    underlying: string,
    spotPrice: number,
    optionType: 'CE' | 'PE',
    expiryDate: string,
  ): Promise<Instruments | null> {
    try {
      // Load all matching options for this underlying, expiry, and option type
      const options = await this.instrumentsRepo.find({
        where: {
          underlying,
          optionType,
          expiryDate,
          isActive: true,
          isTradable: true,
        },
        select: ['id', 'securityId', 'tradingSymbol', 'strikePrice', 'lotSize'],
      });

      if (options.length === 0) return null;

      // Select the contract with strike closest to spot (ATM)
      let nearest = options[0];
      let minDiff = Math.abs(parseFloat(nearest.strikePrice ?? '0') - spotPrice);

      for (const opt of options) {
        const diff = Math.abs(parseFloat(opt.strikePrice ?? '0') - spotPrice);
        if (diff < minDiff) {
          minDiff = diff;
          nearest = opt;
        }
      }

      // Reject if strike is more than 5% away from spot (not near-ATM)
      if (minDiff / spotPrice > 0.05) {
        this.logger.debug(
          `[UnderlScanner] Nearest ${underlying} ${optionType} strike=${nearest.strikePrice} ` +
            `is ${((minDiff / spotPrice) * 100).toFixed(1)}% from spot=${spotPrice.toFixed(0)} — too far`,
        );
        return null;
      }

      return nearest;
    } catch (err) {
      this.logger.debug(
        `[UnderlScanner] findNearestOptionContract failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Build component scores from underlying indicators + option snapshot.
   * These feed into SignalScoringService's composite score.
   */
  private buildComponentScores(
    candidate: MomentumCandidate,
    optionSnapshot: SnapshotData,
  ): SignalComponentScores {
    const ind = candidate.indicators;

    // Regime alignment: from ADX + RSI strength
    const adxVal = ind.adx?.adx ?? 0;
    const regimeAlignment = adxVal >= 25 ? 15 : adxVal >= 20 ? 12 : adxVal >= 15 ? 9 : 6;

    // Price structure: ORB and prev-day levels
    const hasStructure = ind.orb !== null || ind.prevDayHigh !== null;
    const priceStructure = hasStructure ? (candidate.multiTfConfirmed ? 15 : 12) : 8;

    // Volume confirmation: relative volume
    const rv = ind.relVol ?? 0;
    const volumeConfirmation = rv >= 1.5 ? 15 : rv >= 1.2 ? 12 : rv >= 1.0 ? 9 : 6;

    // Momentum: RSI + MACD
    const rsi = ind.rsi ?? 50;
    const histOk = ind.macd
      ? candidate.direction === 'BULLISH'
        ? ind.macd.histogram > 0
        : ind.macd.histogram < 0
      : false;
    const momentum = (rsi >= 60 || rsi <= 40 ? 7 : 4) + (histOk ? 3 : 0);

    // VWAP trend alignment
    const vwapAligned =
      ind.vwap !== null
        ? candidate.direction === 'BULLISH'
          ? ind.currentPrice > ind.vwap
          : ind.currentPrice < ind.vwap
        : true;
    const vwapTrendAlignment = vwapAligned ? (candidate.multiTfConfirmed ? 10 : 8) : 4;

    // Options/Futures confirmation: bid/ask spread
    const hasOptionLiquidity = optionSnapshot.bidPrice !== null && optionSnapshot.askPrice !== null;
    const spread = hasOptionLiquidity
      ? ((optionSnapshot.askPrice! - optionSnapshot.bidPrice!) / optionSnapshot.ltp) * 100
      : 20;
    const optionsFuturesConfirmation = spread < 2 ? 15 : spread < 5 ? 12 : spread < 10 ? 9 : 6;

    // Liquidity and execution
    const liquidityExecution = spread < 1 ? 10 : spread < 3 ? 8 : 6;

    // R:R quality: fixed 2:1
    const rrQuality = 8; // 2:1 R:R = 2.0, earns 8/10

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
}
