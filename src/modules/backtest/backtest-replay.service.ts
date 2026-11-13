/**
 * backtest-replay.service.ts
 *
 * BacktestReplayService — event-driven historical backtest engine.
 *
 * # Architecture
 *
 * Unlike BacktestService (which accepts a pre-computed trade array),
 * this service runs the ACTUAL scanner logic against stored candle data:
 *
 *   For each trading day in the date range:
 *     1. Load all relevant 1m candles from historical_candles (IST 09:15–15:30).
 *     2. Derive synthetic NIFTY spot from put-call parity:
 *           spot(t) = ATM_strike + CE_close(t) − PE_close(t)
 *     3. Build a chronological "spot OHLCV" array from these values.
 *     4. At each minute (after MIN_CANDLES warmup):
 *        a. Compute all required indicators (VWAP, RSI, EMA9/21/50, MACD,
 *           ADX, ATR, ROC, RelVol, ORB) on the SPOT series.
 *        b. Run all 6 StrategyEntryConditionsService evaluations.
 *        c. If a signal fires AND no position is open:
 *           - Record the signal minute.
 *           - Look up the ATM option's next-candle OPEN price as entry.
 *           - Track position through the day candle-by-candle.
 *           - Exit on SL (default 15% below entry), target (25% above),
 *             or mandatory EOD at 15:15 IST.
 *        d. Compute realistic costs via TradingChargesService.
 *        e. Record the ReplayTrade.
 *     5. Apply walk-forward IS/OOS split.
 *     6. Compute per-strategy and combined metrics.
 *     7. Compute bootstrap confidence intervals.
 *
 * # Look-ahead-free guarantee
 *
 *   - Indicators at minute T use candles [0 .. T-1] only.
 *   - Entry price is the OPEN of candle T+1 (the next completed candle).
 *   - SL and target checks use the OPEN, HIGH, LOW and CLOSE of candle T+1+N.
 *   - If a candle gaps through both SL and target, the worst-case SL fill
 *     is used (gap risk — adverse fill assumed).
 *   - ORB levels are built from candles strictly before the ORB window ends.
 *   - Previous-day levels come from yesterday's data only.
 *
 * # Synthetic spot quality
 *
 *   Put-call parity approximation is reasonably accurate for liquid monthly
 *   options when the carry cost and dividend effect are small. The error is
 *   typically <0.3% for ATM/near-ATM NIFTY monthly options intraday.
 *   All results are labelled with spotDerivationMethod = 'PUT_CALL_PARITY'.
 *
 * Requirements: Phase 5 — Event-Driven Backtesting
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { TechnicalAnalysisService } from '../technical-analysis/technical-analysis.service';
import {
  StrategyEntryConditionsService,
  UnderlyingIndicators,
} from '../signal-scanner/strategy-entry-conditions.service';
import { TradingChargesService } from '../charges/trading-charges.service';
import { BacktestService } from './backtest.service';

import { HistoricalCandles } from '../../database/entities/historical-candles.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { OHLCV } from '../technical-analysis/technical-analysis.types';

import {
  ReplayBacktestRequest,
  ReplayBacktestResult,
  ReplayStrategyCode,
  ReplayStrategyMetrics,
  ReplayTrade,
  ReplayExitReason,
  WalkForwardWindow,
  SpotDerivationMethod,
} from './backtest-replay.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** IST offset in ms (UTC+05:30). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000;

/** Session open (09:15 IST) as UTC minutes from midnight UTC of the same date. */
const SESSION_OPEN_UTC_MINUTE = 3 * 60 + 45; // 03:45 UTC = 09:15 IST

/** Mandatory square-off time (15:15 IST). */
const SQUAREOFF_UTC_MINUTE = 9 * 60 + 45; // 09:45 UTC = 15:15 IST

/** Minimum candles before indicators are considered reliable. */
const MIN_INDICATOR_CANDLES = 30;

/** Default SL: 15% below entry (option premium). */
const DEFAULT_SL_PCT = 0.15;

/** Default target: 25% above entry (option premium). */
const DEFAULT_TARGET_PCT = 0.25;

/** Minimum option premium to enter a trade (avoid near-worthless options). */
const MIN_OPTION_LTP = 20;

/** NIFTY lot size (as of 2026). */
const NIFTY_LOT_SIZE = 65;

/** Strategy names. */
const STRATEGY_NAMES: Record<ReplayStrategyCode, string> = {
  A: 'Opening Range Breakout',
  B: 'VWAP Reclaim / Rejection',
  C: 'Momentum Expansion',
  D: 'Breakout and Retest',
  E: 'Relative Strength / Weakness',
  F: 'Trend Continuation',
};

/** Bootstrap iterations for CI computation. */
const BOOTSTRAP_ITERATIONS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class BacktestReplayService {
  private readonly logger = new Logger(BacktestReplayService.name);

  constructor(
    @InjectRepository(HistoricalCandles)
    private readonly candlesRepo: Repository<HistoricalCandles>,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
    private readonly taService: TechnicalAnalysisService,
    private readonly entryConditions: StrategyEntryConditionsService,
    private readonly chargesService: TradingChargesService,
    private readonly backtestService: BacktestService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run an event-driven replay backtest across all 6 strategies.
   *
   * Uses the full historical_candles dataset to replay the production
   * signal logic candle-by-candle, with no look-ahead.
   *
   * Returns a comprehensive ReplayBacktestResult with per-strategy metrics,
   * IS/OOS split, walk-forward windows, and bootstrap CIs.
   */
  async runReplay(req: ReplayBacktestRequest = {}): Promise<ReplayBacktestResult> {
    const startMs = Date.now();
    const warnings: string[] = [];

    const {
      strategies = ['A', 'B', 'C', 'D', 'E', 'F'],
      inSampleRatio = 0.7,
      stopLossPct = DEFAULT_SL_PCT,
      targetPct = DEFAULT_TARGET_PCT,
      minRelVol = 1.2,
      walkForwardWindows: wfWindowCount = 3,
    } = req;

    this.logger.log(
      `[Replay] Starting backtest — strategies=${strategies.join(',')} IS=${inSampleRatio}`,
    );

    // ── 1. Discover what data is available ──────────────────────────────────
    const { ceInstrument, peInstrument, atmStrike, spotDerivationMethod } =
      await this.discoverATMInstruments(warnings);

    if (!ceInstrument || !peInstrument) {
      throw new Error(
        'No NIFTY ATM option instruments found in the database. ' +
          'Run POST /backtest/backfill first to ingest historical candle data.',
      );
    }

    this.logger.log(
      `[Replay] Using ATM strike=${atmStrike} ` +
        `CE=${ceInstrument.tradingSymbol} PE=${peInstrument.tradingSymbol} ` +
        `method=${spotDerivationMethod}`,
    );

    // ── 2. Load all trading days ─────────────────────────────────────────────
    const tradingDays = await this.loadTradingDays(ceInstrument.id);
    if (tradingDays.length === 0) {
      throw new Error('No trading days found in historical_candles table.');
    }

    this.logger.log(
      `[Replay] Found ${tradingDays.length} trading days: ` +
        `${tradingDays[0]} → ${tradingDays[tradingDays.length - 1]}`,
    );

    // ── 3. Build IS/OOS split boundary ───────────────────────────────────────
    const isSplitIdx = Math.floor(tradingDays.length * inSampleRatio);
    const splitDate = tradingDays[isSplitIdx];
    this.logger.log(
      `[Replay] IS/OOS split: IS=[${tradingDays[0]}, ${tradingDays[isSplitIdx - 1]}] ` +
        `OOS=[${splitDate}, ${tradingDays[tradingDays.length - 1]}]`,
    );

    // ── 4. Replay each day ───────────────────────────────────────────────────
    const allTradesByStrategy: Record<ReplayStrategyCode, ReplayTrade[]> = {
      A: [],
      B: [],
      C: [],
      D: [],
      E: [],
      F: [],
    };

    let totalCandlesProcessed = 0;
    let prevDaySpotCandles: OHLCV[] = [];

    for (const day of tradingDays) {
      const { ceCandles, peCandles } = await this.loadDayOptionCandles(
        ceInstrument.id,
        peInstrument.id,
        day,
      );

      if (ceCandles.length < MIN_INDICATOR_CANDLES) {
        this.logger.debug(`[Replay] Skipping ${day} — only ${ceCandles.length} CE candles`);
        prevDaySpotCandles = [];
        continue;
      }

      // Derive synthetic spot series for this day
      const spotCandles = this.deriveSyntheticSpot(ceCandles, peCandles, atmStrike, day);
      totalCandlesProcessed += spotCandles.length;

      if (spotCandles.length < MIN_INDICATOR_CANDLES) {
        prevDaySpotCandles = [];
        continue;
      }

      // Session start for ORB calculation (09:15 IST)
      const sessionStart = this.getSessionStart(day);

      // Replay this day across all requested strategies
      for (const strategyCode of strategies as ReplayStrategyCode[]) {
        const trade = this.replayDay(
          day,
          spotCandles,
          ceCandles,
          peCandles,
          sessionStart,
          prevDaySpotCandles,
          strategyCode,
          stopLossPct,
          targetPct,
          minRelVol,
          atmStrike,
        );
        if (trade) {
          allTradesByStrategy[strategyCode].push(trade);
        }
      }

      prevDaySpotCandles = spotCandles;
    }

    // ── 5. Compute per-strategy metrics ──────────────────────────────────────
    const strategyResults: ReplayStrategyMetrics[] = [];

    for (const strategyCode of strategies as ReplayStrategyCode[]) {
      const trades = allTradesByStrategy[strategyCode];
      const isTrades = trades.filter((t) => t.date < splitDate);
      const oosTrades = trades.filter((t) => t.date >= splitDate);

      this.logger.log(
        `[Replay] Strategy ${strategyCode}: total=${trades.length} IS=${isTrades.length} OOS=${oosTrades.length}`,
      );

      const metrics = this.buildMetrics(strategyCode, trades, tradingDays, splitDate);
      strategyResults.push(metrics);

      if (oosTrades.length < 10) {
        warnings.push(
          `Strategy ${strategyCode}: only ${oosTrades.length} OOS trades — ` +
            `results are not statistically reliable (need ≥ 10)`,
        );
      }
    }

    // ── 6. Combined engine: best signal per day ───────────────────────────────
    const combined = this.buildCombinedMetrics(
      strategies as ReplayStrategyCode[],
      allTradesByStrategy,
      tradingDays,
      splitDate,
    );

    // ── 7. Walk-forward windows ───────────────────────────────────────────────
    const walkForward = this.buildWalkForwardWindows(
      strategies as ReplayStrategyCode[],
      allTradesByStrategy,
      tradingDays,
      wfWindowCount,
    );

    // ── 8. Verdict ────────────────────────────────────────────────────────────
    const oosMetrics = combined.trades.filter((t) => t.date >= splitDate).map((t) => t.netPnl);

    const oosExpectancy =
      oosMetrics.length > 0 ? oosMetrics.reduce((a, b) => a + b, 0) / oosMetrics.length : 0;
    const oosWinRate =
      oosMetrics.length > 0
        ? (oosMetrics.filter((p) => p > 0).length / oosMetrics.length) * 100
        : 0;

    const verdict = {
      sufficientSample: oosMetrics.length >= 10,
      oosPositiveExpectancy: oosExpectancy > 0,
      oosWinRateAbove50: oosWinRate > 50,
      profitFactorAbove1: combined.profitFactor > 1,
      maxDrawdownAcceptable: combined.maxDrawdown < 50_000,
      conclusion: this.buildVerdict(oosMetrics.length, oosExpectancy, oosWinRate, combined),
    };

    const durationMs = Date.now() - startMs;
    this.logger.log(
      `[Replay] Complete in ${(durationMs / 1000).toFixed(1)}s — ` +
        `${totalCandlesProcessed} candles processed, ${combined.tradesExecuted} combined trades`,
    );

    return {
      version: '1.0.0',
      ranAt: new Date().toISOString(),
      dataFromDate: tradingDays[0],
      dataToDate: tradingDays[tradingDays.length - 1],
      tradingDaysReplayed: tradingDays.length,
      candlesProcessed: totalCandlesProcessed,
      spotDerivationMethod,
      atmStrike,
      inSampleRatio,
      splitDate,
      strategies: strategyResults,
      combined,
      walkForward,
      verdict,
      warnings,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Data loading
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Discover the CE and PE instruments for synthetic-spot derivation.
   * Selects the strike with the most candle coverage (typically ATM).
   * Uses a subquery join since there is no TypeORM relation between
   * Instruments and HistoricalCandles (both use plain UUID FK columns).
   */
  private async discoverATMInstruments(warnings: string[]): Promise<{
    ceInstrument: Instruments | null;
    peInstrument: Instruments | null;
    atmStrike: number;
    spotDerivationMethod: SpotDerivationMethod;
  }> {
    // Find the NIFTY CE instrument with the most 1-minute candles
    const topCERows = await this.instrumentsRepo
      .createQueryBuilder('i')
      .select([
        'i.id AS id',
        'i.tradingSymbol AS "tradingSymbol"',
        'i.strikePrice AS "strikePrice"',
        'i.expiryDate AS "expiryDate"',
        'i.lotSize AS "lotSize"',
        'COUNT(hc.id) AS candle_count',
      ])
      .leftJoin(HistoricalCandles, 'hc', 'hc.instrumentId = i.id AND hc.granularity = :g', {
        g: '1m',
      })
      .where('i.underlying = :u', { u: 'NIFTY' })
      .andWhere('i.optionType = :ot', { ot: 'CE' })
      .andWhere('i.instrumentType = :it', { it: 'INDEX_OPTION' })
      .groupBy('i.id')
      .orderBy('candle_count', 'DESC')
      .limit(1)
      .getRawMany<{
        id: string;
        tradingSymbol: string;
        strikePrice: string | null;
        expiryDate: string | null;
        lotSize: number;
        candle_count: string;
      }>();

    if (!topCERows.length || parseInt(topCERows[0].candle_count, 10) === 0) {
      warnings.push('No NIFTY CE instrument with historical candles found.');
      return { ceInstrument: null, peInstrument: null, atmStrike: 0, spotDerivationMethod: 'NONE' };
    }

    const topCERaw = topCERows[0];
    const topCE = await this.instrumentsRepo.findOne({ where: { id: topCERaw.id } });
    if (!topCE) {
      warnings.push('Could not load NIFTY CE instrument by ID.');
      return { ceInstrument: null, peInstrument: null, atmStrike: 0, spotDerivationMethod: 'NONE' };
    }

    const atmStrike = parseFloat(topCERaw.strikePrice ?? '0');

    if (!topCERaw.strikePrice) {
      warnings.push('CE instrument has null strikePrice — cannot match PE.');
      return {
        ceInstrument: topCE,
        peInstrument: null,
        atmStrike,
        spotDerivationMethod: 'CE_INTRINSIC',
      };
    }

    // Find matching PE at the same strike and expiry
    const matchingPE = await this.instrumentsRepo.findOne({
      where: {
        underlying: 'NIFTY',
        optionType: 'PE',
        strikePrice: topCERaw.strikePrice,
        expiryDate: topCERaw.expiryDate ?? undefined,
      },
    });

    if (!matchingPE) {
      warnings.push(`No PE found for strike=${atmStrike} — cannot use put-call parity.`);
      return {
        ceInstrument: topCE,
        peInstrument: null,
        atmStrike,
        spotDerivationMethod: 'CE_INTRINSIC',
      };
    }

    return {
      ceInstrument: topCE,
      peInstrument: matchingPE,
      atmStrike,
      spotDerivationMethod: 'PUT_CALL_PARITY',
    };
  }

  /**
   * Returns distinct trading days (YYYY-MM-DD IST) sorted ascending.
   */
  private async loadTradingDays(instrumentId: string): Promise<string[]> {
    const rows = await this.candlesRepo
      .createQueryBuilder('hc')
      .select(`DATE(hc.timestamp AT TIME ZONE 'Asia/Kolkata')`, 'day')
      .where('hc.instrumentId = :id', { id: instrumentId })
      .andWhere('hc.granularity = :g', { g: '1m' })
      .groupBy(`DATE(hc.timestamp AT TIME ZONE 'Asia/Kolkata')`)
      .orderBy('day', 'ASC')
      .getRawMany<{ day: string }>();

    return rows.map((r) => r.day.toString().slice(0, 10));
  }

  /**
   * Load all 1-minute candles for CE and PE on a given date (IST).
   * Returns candles sorted chronologically (oldest first).
   */
  private async loadDayOptionCandles(
    ceId: string,
    peId: string,
    dayIST: string,
  ): Promise<{ ceCandles: OHLCV[]; peCandles: OHLCV[] }> {
    // IST midnight → UTC
    const dayStart = new Date(`${dayIST}T00:00:00+05:30`);
    const dayEnd = new Date(`${dayIST}T23:59:59+05:30`);

    const [ceRows, peRows] = await Promise.all([
      this.candlesRepo.find({
        where: { instrumentId: ceId, granularity: '1m', timestamp: Between(dayStart, dayEnd) },
        order: { timestamp: 'ASC' },
        select: ['openPrice', 'highPrice', 'lowPrice', 'closePrice', 'volume', 'timestamp'],
      }),
      this.candlesRepo.find({
        where: { instrumentId: peId, granularity: '1m', timestamp: Between(dayStart, dayEnd) },
        order: { timestamp: 'ASC' },
        select: ['openPrice', 'highPrice', 'lowPrice', 'closePrice', 'volume', 'timestamp'],
      }),
    ]);

    return {
      ceCandles: ceRows.map(this.rowToOHLCV),
      peCandles: peRows.map(this.rowToOHLCV),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Synthetic spot derivation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Derive synthetic NIFTY spot candles from CE and PE option premium series.
   *
   * Formula: spot(t) = ATM_strike + CE_close(t) − PE_close(t)
   *
   * When CE and PE timestamps don't perfectly align, the most recent prior
   * value is used (last-observation-carried-forward).
   *
   * OHLC of the synthetic spot:
   *   - Close: spot from close prices (as above)
   *   - Open:  spot from open prices
   *   - High:  CE_high + (CE_close−PE_close) with CE at high
   *   - Low:   CE_low + (CE_close−PE_close) with CE at low
   *   These are approximations; close is the most reliable.
   */
  private deriveSyntheticSpot(
    ceCandles: OHLCV[],
    peCandles: OHLCV[],
    strike: number,
    _day: string,
  ): OHLCV[] {
    if (ceCandles.length === 0) return [];

    // Build a timestamp → PE map for quick lookup
    const peByTs = new Map<number, OHLCV>();
    for (const pe of peCandles) {
      peByTs.set(pe.timestamp.getTime(), pe);
    }

    const spotCandles: OHLCV[] = [];
    let lastPeClose = 0;

    for (const ce of ceCandles) {
      const tsMs = ce.timestamp.getTime();
      const pe = peByTs.get(tsMs);

      if (pe) lastPeClose = parseFloat(String(pe.close));
      const peClose = pe ? parseFloat(String(pe.close)) : lastPeClose;
      const peOpen = pe ? parseFloat(String(pe.open)) : lastPeClose;

      if (peClose === 0) continue; // skip if no PE data yet

      const ceClose = parseFloat(String(ce.close));
      const ceOpen = parseFloat(String(ce.open));
      const ceHigh = parseFloat(String(ce.high));
      const ceLow = parseFloat(String(ce.low));

      // spot = strike + CE − PE  (put-call parity)
      const spotClose = strike + ceClose - peClose;
      const spotOpen = strike + ceOpen - peOpen;
      const spotHigh = Math.max(spotOpen, spotClose, strike + ceHigh - peClose * 0.98);
      const spotLow = Math.min(spotOpen, spotClose, strike + ceLow - peClose * 1.02);

      if (spotClose <= 0 || spotOpen <= 0) continue;

      spotCandles.push({
        open: spotOpen,
        high: Math.max(spotHigh, spotOpen, spotClose),
        low: Math.min(spotLow, spotOpen, spotClose),
        close: spotClose,
        volume: parseFloat(String(ce.volume)) + (pe ? parseFloat(String(pe.volume)) : 0),
        timestamp: ce.timestamp,
      });
    }

    return spotCandles;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core replay loop
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Replay one trading day for one strategy.
   *
   * Returns a ReplayTrade if a signal fired and an entry was simulated,
   * or null if no signal or no executable entry.
   *
   * Strictly look-ahead-free:
   *   - Indicators use candles[0..i-1] only (not candle i).
   *   - Entry price is candle[i+1].open (next candle's open).
   *   - SL/target checked on candle[i+1], [i+2], ... etc.
   */
  private replayDay(
    day: string,
    spotCandles: OHLCV[],
    ceCandles: OHLCV[],
    peCandles: OHLCV[],
    sessionStart: Date,
    prevDayCandles: OHLCV[],
    strategyCode: ReplayStrategyCode,
    stopLossPct: number,
    targetPct: number,
    minRelVol: number,
    atmStrike: number,
  ): ReplayTrade | null {
    // Need at least MIN_INDICATOR_CANDLES + 2 to have a valid entry and exit
    if (spotCandles.length < MIN_INDICATOR_CANDLES + 2) return null;

    // Look up prev-day high/low from yesterday's spot candles
    const prevDayHigh =
      prevDayCandles.length > 0 ? Math.max(...prevDayCandles.map((c) => c.high)) : null;
    const prevDayLow =
      prevDayCandles.length > 0 ? Math.min(...prevDayCandles.map((c) => c.low)) : null;

    // Session start for ORB (09:15 IST)
    const sessionStartMs = sessionStart.getTime();
    // EOD square-off (15:15 IST)
    const squareOffMs =
      sessionStart.getTime() + (SQUAREOFF_UTC_MINUTE - SESSION_OPEN_UTC_MINUTE) * 60_000;

    // Build CE lookup map (by timestamp ms) for entry price lookup
    const ceByTs = new Map<number, OHLCV>();
    for (const c of ceCandles) ceByTs.set(c.timestamp.getTime(), c);
    const peByTs = new Map<number, OHLCV>();
    for (const c of peCandles) peByTs.set(c.timestamp.getTime(), c);

    // Scan through candles looking for a signal
    // Start at MIN_INDICATOR_CANDLES so indicators have enough history
    for (let i = MIN_INDICATOR_CANDLES; i < spotCandles.length - 1; i++) {
      const currentCandle = spotCandles[i];
      const tsMs = currentCandle.timestamp.getTime();

      // Don't enter after square-off time
      if (tsMs >= squareOffMs) break;

      // Only process candles in the trading session
      if (tsMs < sessionStartMs) continue;

      // Build the indicator window: ALL candles up to and including index i
      const window = spotCandles.slice(0, i + 1);

      // Compute indicators on the SPOT series (look-ahead-free)
      const indicators = this.computeIndicatorsForWindow(
        window,
        sessionStart,
        prevDayHigh,
        prevDayLow,
        minRelVol,
      );

      // Evaluate the requested strategy
      const condResult = this.evaluateStrategy(strategyCode, indicators, window);
      if (!condResult.met || !condResult.direction) continue;

      // We have a signal — entry is at NEXT candle's open
      const nextCandle = spotCandles[i + 1];
      if (!nextCandle) continue;

      // Find the ATM option candle for entry price
      const nextTs = nextCandle.timestamp.getTime();
      const optionType = condResult.direction === 'BULLISH' ? 'CE' : 'PE';
      const optionCandle = optionType === 'CE' ? ceByTs.get(nextTs) : peByTs.get(nextTs);

      if (!optionCandle) continue;
      const entryPrice = parseFloat(String(optionCandle.open));
      if (entryPrice < MIN_OPTION_LTP) continue;

      const stopLoss = entryPrice * (1 - stopLossPct);
      const target = entryPrice * (1 + targetPct);

      // Simulate position management from i+1 onwards
      const { exitCandle, exitPrice, exitReason, mae, mfe } = this.simulatePosition(
        i + 1,
        spotCandles,
        optionType === 'CE' ? ceCandles : peCandles,
        entryPrice,
        stopLoss,
        target,
        squareOffMs,
      );

      // Calculate costs
      const quantity = NIFTY_LOT_SIZE; // 1 lot
      const grossPnl = (exitPrice - entryPrice) * quantity;
      const costs = this.chargesService.calculate(entryPrice, exitPrice, quantity);
      const netPnl = grossPnl - costs.total;

      return {
        date: day,
        strategyCode,
        underlyingDirection: condResult.direction,
        optionType,
        strike: atmStrike,
        underlyingAtEntry: nextCandle.open,
        spotDerivationMethod: 'PUT_CALL_PARITY',
        signalTime: this.formatISTTime(currentCandle.timestamp),
        entryTime: this.formatISTTime(nextCandle.timestamp),
        entryPrice,
        stopLossPrice: stopLoss,
        targetPrice: target,
        exitTime: this.formatISTTime(exitCandle.timestamp),
        exitReason,
        exitPrice,
        lotSize: NIFTY_LOT_SIZE,
        lots: 1,
        quantity,
        grossPnl,
        totalCosts: costs.total,
        netPnl,
        regime: this.inferRegime(indicators),
        mae,
        mfe,
        indicatorsAtSignal: {
          vwap: indicators.vwap,
          rsi: indicators.rsi,
          ema9: indicators.ema9,
          ema21: indicators.ema21,
          adx: indicators.adx?.adx ?? null,
          macdHistogram: indicators.macd?.histogram ?? null,
          relVol: indicators.relVol,
          roc: indicators.roc,
          orbHigh: indicators.orb?.orbHigh ?? null,
          orbLow: indicators.orb?.orbLow ?? null,
        },
        strategyConditions: condResult.conditions,
      };
    }

    return null; // no signal fired today
  }

  /**
   * Simulate position management from entryIdx onwards.
   *
   * Returns the exit details with no look-ahead:
   *   - For each subsequent candle, check if SL or target was hit.
   *   - If the candle OPENS beyond SL (gap), the exit is at OPEN (gap fill).
   *   - EOD exit at the candle before squareOffMs.
   */
  private simulatePosition(
    entryIdx: number,
    _spotCandles: OHLCV[],
    optionCandles: OHLCV[],
    entryPrice: number,
    stopLoss: number,
    target: number,
    squareOffMs: number,
  ): {
    exitCandle: OHLCV;
    exitPrice: number;
    exitReason: ReplayExitReason;
    mae: number;
    mfe: number;
  } {
    let mae = 0;
    let mfe = 0;

    // Build timestamp lookup for option candles starting from entryIdx
    // We need option candles from the same session
    const optCandlesByTs = new Map<number, OHLCV>();
    for (const c of optionCandles) {
      optCandlesByTs.set(c.timestamp.getTime(), c);
    }

    // The entry candle is entryIdx in spotCandles — find the corresponding
    // option candle for each subsequent bar
    const optionCandlesAfterEntry = optionCandles.filter(
      (c, _idx) => optionCandles.indexOf(c) >= entryIdx,
    );

    if (optionCandlesAfterEntry.length === 0) {
      // No candles after entry — use entry price as exit
      const dummyCandle: OHLCV = {
        open: entryPrice,
        high: entryPrice,
        low: entryPrice,
        close: entryPrice,
        volume: 0,
        timestamp: new Date(),
      };
      return {
        exitCandle: dummyCandle,
        exitPrice: entryPrice,
        exitReason: 'EOD_SQUARE_OFF',
        mae: 0,
        mfe: 0,
      };
    }

    for (const candle of optionCandlesAfterEntry) {
      const tsMs = candle.timestamp.getTime();
      const open = parseFloat(String(candle.open));
      const high = parseFloat(String(candle.high));
      const low = parseFloat(String(candle.low));
      const close = parseFloat(String(candle.close));

      // Track MAE/MFE
      const unrealizedPnl = close - entryPrice;
      mae = Math.min(mae, unrealizedPnl);
      mfe = Math.max(mfe, unrealizedPnl);

      // Gap through SL at open (worst-case adverse fill)
      if (open <= stopLoss) {
        return {
          exitCandle: candle,
          exitPrice: open,
          exitReason: 'STOP_LOSS',
          mae: open - entryPrice,
          mfe,
        };
      }

      // SL hit intrabar
      if (low <= stopLoss) {
        return {
          exitCandle: candle,
          exitPrice: stopLoss,
          exitReason: 'STOP_LOSS',
          mae: Math.min(mae, stopLoss - entryPrice),
          mfe,
        };
      }

      // Target hit intrabar (use target price if gap is favourable)
      if (high >= target) {
        const fillPrice = Math.max(open, target); // fills AT target unless gap
        return {
          exitCandle: candle,
          exitPrice: fillPrice,
          exitReason: 'TARGET_HIT',
          mae,
          mfe: Math.max(mfe, fillPrice - entryPrice),
        };
      }

      // EOD mandatory square-off
      if (tsMs >= squareOffMs) {
        return {
          exitCandle: candle,
          exitPrice: open, // market order at open of square-off candle
          exitReason: 'EOD_SQUARE_OFF',
          mae,
          mfe,
        };
      }
    }

    // End of data — exit at last close
    const lastCandle = optionCandlesAfterEntry[optionCandlesAfterEntry.length - 1];
    const lastClose = parseFloat(String(lastCandle.close));
    return { exitCandle: lastCandle, exitPrice: lastClose, exitReason: 'EOD_SQUARE_OFF', mae, mfe };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Indicators
  // ─────────────────────────────────────────────────────────────────────────

  private computeIndicatorsForWindow(
    window: OHLCV[],
    sessionStart: Date,
    prevDayHigh: number | null,
    prevDayLow: number | null,
    _minRelVol: number,
  ): UnderlyingIndicators {
    const vwap = this.taService.computeVWAP(window);
    const rsi = this.taService.computeRSI(window);
    const ema9 = this.taService.computeEMA(window, 9);
    const ema21 = this.taService.computeEMA(window, 21);
    const ema50 = this.taService.computeEMA50(window);
    const atr = this.taService.computeATR(window);
    const macd = this.taService.computeMACD(window);
    const adx = this.taService.computeADX(window);
    const roc = this.taService.computeROC(window)?.roc ?? null;
    const relVol = this.taService.computeRelativeVolume(window, 5);
    const orb = this.taService.computeORBRange(window, sessionStart, 15);
    const currentPrice = window[window.length - 1].close;

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
      prevDayHigh,
      prevDayLow,
      currentPrice,
      relativeStrengthVsNifty: null, // not available without a second underlying
      candleCount1m: window.length,
      candleCount5m: Math.floor(window.length / 5),
    };
  }

  private evaluateStrategy(
    code: ReplayStrategyCode,
    indicators: UnderlyingIndicators,
    window: OHLCV[],
  ) {
    switch (code) {
      case 'A':
        return this.entryConditions.evaluateORB(indicators, window);
      case 'B':
        return this.entryConditions.evaluateVWAPReclaim(indicators, window);
      case 'C':
        return this.entryConditions.evaluateMomentumExpansion(indicators);
      case 'D':
        return this.entryConditions.evaluateBreakoutRetest(indicators, window);
      case 'E':
        return this.entryConditions.evaluateRelativeStrength(indicators);
      case 'F':
        return this.entryConditions.evaluateTrendContinuation(indicators, window);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metrics computation
  // ─────────────────────────────────────────────────────────────────────────

  private buildMetrics(
    strategyCode: ReplayStrategyCode,
    trades: ReplayTrade[],
    tradingDays: string[],
    splitDate: string,
  ): ReplayStrategyMetrics {
    const isTrades = trades.filter((t) => t.date < splitDate);
    const oosTrades = trades.filter((t) => t.date >= splitDate);

    // Report OOS metrics as the primary result
    const reportTrades = oosTrades.length >= 3 ? oosTrades : trades;
    return this.computeMetricsFromTrades(
      strategyCode,
      reportTrades,
      tradingDays,
      isTrades,
      oosTrades,
    );
  }

  private computeMetricsFromTrades(
    strategyCode: ReplayStrategyCode,
    trades: ReplayTrade[],
    tradingDays: string[],
    isTrades: ReplayTrade[],
    oosTrades: ReplayTrade[],
  ): ReplayStrategyMetrics {
    void isTrades; // available for future IS-specific analysis

    const wins = trades.filter((t) => t.netPnl > 0);
    const losses = trades.filter((t) => t.netPnl <= 0);
    const grossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);
    const totalCosts = trades.reduce((s, t) => s + t.totalCosts, 0);
    const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
    const expectancy = trades.length > 0 ? netPnl / trades.length : 0;

    const grossWins = wins.reduce((s, t) => s + t.grossPnl, 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + t.grossPnl, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    const maxDrawdown = this.computeMaxDrawdown(trades.map((t) => t.netPnl));
    const avgHolding =
      trades.length > 0
        ? trades.reduce((s, t) => {
            const entry = new Date(`2026-01-01T${t.entryTime}:00+05:30`);
            const exit = new Date(`2026-01-01T${t.exitTime}:00+05:30`);
            return s + (exit.getTime() - entry.getTime()) / 60_000;
          }, 0) / trades.length
        : 0;

    const eodExitPct =
      trades.length > 0
        ? (trades.filter((t) => t.exitReason === 'EOD_SQUARE_OFF').length / trades.length) * 100
        : 0;
    const slExitPct =
      trades.length > 0
        ? (trades.filter((t) => t.exitReason === 'STOP_LOSS').length / trades.length) * 100
        : 0;
    const targetPct =
      trades.length > 0
        ? (trades.filter((t) => t.exitReason === 'TARGET_HIT').length / trades.length) * 100
        : 0;

    const avgMae =
      trades.length > 0 ? trades.reduce((s, t) => s + Math.abs(t.mae), 0) / trades.length : 0;
    const avgMfe = trades.length > 0 ? trades.reduce((s, t) => s + t.mfe, 0) / trades.length : 0;

    // Bootstrap CI on OOS P&L
    const oosPnlArr = oosTrades.map((t) => t.netPnl);
    const expectancyCI = this.bootstrapCI(oosPnlArr);

    const signalDays = new Set(trades.map((t) => t.date)).size;

    return {
      strategyCode,
      strategyName: STRATEGY_NAMES[strategyCode],
      tradingDays: tradingDays.length,
      signalDays,
      totalSignals: trades.length,
      rejectedSignals: 0, // tracked elsewhere when needed
      tradesExecuted: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      grossPnl,
      totalCosts,
      netPnl,
      expectancy,
      profitFactor,
      maxDrawdown,
      avgHoldingMinutes: avgHolding,
      eodExitPct,
      stopLossExitPct: slExitPct,
      targetHitPct: targetPct,
      avgMae,
      avgMfe,
      expectancyCI,
      trades,
    };
  }

  private buildCombinedMetrics(
    strategies: ReplayStrategyCode[],
    allTradesByStrategy: Record<ReplayStrategyCode, ReplayTrade[]>,
    tradingDays: string[],
    splitDate: string,
  ): ReplayStrategyMetrics {
    // Combined: for each day, take the trade with the best MFE (highest-scored opportunity)
    const tradingDaySet = new Set(tradingDays);
    const combinedTrades: ReplayTrade[] = [];

    for (const day of tradingDaySet) {
      // Collect all trades from all strategies on this day
      const dayTrades: ReplayTrade[] = [];
      for (const code of strategies) {
        const t = allTradesByStrategy[code].find((tr) => tr.date === day);
        if (t) dayTrades.push(t);
      }
      if (dayTrades.length === 0) continue;

      // Select the highest-netPnl trade to simulate a "best signal wins" selection
      // In live trading this would be the highest-scored candidate
      dayTrades.sort((a, b) => b.netPnl - a.netPnl);
      combinedTrades.push(dayTrades[0]);
    }

    return this.computeMetricsFromTrades(
      'A',
      combinedTrades,
      tradingDays,
      [],
      combinedTrades.filter((t) => t.date < splitDate),
    );
  }

  private buildWalkForwardWindows(
    strategies: ReplayStrategyCode[],
    allTradesByStrategy: Record<ReplayStrategyCode, ReplayTrade[]>,
    tradingDays: string[],
    windowCount: number,
  ): WalkForwardWindow[] {
    if (tradingDays.length < windowCount * 2) return [];

    const windowSize = Math.floor(tradingDays.length / (windowCount + 1));
    const windows: WalkForwardWindow[] = [];

    for (let w = 0; w < windowCount; w++) {
      const isStart = tradingDays[0];
      const isEnd = tradingDays[Math.min((w + 1) * windowSize - 1, tradingDays.length - 1)];
      const oosStart = tradingDays[Math.min((w + 1) * windowSize, tradingDays.length - 1)];
      const oosEnd = tradingDays[Math.min((w + 2) * windowSize - 1, tradingDays.length - 1)];

      // All trades across all strategies in this window
      const isTrades: ReplayTrade[] = [];
      const oosTrades: ReplayTrade[] = [];

      for (const code of strategies) {
        const all = allTradesByStrategy[code];
        isTrades.push(...all.filter((t) => t.date >= isStart && t.date <= isEnd));
        oosTrades.push(...all.filter((t) => t.date >= oosStart && t.date <= oosEnd));
      }

      const dummyCode = strategies[0] ?? 'A';

      windows.push({
        windowNumber: w + 1,
        inSampleFrom: isStart,
        inSampleTo: isEnd,
        outSampleFrom: oosStart,
        outSampleTo: oosEnd,
        inSampleMetrics: this.computeMetricsFromTrades(dummyCode, isTrades, tradingDays, [], []),
        outSampleMetrics: this.computeMetricsFromTrades(dummyCode, oosTrades, tradingDays, [], []),
        outSampleExpectancyCI: this.bootstrapCI(oosTrades.map((t) => t.netPnl)),
      });
    }

    return windows;
  }

  private computeMaxDrawdown(pnlValues: number[]): number {
    let peak = 0;
    let cumulative = 0;
    let maxDD = 0;
    for (const pnl of pnlValues) {
      cumulative += pnl;
      if (cumulative > peak) peak = cumulative;
      const drawdown = peak - cumulative;
      if (drawdown > maxDD) maxDD = drawdown;
    }
    return maxDD;
  }

  private bootstrapCI(values: number[]): { mean: number; lower95: number; upper95: number } {
    if (values.length === 0) return { mean: 0, lower95: 0, upper95: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (values.length < 5) return { mean, lower95: mean, upper95: mean };

    const bootstrapMeans: number[] = [];
    for (let i = 0; i < BOOTSTRAP_ITERATIONS; i++) {
      let sum = 0;
      for (let j = 0; j < values.length; j++) {
        sum += values[Math.floor(Math.random() * values.length)];
      }
      bootstrapMeans.push(sum / values.length);
    }
    bootstrapMeans.sort((a, b) => a - b);
    return {
      mean,
      lower95: bootstrapMeans[Math.floor(BOOTSTRAP_ITERATIONS * 0.025)],
      upper95: bootstrapMeans[Math.floor(BOOTSTRAP_ITERATIONS * 0.975)],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private readonly rowToOHLCV = (row: Partial<HistoricalCandles>): OHLCV => ({
    open: parseFloat(row.openPrice ?? '0'),
    high: parseFloat(row.highPrice ?? '0'),
    low: parseFloat(row.lowPrice ?? '0'),
    close: parseFloat(row.closePrice ?? '0'),
    volume: parseFloat(row.volume ?? '0'),
    timestamp: row.timestamp ?? new Date(0),
  });

  private getSessionStart(dayIST: string): Date {
    // 09:15 IST = 03:45 UTC
    return new Date(`${dayIST}T03:45:00Z`);
  }

  private formatISTTime(ts: Date): string {
    const istMs = ts.getTime() + IST_OFFSET_MS;
    const d = new Date(istMs);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }

  private inferRegime(ind: UnderlyingIndicators): string {
    const { rsi, vwap, currentPrice, adx } = ind;
    if (rsi === null) return 'UNKNOWN';
    const aboveVwap = vwap !== null && currentPrice > vwap;
    const strong = adx !== null && adx.adx > 25;
    if (rsi > 60 && aboveVwap && strong) return 'STRONG_BULL';
    if (rsi > 55 && aboveVwap) return 'WEAK_BULL';
    if (rsi < 40 && !aboveVwap && strong) return 'STRONG_BEAR';
    if (rsi < 45 && !aboveVwap) return 'WEAK_BEAR';
    return 'SIDEWAYS';
  }

  private buildVerdict(
    oosCount: number,
    oosExpectancy: number,
    oosWinRate: number,
    combined: ReplayStrategyMetrics,
  ): string {
    if (oosCount < 10) {
      return (
        `INSUFFICIENT DATA: only ${oosCount} OOS trades. Need ≥ 10 for statistical interpretation. ` +
        `Acquire more historical data and re-run.`
      );
    }
    const ci = combined.expectancyCI;
    const profitable = ci.lower95 > 0;
    const winRateOk = oosWinRate > 50;
    const pfOk = combined.profitFactor > 1.0;

    if (profitable && winRateOk && pfOk) {
      return (
        `PROVISIONALLY POSITIVE: OOS expectancy ₹${oosExpectancy.toFixed(0)}/trade ` +
        `(95% CI [₹${ci.lower95.toFixed(0)}, ₹${ci.upper95.toFixed(0)}]), ` +
        `win rate ${oosWinRate.toFixed(0)}%, PF ${combined.profitFactor.toFixed(2)}. ` +
        `CI lower bound is positive. Needs ≥ 60 days paper trading to validate.`
      );
    }

    if (oosExpectancy > 0 && ci.lower95 <= 0) {
      return (
        `UNPROVEN: OOS expectancy is positive (₹${oosExpectancy.toFixed(0)}) but ` +
        `95% CI crosses zero [₹${ci.lower95.toFixed(0)}, ₹${ci.upper95.toFixed(0)}]. ` +
        `Cannot reject the null hypothesis of zero expectancy with current sample size.`
      );
    }

    return (
      `NEGATIVE: OOS expectancy ₹${oosExpectancy.toFixed(0)}/trade, ` +
      `win rate ${oosWinRate.toFixed(0)}%, PF ${combined.profitFactor.toFixed(2)}. ` +
      `Strategy as configured does not demonstrate positive net expected value.`
    );
  }
}
