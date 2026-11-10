/**
 * AnalyticsService — computes all 12 performance metrics for a given engine
 * and time window.
 *
 * Key design decisions
 * ────────────────────
 * • LIVE queries the `trades` table (Trade entity); PAPER queries the
 *   `paper_trades` table (PaperTrade entity) — zero table sharing.
 * • Trades are ordered by `entry_time ASC` so drawdown and streak metrics are
 *   computed in chronological order.
 * • `net_pnl` is a PostgreSQL NUMERIC column; TypeORM returns it as a string.
 *   All arithmetic is performed after `parseFloat()`.
 * • Ratio-based metrics are suppressed when tradeCount < 30 (Req 14.2).
 * • SESSION start = 09:00 IST = 03:30 UTC on the current IST calendar date.
 *
 * Requirements: 14.1, 14.2
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, MoreThanOrEqual, Repository } from 'typeorm';

import { Trade } from '../../database/entities/trades.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { Strategies } from '../../database/entities/strategies.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { Engine, INSUFFICIENT_DATA, PerformanceMetrics, TimeWindow } from './analytics.types';
import {
  AttributionBreakdown,
  AttributionMetrics,
  InstrumentMetrics,
  StrategyMetrics,
  TimeOfDayMetrics,
} from './attribution.types';

/** Minimum closed-trade count required to compute ratio-based metrics (Req 14.2). */
const MIN_TRADES_FOR_RATIOS = 30;

/** Trading days per year used for Sharpe / Sortino / Calmar annualisation. */
const TRADING_DAYS_PER_YEAR = 252;

/**
 * IST is UTC+5:30.  Session start (09:00 IST) expressed as UTC hours/minutes.
 *   09:00 IST − 05:30 offset = 03:30 UTC
 */
const SESSION_START_UTC_H = 3;
const SESSION_START_UTC_M = 30;

/** IST offset from UTC in milliseconds (5 h 30 min). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Narrow internal type — only the two columns needed for every metric.
 * Both entities expose these columns with the same names and types.
 */
interface TradeRecord {
  net_pnl: string;
  entry_time: Date;
}

/**
 * Extended trade record carrying the extra columns required for attribution
 * breakdowns (strategy, instrument, time-of-day).
 */
interface AttributionTradeRecord {
  net_pnl: string;
  entry_time: Date;
  /** NULL is possible for PaperTrades created without a strategy context. */
  strategy_id: string | null;
  instrument_id: string;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Trade)
    private readonly tradesRepo: Repository<Trade>,

    @InjectRepository(PaperTrade)
    private readonly paperTradesRepo: Repository<PaperTrade>,

    @InjectRepository(Strategies)
    private readonly strategiesRepo: Repository<Strategies>,

    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Compute all 12 performance metrics for the given engine and time window.
   *
   * Ratio-based metrics (`profitFactor`, `sharpeRatio`, `sortinoRatio`,
   * `calmarRatio`) are replaced by the INSUFFICIENT_DATA sentinel when fewer
   * than 30 trades are present in the selected window.
   */
  async getPerformanceMetrics(engine: Engine, timeWindow: TimeWindow): Promise<PerformanceMetrics> {
    const since = this.resolveTimeFilter(timeWindow);
    const trades = await this.loadTrades(engine, since);
    return this.computeMetrics(trades);
  }

  /**
   * Compute performance attribution breakdowns for the given engine and time
   * window, sliced across four dimensions:
   *
   * - **byStrategy** — keyed by strategy code ('A'–'H').  Requires a lookup
   *   against the `strategies` table to resolve UUIDs to codes.
   * - **byInstrument** — keyed by the instrument's trading symbol (e.g.
   *   'NIFTY24JAN21000CE').  Requires a lookup against `instruments`.
   * - **byRegime** — keyed by regime code.  Returns an empty record because
   *   the `trades` and `paper_trades` entities do not carry a denormalised
   *   `regime` column; callers should not rely on this field being populated.
   * - **byTimeOfDay** — keyed by 60-minute IST bucket label ("09:15-10:15",
   *   "10:15-11:15", …) derived from each trade's `entry_time`.
   *
   * Requirements: 14.3
   */
  async getAttributionBreakdown(
    engine: Engine,
    timeWindow: TimeWindow,
  ): Promise<AttributionBreakdown> {
    const since = this.resolveTimeFilter(timeWindow);
    const trades = await this.loadAttributionTrades(engine, since);

    if (trades.length === 0) {
      return { byStrategy: {}, byInstrument: {}, byRegime: {}, byTimeOfDay: {} };
    }

    // ── Resolve IDs → human-readable keys ─────────────────────────────────
    const strategyIds = [
      ...new Set(trades.map((t) => t.strategy_id).filter((id): id is string => id !== null)),
    ];
    const instrumentIds = [...new Set(trades.map((t) => t.instrument_id))];

    const [strategyCodeById, instrumentSymbolById] = await Promise.all([
      this.buildStrategyCodeMap(strategyIds),
      this.buildInstrumentSymbolMap(instrumentIds),
    ]);

    // ── Bucket trades by each dimension ───────────────────────────────────
    const strategyBuckets = new Map<string, AttributionTradeRecord[]>();
    const instrumentBuckets = new Map<string, AttributionTradeRecord[]>();
    const timeOfDayBuckets = new Map<string, AttributionTradeRecord[]>();

    for (const trade of trades) {
      // strategy dimension
      if (trade.strategy_id !== null) {
        const code = strategyCodeById.get(trade.strategy_id);
        if (code !== undefined) {
          if (!strategyBuckets.has(code)) strategyBuckets.set(code, []);
          strategyBuckets.get(code)!.push(trade);
        }
      }

      // instrument dimension
      const symbol = instrumentSymbolById.get(trade.instrument_id);
      if (symbol !== undefined) {
        if (!instrumentBuckets.has(symbol)) instrumentBuckets.set(symbol, []);
        instrumentBuckets.get(symbol)!.push(trade);
      }

      // time-of-day dimension
      const bucket = this.getTimeOfDayBucket(trade.entry_time);
      if (!timeOfDayBuckets.has(bucket)) timeOfDayBuckets.set(bucket, []);
      timeOfDayBuckets.get(bucket)!.push(trade);
    }

    // ── Build result records ───────────────────────────────────────────────
    const byStrategy: Record<string, StrategyMetrics> = {};
    for (const [code, batch] of strategyBuckets) {
      byStrategy[code] = this.computeAttributionMetrics(batch);
    }

    const byInstrument: Record<string, InstrumentMetrics> = {};
    for (const [symbol, batch] of instrumentBuckets) {
      byInstrument[symbol] = this.computeAttributionMetrics(batch);
    }

    const byTimeOfDay: Record<string, TimeOfDayMetrics> = {};
    for (const [label, batch] of timeOfDayBuckets) {
      byTimeOfDay[label] = this.computeAttributionMetrics(batch);
    }

    // byRegime is intentionally empty: the Trade / PaperTrade entities do not
    // carry a denormalised regime column (Req 14.3 implementation note).
    return { byStrategy, byInstrument, byRegime: {}, byTimeOfDay };
  }

  // ── Private: time-window helpers ───────────────────────────────────────────

  /**
   * Returns the lower-bound timestamp for the given time window, or `null`
   * for ALL_TIME (no date filter).
   */
  private resolveTimeFilter(timeWindow: TimeWindow): Date | null {
    if (timeWindow === 'ALL_TIME') return null;

    if (timeWindow === 'SESSION') {
      return this.sessionStartUtc();
    }

    // LAST_30_DAYS: 30 calendar days ago from now
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    return cutoff;
  }

  /**
   * Returns the UTC timestamp corresponding to 09:00 IST on today's IST
   * calendar date.
   *
   * Example: on 2024-11-15 at 10:30 IST the method returns
   * `new Date("2024-11-15T03:30:00.000Z")`.
   */
  private sessionStartUtc(): Date {
    const now = new Date();
    // Shift to IST to find the current IST calendar date.
    const nowIST = new Date(now.getTime() + IST_OFFSET_MS);
    const y = nowIST.getUTCFullYear();
    const mo = nowIST.getUTCMonth();
    const d = nowIST.getUTCDate();
    // Reconstruct 09:00 IST as UTC (subtract 5h30m).
    return new Date(Date.UTC(y, mo, d, SESSION_START_UTC_H, SESSION_START_UTC_M, 0, 0));
  }

  // ── Private: data loading ──────────────────────────────────────────────────

  /**
   * Queries the entity table corresponding to the requested engine.
   *
   * LIVE → `trades` table (Trade entity)
   * PAPER → `paper_trades` table (PaperTrade entity)
   *
   * Trades are returned in ascending entry_time order so that drawdown and
   * consecutive-streak calculations are chronologically correct.
   */
  private async loadTrades(engine: Engine, since: Date | null): Promise<TradeRecord[]> {
    const where: FindOptionsWhere<Trade> | FindOptionsWhere<PaperTrade> = {};

    if (since !== null) {
      (where as FindOptionsWhere<Trade>).entry_time = MoreThanOrEqual(since);
    }

    if (engine === 'LIVE') {
      return this.tradesRepo.find({
        where: where as FindOptionsWhere<Trade>,
        select: { net_pnl: true, entry_time: true },
        order: { entry_time: 'ASC' },
      });
    }

    return this.paperTradesRepo.find({
      where: where as FindOptionsWhere<PaperTrade>,
      select: { net_pnl: true, entry_time: true },
      order: { entry_time: 'ASC' },
    });
  }

  /**
   * Loads the extended trade columns required for attribution breakdowns.
   * Selects `net_pnl`, `entry_time`, `strategy_id`, and `instrument_id`.
   *
   * LIVE → `trades` table; PAPER → `paper_trades` table.
   */
  private async loadAttributionTrades(
    engine: Engine,
    since: Date | null,
  ): Promise<AttributionTradeRecord[]> {
    const where: FindOptionsWhere<Trade> | FindOptionsWhere<PaperTrade> = {};

    if (since !== null) {
      (where as FindOptionsWhere<Trade>).entry_time = MoreThanOrEqual(since);
    }

    if (engine === 'LIVE') {
      return this.tradesRepo.find({
        where: where as FindOptionsWhere<Trade>,
        select: { net_pnl: true, entry_time: true, strategy_id: true, instrument_id: true },
        order: { entry_time: 'ASC' },
      }) as Promise<AttributionTradeRecord[]>;
    }

    return this.paperTradesRepo.find({
      where: where as FindOptionsWhere<PaperTrade>,
      select: { net_pnl: true, entry_time: true, strategy_id: true, instrument_id: true },
      order: { entry_time: 'ASC' },
    }) as Promise<AttributionTradeRecord[]>;
  }

  /**
   * Fetches the strategy rows for the given IDs and returns a Map from UUID
   * to single-letter strategy code.  Returns an empty Map when `ids` is empty.
   */
  private async buildStrategyCodeMap(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();

    const rows = await this.strategiesRepo.find({
      where: { id: In(ids) },
      select: { id: true, code: true },
    });

    return new Map(rows.map((s) => [s.id, s.code]));
  }

  /**
   * Fetches the instrument rows for the given IDs and returns a Map from UUID
   * to trading symbol.  Returns an empty Map when `ids` is empty.
   */
  private async buildInstrumentSymbolMap(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();

    const rows = await this.instrumentsRepo.find({
      where: { id: In(ids) },
      select: { id: true, tradingSymbol: true },
    });

    return new Map(rows.map((i) => [i.id, i.tradingSymbol]));
  }

  // ── Private: metrics computation ───────────────────────────────────────────

  /**
   * Derives all 12 metrics from an ordered list of trade records.
   * Handles the empty-list edge case without throwing.
   */
  private computeMetrics(trades: TradeRecord[]): PerformanceMetrics {
    const n = trades.length;

    if (n === 0) return this.emptyMetrics();

    const pnl = trades.map((t) => parseFloat(t.net_pnl));

    // ── Always-shown metrics ──────────────────────────────────────────────
    const wins = pnl.filter((v) => v > 0);
    const losses = pnl.filter((v) => v < 0);

    const winRate = wins.length / n;
    const expectancy = this.mean(pnl);
    const avgWin = wins.length > 0 ? this.mean(wins) : 0;
    const avgLoss = losses.length > 0 ? this.mean(losses) : 0; // ≤ 0
    const rrRatio = losses.length > 0 ? Math.abs(avgWin / avgLoss) : 0;
    const maxDrawdown = this.computeMaxDrawdown(pnl);
    const maxConsecutiveWins = this.longestStreak(pnl, true);
    const maxConsecutiveLosses = this.longestStreak(pnl, false);

    const base = {
      winRate,
      expectancy,
      avgWin,
      avgLoss,
      rrRatio,
      maxDrawdown,
      maxConsecutiveWins,
      maxConsecutiveLosses,
      tradeCount: n,
    };

    // ── Ratio-based metrics (suppressed below threshold) ──────────────────
    if (n < MIN_TRADES_FOR_RATIOS) {
      return {
        ...base,
        profitFactor: INSUFFICIENT_DATA,
        sharpeRatio: INSUFFICIENT_DATA,
        sortinoRatio: INSUFFICIENT_DATA,
        calmarRatio: INSUFFICIENT_DATA,
      };
    }

    return {
      ...base,
      profitFactor: this.computeProfitFactor(pnl),
      sharpeRatio: this.computeSharpeRatio(pnl),
      sortinoRatio: this.computeSortinoRatio(pnl),
      calmarRatio: this.computeCalmarRatio(pnl, maxDrawdown),
    };
  }

  /**
   * Zero-value metrics returned when the trade list is empty.
   * Ratio metrics are suppressed (tradeCount = 0 < 30).
   */
  private emptyMetrics(): PerformanceMetrics {
    return {
      winRate: 0,
      profitFactor: INSUFFICIENT_DATA,
      expectancy: 0,
      avgWin: 0,
      avgLoss: 0,
      rrRatio: 0,
      maxDrawdown: 0,
      sharpeRatio: INSUFFICIENT_DATA,
      sortinoRatio: INSUFFICIENT_DATA,
      calmarRatio: INSUFFICIENT_DATA,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      tradeCount: 0,
    };
  }

  // ── Private: attribution helpers ──────────────────────────────────────────

  /**
   * Computes the four lightweight attribution metrics for a group of trades.
   * Unlike `computeMetrics`, this method never suppresses any field — all four
   * values are always numeric.
   */
  private computeAttributionMetrics(trades: Array<{ net_pnl: string }>): AttributionMetrics {
    const n = trades.length;
    if (n === 0) return { tradeCount: 0, winRate: 0, expectancy: 0, netPnl: 0 };

    const pnl = trades.map((t) => parseFloat(t.net_pnl));
    const wins = pnl.filter((v) => v > 0).length;
    const netPnl = pnl.reduce((sum, v) => sum + v, 0);

    return {
      tradeCount: n,
      winRate: wins / n,
      expectancy: netPnl / n,
      netPnl,
    };
  }

  /**
   * Derives the 60-minute IST time-of-day bucket label for a UTC timestamp.
   *
   * Windows start at 09:15 IST.  Examples:
   *   09:15–10:14 IST  →  "09:15-10:15"
   *   10:15–11:14 IST  →  "10:15-11:15"
   *
   * Trades arriving before 09:15 IST (pre-market) are placed in a
   * "pre-market" bucket so they are never silently dropped.
   */
  private getTimeOfDayBucket(entryTimeUtc: Date): string {
    // Shift UTC → IST (+5h 30m)
    const ist = new Date(entryTimeUtc.getTime() + IST_OFFSET_MS);
    const totalMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();

    /** 09:15 IST expressed in minutes since midnight. */
    const MARKET_OPEN_MIN = 9 * 60 + 15;

    if (totalMinutes < MARKET_OPEN_MIN) {
      return 'pre-market';
    }

    const minutesFromOpen = totalMinutes - MARKET_OPEN_MIN;
    const bucketIndex = Math.floor(minutesFromOpen / 60);

    const startMin = MARKET_OPEN_MIN + bucketIndex * 60;
    const endMin = startMin + 60;

    const pad = (n: number) => n.toString().padStart(2, '0');
    const fmt = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

    return `${fmt(startMin)}-${fmt(endMin)}`;
  }

  // ── Private: math utilities ────────────────────────────────────────────────

  /** Arithmetic mean of a non-empty array.  Returns 0 for empty arrays. */
  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * Sample standard deviation (denominator = n − 1).
   * Returns 0 when fewer than 2 elements are present.
   */
  private sampleStddev(values: number[]): number {
    if (values.length < 2) return 0;
    const avg = this.mean(values);
    const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Maximum peak-to-trough decline in cumulative P&L (non-negative magnitude).
   *
   * Algorithm: iterate in chronological order; track running peak and subtract
   * current cumulative P&L to get the current drawdown depth.
   */
  private computeMaxDrawdown(pnl: number[]): number {
    let peak = 0;
    let cumulative = 0;
    let maxDD = 0;

    for (const v of pnl) {
      cumulative += v;
      if (cumulative > peak) peak = cumulative;
      const dd = peak - cumulative;
      if (dd > maxDD) maxDD = dd;
    }

    return maxDD;
  }

  /**
   * Length of the longest consecutive run of winning (wins=true) or losing
   * (wins=false) trades in sequential order.
   */
  private longestStreak(pnl: number[], wins: boolean): number {
    let best = 0;
    let current = 0;

    for (const v of pnl) {
      if (v > 0 === wins) {
        current++;
        if (current > best) best = current;
      } else {
        current = 0;
      }
    }

    return best;
  }

  // ── Private: ratio-based metrics ──────────────────────────────────────────

  /**
   * Profit factor = gross profit / |gross loss|.
   * Returns 0 when there are no losing trades (avoids division by zero;
   * the theoretical value would be +∞ but is not representable in the display
   * format expected by callers).
   */
  private computeProfitFactor(pnl: number[]): number {
    const grossProfit = pnl.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const grossLoss = Math.abs(pnl.filter((v) => v < 0).reduce((s, v) => s + v, 0));
    if (grossLoss === 0) return 0;
    return grossProfit / grossLoss;
  }

  /**
   * Annualised Sharpe ratio using sample standard deviation.
   * Returns 0 when all trade P&Ls are identical (zero volatility).
   */
  private computeSharpeRatio(pnl: number[]): number {
    const sd = this.sampleStddev(pnl);
    if (sd === 0) return 0;
    return (this.mean(pnl) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }

  /**
   * Annualised Sortino ratio.
   *
   * Downside semi-deviation:
   *   sqrt( sum( max(0, −pnl_i)² ) / n )
   * where the denominator n is the total trade count (not just losing trades).
   * Target return = 0.
   *
   * Returns 0 when downside deviation is 0 (no negative returns).
   */
  private computeSortinoRatio(pnl: number[]): number {
    const n = pnl.length;
    const downsideSumSq = pnl.reduce((sum, v) => sum + (v < 0 ? v * v : 0), 0);
    const downsideDev = Math.sqrt(downsideSumSq / n);
    if (downsideDev === 0) return 0;
    return (this.mean(pnl) / downsideDev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }

  /**
   * Calmar ratio = annualised return / max drawdown.
   *
   * Annualised return = mean(pnl) × TRADING_DAYS_PER_YEAR (absolute terms,
   * not percentage, consistent with net_pnl units).
   *
   * Returns 0 when max drawdown is 0 (no underwater period).
   */
  private computeCalmarRatio(pnl: number[], maxDrawdown: number): number {
    if (maxDrawdown === 0) return 0;
    const annualisedReturn = this.mean(pnl) * TRADING_DAYS_PER_YEAR;
    return annualisedReturn / maxDrawdown;
  }
}
