/**
 * DailyIntelligenceReportService — generates the end-of-session trading intelligence report.
 *
 * Logic overview
 * ──────────────
 * 1. Load today's closed trades (Trades for LIVE, PaperTrades for PAPER).
 * 2. Load today's rejected/expired signals for the same engine.
 * 3. Load today's StrategyPerformance rows and aggregate per strategy.
 * 4. Compute capital changes from CapitalLedger opening/closing entries.
 * 5. Build regime observation durations from MarketRegimes classifications.
 * 6. When no trades exist, populate noTradeEntry with evaluated-signal evidence (Req 14.5).
 *
 * Requirements: 14.4, 14.5
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, LessThanOrEqual, Repository } from 'typeorm';

import { Trade } from '../../database/entities/trades.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { Signals } from '../../database/entities/signals.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';
import { CapitalLedgers } from '../../database/entities/capital-ledgers.entity';
import { MarketRegimes } from '../../database/entities/market-regimes.entity';
import { Strategies } from '../../database/entities/strategies.entity';
import { Engine } from './analytics.types';

/** Minimum composite score threshold (Req 8.5) — signals below this are blocked. */
const MIN_COMPOSITE_SCORE = 80;

/** IST offset from UTC in milliseconds (5h 30min). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Maximum regime classification interval in milliseconds (Req 5.1: ≤60 s). */
const MAX_REGIME_INTERVAL_MS = 60_000;

// ─── Public interface ──────────────────────────────────────────────────────────

export interface DailyIntelligenceReport {
  /** NSE trading date in YYYY-MM-DD format (IST calendar date). */
  sessionDate: string;
  engine: Engine;
  tradeSummary: {
    totalTrades: number;
    winCount: number;
    lossCount: number;
    totalNetPnl: number;
    winRate: number;
  };
  regimeObservations: Array<{
    regime: string;
    /** Human-readable duration, e.g. "1h 45m" or "30m". */
    duration: string;
    signalCount: number;
  }>;
  strategyPerformance: Array<{
    strategyCode: string;
    trades: number;
    pnl: number;
    winRate: number;
  }>;
  capitalChanges: {
    openingCapital: number;
    closingCapital: number;
    change: number;
    /** Percentage change (0 when openingCapital is 0). */
    changePercent: number;
  };
  /**
   * Generated-but-not-executed signals with the specific threshold criterion
   * that prevented execution (Req 14.4).
   */
  rejectedSignals: Array<{
    signalId: string;
    strategyCode: string;
    score: number;
    rejectionReason: string;
    failingCriterion: string;
  }>;
  /**
   * Present only when no trades were placed during the session (Req 14.5).
   * Documents the regime context and all evaluated signals.
   */
  noTradeEntry?: {
    reason: string;
    evaluatedSignals: Array<{
      signalId: string;
      score: number;
      failingCriterion: string;
    }>;
  };
}

// ─── Internal narrow record type ──────────────────────────────────────────────

interface TradeRow {
  net_pnl: string;
  entry_time: Date;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class DailyIntelligenceReportService {
  constructor(
    @InjectRepository(Trade)
    private readonly tradesRepo: Repository<Trade>,

    @InjectRepository(PaperTrade)
    private readonly paperTradesRepo: Repository<PaperTrade>,

    @InjectRepository(Signals)
    private readonly signalsRepo: Repository<Signals>,

    @InjectRepository(StrategyPerformance)
    private readonly stratPerfRepo: Repository<StrategyPerformance>,

    @InjectRepository(CapitalLedgers)
    private readonly capitalLedgerRepo: Repository<CapitalLedgers>,

    @InjectRepository(MarketRegimes)
    private readonly marketRegimesRepo: Repository<MarketRegimes>,

    @InjectRepository(Strategies)
    private readonly strategiesRepo: Repository<Strategies>,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generate a full DailyIntelligenceReport for the given engine and session date.
   *
   * @param engine      'LIVE' or 'PAPER' — determines which trade / signal tables are queried.
   * @param sessionDate Any Date whose IST calendar date is the target trading session.
   */
  async generateDailyReport(engine: Engine, sessionDate: Date): Promise<DailyIntelligenceReport> {
    const dateStr = this.formatDate(sessionDate);
    const { start: dayStart, end: dayEnd } = this.getDayBounds(sessionDate);

    // 1. Load all strategies (UUID → code map) — only 8 records, cheap.
    const strategyMap = await this.loadStrategyMap();

    // 2. Load today's closed trades.
    const trades = await this.loadTrades(engine, dayStart, dayEnd);

    // 3. Load today's rejected and expired signals for this engine.
    const rejectedSignalEntities = await this.signalsRepo.find({
      where: [
        { engine, status: 'rejected', signalTimestamp: Between(dayStart, dayEnd) },
        { engine, status: 'expired', signalTimestamp: Between(dayStart, dayEnd) },
      ],
      order: { signalTimestamp: 'ASC' },
    });

    // 4. Assemble report sections in parallel where dependencies allow.
    const [regimeObservations, strategyPerformance, capitalChanges] = await Promise.all([
      this.buildRegimeObservations(dayStart, dayEnd, engine),
      this.buildStrategyPerformance(engine, dateStr, strategyMap),
      this.buildCapitalChanges(engine, dayStart, dayEnd),
    ]);

    const tradeSummary = this.buildTradeSummary(trades);
    const rejectedSignals = this.buildRejectedSignals(rejectedSignalEntities, strategyMap);

    // 5. noTradeEntry is only populated when no trades occurred (Req 14.5).
    const noTradeEntry =
      trades.length === 0 ? this.buildNoTradeEntry(rejectedSignalEntities) : undefined;

    return {
      sessionDate: dateStr,
      engine,
      tradeSummary,
      regimeObservations,
      strategyPerformance,
      capitalChanges,
      rejectedSignals,
      noTradeEntry,
    };
  }

  // ── Private: date helpers ──────────────────────────────────────────────────

  /**
   * Returns the YYYY-MM-DD string for the IST calendar date of the input Date.
   */
  private formatDate(date: Date): string {
    const ist = new Date(date.getTime() + IST_OFFSET_MS);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const d = String(ist.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Returns UTC-equivalent bounds covering the full IST calendar day.
   *   start: 00:00:00.000 IST  →  previous-day 18:30:00.000 UTC
   *   end:   23:59:59.999 IST
   */
  private getDayBounds(date: Date): { start: Date; end: Date } {
    const ist = new Date(date.getTime() + IST_OFFSET_MS);
    const y = ist.getUTCFullYear();
    const mo = ist.getUTCMonth();
    const d = ist.getUTCDate();

    const start = new Date(Date.UTC(y, mo, d, 0, 0, 0, 0) - IST_OFFSET_MS);
    const end = new Date(Date.UTC(y, mo, d, 23, 59, 59, 999) - IST_OFFSET_MS);

    return { start, end };
  }

  // ── Private: data loaders ──────────────────────────────────────────────────

  /**
   * Loads the minimum columns needed for the trade summary.
   * LIVE → `trades` table; PAPER → `paper_trades` table.
   */
  private async loadTrades(engine: Engine, start: Date, end: Date): Promise<TradeRow[]> {
    const where = { entry_time: Between(start, end) };

    if (engine === 'LIVE') {
      return this.tradesRepo.find({
        where,
        select: { net_pnl: true, entry_time: true },
        order: { entry_time: 'ASC' },
      });
    }

    return this.paperTradesRepo.find({
      where,
      select: { net_pnl: true, entry_time: true },
      order: { entry_time: 'ASC' },
    });
  }

  /**
   * Loads all 8 Strategies rows and returns a UUID → strategy-code Map.
   * Called once per report to avoid N+1 queries when resolving signal strategy codes.
   */
  private async loadStrategyMap(): Promise<Map<string, string>> {
    const strategies = await this.strategiesRepo.find({
      select: { id: true, code: true },
    });
    return new Map(strategies.map((s) => [s.id, s.code]));
  }

  // ── Private: report section builders ──────────────────────────────────────

  /** Computes win/loss summary from raw trade rows. Returns zero metrics for empty input. */
  private buildTradeSummary(trades: TradeRow[]): DailyIntelligenceReport['tradeSummary'] {
    const n = trades.length;

    if (n === 0) {
      return { totalTrades: 0, winCount: 0, lossCount: 0, totalNetPnl: 0, winRate: 0 };
    }

    const pnl = trades.map((t) => parseFloat(t.net_pnl));
    const winCount = pnl.filter((v) => v > 0).length;
    const lossCount = pnl.filter((v) => v < 0).length;
    const totalNetPnl = pnl.reduce((s, v) => s + v, 0);

    return {
      totalTrades: n,
      winCount,
      lossCount,
      totalNetPnl,
      winRate: winCount / n,
    };
  }

  /**
   * Builds regime observation records from today's MarketRegimes classifications.
   *
   * Duration algorithm: for each consecutive pair of regime records, the first
   * record's contribution to its regime's total duration is the gap between the
   * two timestamps.  The final record contributes MAX_REGIME_INTERVAL_MS (60 s).
   *
   * signalCount: number of signals generated in that engine/regime today (all statuses).
   */
  private async buildRegimeObservations(
    dayStart: Date,
    dayEnd: Date,
    engine: Engine,
  ): Promise<DailyIntelligenceReport['regimeObservations']> {
    const regimeRecords = await this.marketRegimesRepo.find({
      where: { classifiedAt: Between(dayStart, dayEnd) },
      order: { classifiedAt: 'ASC' },
    });

    if (regimeRecords.length === 0) return [];

    // Count signals per regime code for this engine today (all statuses).
    const signals = await this.signalsRepo.find({
      where: { engine, signalTimestamp: Between(dayStart, dayEnd) },
      select: { regime: true },
    });

    const signalCountByRegime = new Map<string, number>();
    for (const s of signals) {
      if (s.regime) {
        signalCountByRegime.set(s.regime, (signalCountByRegime.get(s.regime) ?? 0) + 1);
      }
    }

    // Accumulate duration (ms) per regime code.
    const durationByRegime = new Map<string, number>();
    for (let i = 0; i < regimeRecords.length; i++) {
      const record = regimeRecords[i];
      const next = regimeRecords[i + 1];
      const ms = next
        ? next.classifiedAt.getTime() - record.classifiedAt.getTime()
        : MAX_REGIME_INTERVAL_MS;
      durationByRegime.set(record.regime, (durationByRegime.get(record.regime) ?? 0) + ms);
    }

    return Array.from(durationByRegime.entries()).map(([regime, ms]) => ({
      regime,
      duration: this.formatDuration(ms),
      signalCount: signalCountByRegime.get(regime) ?? 0,
    }));
  }

  /**
   * Builds per-strategy performance from today's StrategyPerformance rows.
   *
   * Multiple rows for the same strategy (regime-segmented records) are merged.
   * Strategies with zero trades on the day are excluded.
   */
  private async buildStrategyPerformance(
    engine: Engine,
    dateStr: string,
    strategyMap: Map<string, string>,
  ): Promise<DailyIntelligenceReport['strategyPerformance']> {
    const records = await this.stratPerfRepo.find({
      where: { engine, trading_date: dateStr },
    });

    if (records.length === 0) return [];

    // Aggregate regime-segmented rows by strategy UUID.
    const agg = new Map<string, { trades: number; wins: number; pnl: number }>();
    for (const r of records) {
      const prev = agg.get(r.strategy_id) ?? { trades: 0, wins: 0, pnl: 0 };
      agg.set(r.strategy_id, {
        trades: prev.trades + r.trades_count,
        wins: prev.wins + r.win_count,
        pnl: prev.pnl + parseFloat(r.total_net_pnl),
      });
    }

    return Array.from(agg.entries())
      .filter(([, v]) => v.trades > 0)
      .map(([strategyId, v]) => ({
        strategyCode: strategyMap.get(strategyId) ?? 'UNKNOWN',
        trades: v.trades,
        pnl: v.pnl,
        winRate: v.wins / v.trades,
      }));
  }

  /**
   * Computes opening and closing capital from CapitalLedger entries.
   *
   * Opening  = balance_after of the last ledger entry BEFORE the session day.
   * Closing  = balance_after of the last ledger entry within or before the session day.
   *
   * Both default to 0 when no ledger history exists.
   */
  private async buildCapitalChanges(
    engine: Engine,
    dayStart: Date,
    dayEnd: Date,
  ): Promise<DailyIntelligenceReport['capitalChanges']> {
    const openingEntry = await this.capitalLedgerRepo.findOne({
      where: { engine, occurred_at: LessThan(dayStart) },
      order: { occurred_at: 'DESC' },
    });

    const closingEntry = await this.capitalLedgerRepo.findOne({
      where: { engine, occurred_at: LessThanOrEqual(dayEnd) },
      order: { occurred_at: 'DESC' },
    });

    const openingCapital = openingEntry ? parseFloat(openingEntry.balance_after) : 0;
    const closingCapital = closingEntry ? parseFloat(closingEntry.balance_after) : openingCapital;
    const change = closingCapital - openingCapital;
    const changePercent = openingCapital !== 0 ? (change / openingCapital) * 100 : 0;

    return { openingCapital, closingCapital, change, changePercent };
  }

  /**
   * Maps rejected/expired signal entities to the report's RejectedSignalEntry shape.
   */
  private buildRejectedSignals(
    signals: Signals[],
    strategyMap: Map<string, string>,
  ): DailyIntelligenceReport['rejectedSignals'] {
    return signals.map((s) => ({
      signalId: s.id,
      strategyCode: strategyMap.get(s.strategyId) ?? 'UNKNOWN',
      score: parseFloat(s.compositeScore),
      rejectionReason:
        s.rejectionReason ?? (s.status === 'expired' ? 'Signal expired' : 'No reason recorded'),
      failingCriterion: this.deriveFailingCriterion(s),
    }));
  }

  /**
   * Builds the noTradeEntry section — only called when trades.length === 0 (Req 14.5).
   */
  private buildNoTradeEntry(signals: Signals[]): DailyIntelligenceReport['noTradeEntry'] {
    const reason =
      signals.length === 0
        ? 'No signals were generated during the session'
        : `${signals.length} signal(s) evaluated; none met the execution thresholds`;

    return {
      reason,
      evaluatedSignals: signals.map((s) => ({
        signalId: s.id,
        score: parseFloat(s.compositeScore),
        failingCriterion: this.deriveFailingCriterion(s),
      })),
    };
  }

  // ── Private: utilities ─────────────────────────────────────────────────────

  /**
   * Derives the most specific failing threshold criterion from a signal.
   *
   * Priority order:
   *  1. Expired status  → TTL description
   *  2. Score < 80      → score-threshold description (Req 8.5)
   *  3. rejectionReason → used verbatim (set by upstream module)
   *  4. Fallback
   */
  private deriveFailingCriterion(signal: Signals): string {
    if (signal.status === 'expired') {
      return 'Signal expired — TTL elapsed before execution';
    }

    const score = parseFloat(signal.compositeScore);
    if (score < MIN_COMPOSITE_SCORE) {
      return (
        `Composite score below minimum threshold ` +
        `(required: ≥${MIN_COMPOSITE_SCORE}, actual: ${score.toFixed(2)})`
      );
    }

    if (signal.rejectionReason) {
      return signal.rejectionReason;
    }

    return 'Threshold criterion not recorded';
  }

  /**
   * Formats a duration in milliseconds as "Xh Ym", "Xh", or "Ym".
   * Values below 60 s are shown as "0m".
   */
  private formatDuration(ms: number): string {
    const totalMinutes = Math.round(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
  }
}
