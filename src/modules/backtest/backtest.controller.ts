/**
 * backtest.controller.ts
 *
 * BacktestController — exposes the BacktestService via REST API.
 *
 * POST /backtest/run
 *   Run a walk-forward backtest for a strategy using historical paper/live trades.
 *   Returns in-sample + out-of-sample metrics with 95% bootstrap confidence intervals.
 *
 * Requirements: Phase 9 — Quantitative Validation; Section 10 (walk-forward testing)
 */

import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { BacktestService } from './backtest.service';
import {
  DhanHistoricalBackfillService,
  BackfillRequest,
  BackfillResult,
} from './dhan-historical-backfill.service';
import { BacktestConfig, BacktestResult, BacktestTrade, AblationResult } from './backtest.types';
import { TradingChargesService } from '../charges/trading-charges.service';
import { Trade } from '../../database/entities/trades.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { getISTStartOfDay } from '../../common/utils/ist-time.utils';

/** Request body for POST /backtest/ablation. */
export class RunAblationDto {
  strategyCode!: string;
  trades!: BacktestTrade[];
}

/** Request body for POST /backtest/run. */
export class RunBacktestDto {
  config!: BacktestConfig;
  trades!: BacktestTrade[];
}

/** Response from GET /backtest/charges (reference rates for validation). */
export interface ChargeRatesResponse {
  brokeragePerRoundTrip: number;
  sttRateOnSell: number;
  exchangeChargeRate: number;
  gstRate: number;
  sebiRatePerCrore: number;
  stampDutyRate: number;
  basis: string;
  effectiveFrom: string;
}

@Controller('backtest')
export class BacktestController {
  constructor(
    private readonly backtestService: BacktestService,
    private readonly backfillService: DhanHistoricalBackfillService,
    private readonly chargesService: TradingChargesService,
    @InjectRepository(Trade)
    private readonly tradesRepo: Repository<Trade>,
    @InjectRepository(PaperTrade)
    private readonly paperTradesRepo: Repository<PaperTrade>,
  ) {}

  /**
   * POST /backtest/ablation
   *
   * Run a strategy ablation analysis on a provided trade set.
   * Systematically excludes each regime and instrument to identify
   * which groups are dragging performance down.
   *
   * @example
   * POST /backtest/ablation
   * { "strategyCode": "A", "trades": [...] }
   */
  @Post('ablation')
  runAblation(@Body() dto: RunAblationDto): AblationResult {
    return this.backtestService.runAblationAnalysis(dto.strategyCode, dto.trades);
  }

  /**
   * POST /backtest/run
   *
   * Execute a walk-forward historical backtest.
   *
   * - `config.inSampleRatio` must be 0.5 – 0.9 (inclusive).
   * - Trades are sorted chronologically (no look-ahead bias).
   * - Returns in-sample and out-of-sample metrics plus 95% CIs.
   *
   * @example
   * POST /backtest/run
   * {
   *   "config": { "strategyCode": "A", "inSampleRatio": 0.7, "startDate": "2026-01-01",
   *               "endDate": "2026-10-31", "engine": "PAPER" },
   *   "trades": [...]
   * }
   */
  @Post('run')
  runBacktest(@Body() dto: RunBacktestDto): BacktestResult {
    return this.backtestService.runBacktest(dto.config, dto.trades);
  }

  /**
   * GET /backtest/charges
   *
   * Returns the current NSE F&O trading charge rates used for all backtest
   * and paper-trading cost calculations. Useful for external validation and
   * cost-model parity verification.
   */
  @Get('charges')
  getChargeRates(): ChargeRatesResponse {
    return {
      brokeragePerRoundTrip: TradingChargesService.BROKERAGE_PER_ORDER * 2,
      sttRateOnSell: TradingChargesService.STT_RATE,
      exchangeChargeRate: TradingChargesService.EXCHANGE_CHARGE_RATE,
      gstRate: TradingChargesService.GST_RATE,
      sebiRatePerCrore: TradingChargesService.SEBI_RATE * 1_00_00_000,
      stampDutyRate: TradingChargesService.STAMP_DUTY_RATE,
      basis: 'Dhan broker, NSE F&O options',
      effectiveFrom: '2024-10-01', // Budget 2024 STT increase
    };
  }

  /**
   * GET /backtest/historical?engine=PAPER|LIVE&days=30&strategyId=<uuid>
   *
   * Loads closed trades from the database in BacktestTrade format, ready
   * to be passed directly into POST /backtest/run.
   *
   * Query params:
   *   engine     — PAPER (default) or LIVE
   *   days       — look-back window in calendar days (default 30, max 365)
   *   strategyId — optional UUID to filter by a single strategy
   *
   * @example
   *   GET /backtest/historical?engine=PAPER&days=90
   *   → [ { id, date, pnl, strategyCode, ... }, ... ]
   */
  @Get('historical')
  async getHistoricalTrades(
    @Query('engine') engine = 'PAPER',
    @Query('days') daysStr = '30',
    @Query('strategyId') strategyId?: string,
  ): Promise<BacktestTrade[]> {
    const days = Math.min(365, Math.max(1, parseInt(daysStr, 10)));
    // Start from IST midnight N days ago — aligns with the Indian trading calendar.
    const since = getISTStartOfDay();
    since.setDate(since.getDate() - days);

    if (engine === 'LIVE') {
      const rows = await this.tradesRepo.find({
        where: {
          entry_time: MoreThanOrEqual(since),
          ...(strategyId ? { strategy_id: strategyId } : {}),
        },
        order: { entry_time: 'ASC' },
        take: 2_000,
      });

      return rows.map((t) => ({
        date: t.entry_time,
        pnl: parseFloat(t.net_pnl),
        entry: parseFloat(t.entry_price),
        exit: parseFloat(t.exit_price),
        regime: '', // regime not stored on Trade; supply via signal if needed
        instrument: t.instrument_id,
        isDelisted: false,
      }));
    }

    // Default: PAPER
    const rows = await this.paperTradesRepo.find({
      where: {
        entry_time: MoreThanOrEqual(since),
        ...(strategyId ? { strategy_id: strategyId } : {}),
      },
      order: { entry_time: 'ASC' },
      take: 2_000,
    });

    return rows.map((t) => ({
      date: t.entry_time,
      pnl: parseFloat(t.net_pnl),
      entry: parseFloat(t.entry_price),
      exit: parseFloat(t.exit_price),
      regime: '',
      instrument: t.instrument_id,
      isDelisted: false,
    }));
  }

  /**
   * POST /backtest/backfill
   *
   * Fetch historical OHLCV candles from the Dhan API and store them in the
   * `historical_candles` table (DEFECT-005 fix).
   *
   * This endpoint resolves the external data blocker: Dhan's historical API
   * provides daily and intraday candle data for NSE F&O instruments that are
   * (or were recently) active.  For best coverage:
   *
   *   - Use granularity="1d" for multi-year lookbacks (fastest, lowest rate usage).
   *   - Use granularity="1m" for recent weeks/months (precise entry/exit precision).
   *   - Filter by underlyingSymbol="NIFTY" or "BANKNIFTY" to scope to index options.
   *
   * Requires a valid Dhan session token (DHAN_SESSION_TOKEN env var).
   *
   * @example
   * POST /backtest/backfill
   * {
   *   "fromDate": "2024-01-01",
   *   "toDate": "2024-12-31",
   *   "granularity": "1d",
   *   "underlyingSymbol": "NIFTY",
   *   "limit": 50
   * }
   */
  @Post('backfill')
  async backfill(@Body() request: BackfillRequest): Promise<BackfillResult> {
    return this.backfillService.backfill(request);
  }
}
