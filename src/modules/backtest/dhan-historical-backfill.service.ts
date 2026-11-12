/**
 * dhan-historical-backfill.service.ts
 *
 * DhanHistoricalBackfillService — on-demand historical OHLCV candle backfill
 * using the Dhan v2 historical data API.
 *
 * # Purpose (DEFECT-005 fix)
 *
 * This service resolves the external data blocker for DEFECT-005 by fetching
 * historical candle data directly from the Dhan API for all instruments
 * currently stored in the instruments table.  For NIFTY and BANKNIFTY options
 * instruments, Dhan typically provides:
 *
 *   - Daily OHLCV (GET /v2/charts/historical): multi-year lookback
 *   - 1-minute intraday (POST /v2/charts/intraday): up to ~5 trading days/request
 *   - 5-minute, 15-minute intraday: longer windows per request
 *
 * # Limitations (Dhan API)
 *
 *   1. Truly expired option contracts (security_ids no longer active) may return
 *      empty responses.  The service logs these per-instrument so the operator
 *      can see which instruments have data coverage and which do not.
 *   2. Intraday data is not available for dates more than ~6 months in the past
 *      on some instruments.  Daily candles have better historical coverage.
 *   3. Rate limits: 5 instruments processed in parallel per batch, 500 ms between
 *      batches (same as HistoricalCandleIngestionService).
 *
 * # Recommended usage for backtesting
 *
 *   Step 1: Backfill daily candles for a 1–2 year period:
 *     POST /backtest/backfill
 *     { "fromDate": "2023-01-01", "toDate": "2024-12-31",
 *       "granularity": "1d", "underlyingSymbol": "NIFTY" }
 *
 *   Step 2: Backfill 1-minute intraday data for recent months (for entry/exit precision):
 *     POST /backtest/backfill
 *     { "fromDate": "2024-10-01", "toDate": "2024-12-31",
 *       "granularity": "1m", "underlyingSymbol": "NIFTY" }
 *
 *   Step 3: Run the backtest via POST /backtest/run with trades derived from the
 *     fetched data (or use the signal scanner in paper mode against stored candles).
 *
 * Requirements: DEFECT-005 — historical data infrastructure
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { DhanExchangeSegment, DhanInstrumentType } from '../dhan/dhan-api.types';
import {
  HistoricalCandles,
  CandleGranularity,
} from '../../database/entities/historical-candles.entity';
import { Instruments } from '../../database/entities/instruments.entity';

// ─────────────────────────────────────────────────────────────────────────────
// DTOs and result types
// ─────────────────────────────────────────────────────────────────────────────

/** Request parameters for a historical backfill operation. */
export interface BackfillRequest {
  /** Start date (inclusive), YYYY-MM-DD format. */
  fromDate: string;
  /** End date (inclusive), YYYY-MM-DD format. */
  toDate: string;
  /**
   * Candle granularity.
   *   - '1d'  → daily candles via /v2/charts/historical (best for long lookbacks)
   *   - '1m'  → 1-minute candles via /v2/charts/intraday (best for recent ~90 days)
   *   - '5m'  → 5-minute candles (moderate lookback)
   *   - '15m' → 15-minute candles (longer lookback than 1m)
   */
  granularity: CandleGranularity;
  /**
   * Optional: Filter by instrument type (e.g. 'OPTIDX', 'FUTIDX', 'OPTSTK').
   * When omitted, all active tradeable instruments are processed.
   */
  instrumentType?: string;
  /**
   * Optional: Filter by underlying symbol (e.g. 'NIFTY', 'BANKNIFTY', 'FINNIFTY').
   * When omitted, all underlying symbols are processed.
   */
  underlyingSymbol?: string;
  /**
   * Optional: Explicit list of instrument UUIDs (from the instruments table).
   * When provided, instrumentType and underlyingSymbol filters are ignored.
   */
  instrumentIds?: string[];
  /**
   * When true, update existing candle rows on conflict instead of skipping.
   * Default: false (insert-only — idempotent).
   */
  overwrite?: boolean;
  /**
   * Maximum number of instruments to process (useful for testing the connection
   * before committing to a full multi-hour backfill).
   * Default: unlimited.
   */
  limit?: number;
}

/** Summary of a completed backfill operation. */
export interface BackfillResult {
  /** Total instruments attempted. */
  instrumentsAttempted: number;
  /** Instruments that returned at least one candle row. */
  instrumentsSucceeded: number;
  /**
   * Instruments that returned no data (API error or empty response).
   * Common causes: expired contract with no Dhan coverage, rate-limit hit.
   */
  instrumentsFailed: number;
  /** Total candle rows inserted (or updated if overwrite=true). */
  totalCandlesInserted: number;
  /** Candle rows skipped because they already existed (overwrite=false). */
  skippedExisting: number;
  /** Wall-clock duration of the full backfill operation. */
  durationMs: number;
  /** Per-instrument failure log (up to first 50 failures). */
  failedInstruments: Array<{
    id: string;
    tradingSymbol: string;
    securityId: string;
    reason: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Instruments processed per parallel batch. */
const BATCH_SIZE = 5;
/** Milliseconds to wait between batches. */
const INTER_BATCH_DELAY_MS = 500;

/**
 * Maximum calendar days per Dhan intraday API request.
 * Dhan typically limits intraday requests to ~5 trading days per call.
 * Using calendar days (7) gives ~5 trading days accounting for weekends.
 */
const INTRADAY_CHUNK_DAYS: Record<string, number> = {
  '1m': 7, // ~5 trading days
  '5m': 35, // ~25 trading days
  '15m': 90, // ~65 trading days
  '1d': 0, // no chunking — single request for entire range
};

/** Max failure details to include in the result (avoid huge payloads). */
const MAX_FAILURE_DETAILS = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class DhanHistoricalBackfillService {
  private readonly logger = new Logger(DhanHistoricalBackfillService.name);

  constructor(
    @InjectRepository(HistoricalCandles)
    private readonly candlesRepo: Repository<HistoricalCandles>,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
    private readonly dhanApiClient: DhanApiClient,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Backfill historical OHLCV candles for a date range using the Dhan API.
   *
   * Processes instruments in batches of 5 with a 500 ms inter-batch delay
   * to stay within Dhan API rate limits.
   *
   * For intraday granularities (1m, 5m, 15m), the date range is automatically
   * chunked into windows that fit within Dhan's per-request limits.
   *
   * @param request  Backfill parameters.
   * @returns BackfillResult summary.
   */
  async backfill(request: BackfillRequest): Promise<BackfillResult> {
    const startTime = Date.now();

    this.logger.log(
      `[Backfill] Starting — fromDate=${request.fromDate} toDate=${request.toDate} ` +
        `granularity=${request.granularity} ` +
        (request.underlyingSymbol ? `underlyingSymbol=${request.underlyingSymbol} ` : '') +
        (request.instrumentType ? `instrumentType=${request.instrumentType}` : ''),
    );

    // ── Load instruments ────────────────────────────────────────────────────
    const instruments = await this.loadInstruments(request);
    const target = request.limit ? instruments.slice(0, request.limit) : instruments;

    this.logger.log(`[Backfill] ${target.length} instruments to process`);

    if (target.length === 0) {
      this.logger.warn('[Backfill] No instruments matched the filter criteria — nothing to do');
      return {
        instrumentsAttempted: 0,
        instrumentsSucceeded: 0,
        instrumentsFailed: 0,
        totalCandlesInserted: 0,
        skippedExisting: 0,
        durationMs: Date.now() - startTime,
        failedInstruments: [],
      };
    }

    const result: BackfillResult = {
      instrumentsAttempted: target.length,
      instrumentsSucceeded: 0,
      instrumentsFailed: 0,
      totalCandlesInserted: 0,
      skippedExisting: 0,
      durationMs: 0,
      failedInstruments: [],
    };

    // ── Process in batches ──────────────────────────────────────────────────
    for (let batchStart = 0; batchStart < target.length; batchStart += BATCH_SIZE) {
      const batch = target.slice(batchStart, batchStart + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map((instrument) =>
          this.fetchAndStore(
            instrument,
            request.fromDate,
            request.toDate,
            request.granularity,
            request.overwrite ?? false,
          ),
        ),
      );

      for (let i = 0; i < batch.length; i++) {
        const instrument = batch[i];
        const batchResult = batchResults[i];

        if (batchResult.status === 'fulfilled' && batchResult.value.inserted > 0) {
          result.instrumentsSucceeded++;
          result.totalCandlesInserted += batchResult.value.inserted;
          result.skippedExisting += batchResult.value.skipped;
        } else {
          result.instrumentsFailed++;
          const reason =
            batchResult.status === 'rejected'
              ? (batchResult.reason as Error).message
              : `No data returned (Dhan API returned empty response for ${instrument.tradingSymbol})`;

          if (result.failedInstruments.length < MAX_FAILURE_DETAILS) {
            result.failedInstruments.push({
              id: instrument.id,
              tradingSymbol: instrument.tradingSymbol,
              securityId: instrument.securityId,
              reason,
            });
          }
        }
      }

      this.logger.log(
        `[Backfill] Batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/` +
          `${Math.ceil(target.length / BATCH_SIZE)} complete — ` +
          `succeeded=${result.instrumentsSucceeded} failed=${result.instrumentsFailed} ` +
          `candles=${result.totalCandlesInserted}`,
      );

      // Inter-batch delay (skip after last batch)
      if (batchStart + BATCH_SIZE < target.length) {
        await this.sleep(INTER_BATCH_DELAY_MS);
      }
    }

    result.durationMs = Date.now() - startTime;

    this.logger.log(
      `[Backfill] Complete — attempted=${result.instrumentsAttempted} ` +
        `succeeded=${result.instrumentsSucceeded} failed=${result.instrumentsFailed} ` +
        `candles=${result.totalCandlesInserted} skipped=${result.skippedExisting} ` +
        `duration=${(result.durationMs / 1000).toFixed(1)}s`,
    );

    if (result.instrumentsFailed > 0) {
      this.logger.warn(
        `[Backfill] ${result.instrumentsFailed} instrument(s) returned no data. ` +
          `Common reasons: expired contract with no Dhan historical coverage, ` +
          `instrument not listed on the exchange for the requested date range.`,
      );
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load the set of instruments to process based on the request filters.
   *
   * Priority:
   *   1. If instrumentIds provided → use those specific UUIDs (no QB created).
   *   2. If underlyingSymbol provided → filter by underlying symbol.
   *   3. If instrumentType provided → filter by instrument type.
   *   4. Otherwise → all active tradeable instruments.
   */
  private async loadInstruments(request: BackfillRequest): Promise<Instruments[]> {
    // ── Explicit IDs: bypass query builder entirely ──────────────────────────
    if (request.instrumentIds && request.instrumentIds.length > 0) {
      return this.instrumentsRepo.findByIds(request.instrumentIds);
    }

    // ── Filtered query ────────────────────────────────────────────────────────
    const qb = this.instrumentsRepo
      .createQueryBuilder('i')
      .where('i.is_active = true')
      .andWhere('i.is_tradable = true')
      .orderBy('i.liquidity_score', 'DESC');

    if (request.underlyingSymbol) {
      // DB column is `underlying` (not `underlying_symbol`).
      qb.andWhere('i.underlying = :sym', { sym: request.underlyingSymbol });
    }

    if (request.instrumentType) {
      qb.andWhere('i.instrument_type = :type', { type: request.instrumentType });
    }

    return qb.getMany();
  }

  /**
   * Fetch candles from Dhan and upsert into `historical_candles`.
   *
   * For intraday granularities, the date range is chunked into smaller windows.
   * Returns the number of rows inserted and skipped.
   */
  private async fetchAndStore(
    instrument: Instruments,
    fromDate: string,
    toDate: string,
    granularity: CandleGranularity,
    overwrite: boolean,
  ): Promise<{ inserted: number; skipped: number }> {
    const exchangeSegment = this.toExchangeSegment(instrument.exchange, instrument.segment);
    const dhanInstrumentType = this.toDhanInstrumentType(instrument.instrumentType);

    let totalInserted = 0;
    let totalSkipped = 0;

    if (granularity === '1d') {
      // ── Daily candles: single request for the full date range ───────────
      const count = await this.fetchDailyCandles(
        instrument,
        fromDate,
        toDate,
        exchangeSegment,
        dhanInstrumentType,
        overwrite,
      );
      if (count.inserted > 0 || count.skipped > 0) {
        totalInserted += count.inserted;
        totalSkipped += count.skipped;
      }
    } else {
      // ── Intraday candles: chunk the date range ───────────────────────────
      const chunkDays = INTRADAY_CHUNK_DAYS[granularity] ?? 7;
      const chunks = this.chunkDateRange(fromDate, toDate, chunkDays);
      const interval = granularity.replace('m', '') as '1' | '5' | '15' | '25' | '60';

      for (const [chunkFrom, chunkTo] of chunks) {
        const count = await this.fetchIntradayCandles(
          instrument,
          chunkFrom,
          chunkTo,
          interval,
          exchangeSegment,
          dhanInstrumentType,
          granularity,
          overwrite,
        );
        totalInserted += count.inserted;
        totalSkipped += count.skipped;

        // Small delay between chunks to avoid per-instrument rate limits
        if (chunks.length > 1) {
          await this.sleep(100);
        }
      }
    }

    return { inserted: totalInserted, skipped: totalSkipped };
  }

  /** Fetch daily candles from Dhan /v2/charts/historical. */
  private async fetchDailyCandles(
    instrument: Instruments,
    fromDate: string,
    toDate: string,
    exchangeSegment: DhanExchangeSegment,
    dhanInstrumentType: DhanInstrumentType,
    overwrite: boolean,
  ): Promise<{ inserted: number; skipped: number }> {
    let response: Awaited<ReturnType<typeof this.dhanApiClient.getHistoricalCandles>>;
    try {
      response = await this.dhanApiClient.getHistoricalCandles({
        securityId: instrument.securityId,
        exchangeSegment,
        instrument: dhanInstrumentType,
        fromDate,
        toDate,
      });
    } catch (err) {
      this.logger.debug(
        `[Backfill] Daily API error for ${instrument.tradingSymbol} ` +
          `(${instrument.securityId}): ${(err as Error).message}`,
      );
      return { inserted: 0, skipped: 0 };
    }

    return this.upsertCandles(instrument.id, '1d', response, overwrite);
  }

  /** Fetch intraday candles from Dhan /v2/charts/intraday. */
  private async fetchIntradayCandles(
    instrument: Instruments,
    fromDate: string,
    toDate: string,
    interval: '1' | '5' | '15' | '25' | '60',
    exchangeSegment: DhanExchangeSegment,
    dhanInstrumentType: DhanInstrumentType,
    granularity: CandleGranularity,
    overwrite: boolean,
  ): Promise<{ inserted: number; skipped: number }> {
    let response: Awaited<ReturnType<typeof this.dhanApiClient.getHistoricalCandles>>;
    try {
      response = await this.dhanApiClient.getHistoricalCandles({
        securityId: instrument.securityId,
        exchangeSegment,
        instrument: dhanInstrumentType,
        interval,
        fromDate,
        toDate,
      });
    } catch (err) {
      this.logger.debug(
        `[Backfill] Intraday API error for ${instrument.tradingSymbol} ` +
          `(${instrument.securityId}) ${fromDate}→${toDate}: ${(err as Error).message}`,
      );
      return { inserted: 0, skipped: 0 };
    }

    return this.upsertCandles(instrument.id, granularity, response, overwrite);
  }

  /**
   * Convert a Dhan candle response into DB rows and upsert them.
   *
   * Returns counts of inserted and skipped (conflict) rows.
   * Timestamps are in Unix epoch seconds in the Dhan response.
   */
  private async upsertCandles(
    instrumentId: string,
    granularity: CandleGranularity,
    response: Awaited<ReturnType<typeof this.dhanApiClient.getHistoricalCandles>>,
    overwrite: boolean,
  ): Promise<{ inserted: number; skipped: number }> {
    const { open, high, low, close, volume, timestamp, open_interest } = response;

    if (!timestamp || timestamp.length === 0) {
      return { inserted: 0, skipped: 0 };
    }

    const rows: Partial<HistoricalCandles>[] = [];
    for (let i = 0; i < timestamp.length; i++) {
      if (open[i] == null || close[i] == null) continue;

      rows.push({
        instrumentId,
        granularity,
        openPrice: String(open[i]),
        highPrice: String(high[i] ?? open[i]),
        lowPrice: String(low[i] ?? open[i]),
        closePrice: String(close[i]),
        volume: String(volume[i] ?? 0),
        oi: open_interest?.[i] != null ? String(open_interest[i]) : null,
        // Dhan epoch is in SECONDS — convert to milliseconds for JavaScript Date.
        timestamp: new Date(timestamp[i] * 1_000),
      });
    }

    if (rows.length === 0) return { inserted: 0, skipped: 0 };

    try {
      if (overwrite) {
        await this.candlesRepo
          .createQueryBuilder()
          .insert()
          .into(HistoricalCandles)
          .values(rows as HistoricalCandles[])
          .orUpdate(
            ['open_price', 'high_price', 'low_price', 'close_price', 'volume', 'oi'],
            ['instrument_id', 'granularity', 'timestamp'],
          )
          .execute();
        return { inserted: rows.length, skipped: 0 };
      } else {
        const result = await this.candlesRepo
          .createQueryBuilder()
          .insert()
          .into(HistoricalCandles)
          .values(rows as HistoricalCandles[])
          .orIgnore()
          .execute();
        const inserted = result.identifiers?.length ?? rows.length;
        return { inserted, skipped: rows.length - inserted };
      }
    } catch (err) {
      this.logger.error(
        `[Backfill] DB upsert failed for instrument ${instrumentId}: ${(err as Error).message}`,
      );
      return { inserted: 0, skipped: 0 };
    }
  }

  /**
   * Split a date range into chunks of at most `maxCalendarDays` each.
   *
   * Returns an array of [fromDate, toDate] pairs in YYYY-MM-DD format.
   * Used to stay within Dhan's per-request window limits for intraday data.
   */
  private chunkDateRange(
    fromDate: string,
    toDate: string,
    maxCalendarDays: number,
  ): [string, string][] {
    const chunks: [string, string][] = [];
    let current = new Date(`${fromDate}T00:00:00Z`);
    const end = new Date(`${toDate}T00:00:00Z`);

    while (current <= end) {
      const chunkEnd = new Date(current);
      chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxCalendarDays - 1);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());

      chunks.push([this.formatDate(current), this.formatDate(chunkEnd)]);
      current = new Date(chunkEnd);
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return chunks;
  }

  /** Format a Date as YYYY-MM-DD. */
  private formatDate(d: Date): string {
    return d.toISOString().split('T')[0];
  }

  /** Simple sleep utility. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Map instruments.exchange + instruments.segment to a Dhan exchange segment string.
   * Mirrors the private logic in HistoricalCandleIngestionService.
   */
  private toExchangeSegment(exchange: string, segment: string): DhanExchangeSegment {
    const key = `${exchange.toUpperCase()}_${segment.toUpperCase()}`;
    const MAP: Partial<Record<string, DhanExchangeSegment>> = {
      NSE_D: 'NSE_FNO',
      NSE_FO: 'NSE_FNO',
      NSE_FNO: 'NSE_FNO',
      NSE_EQ: 'NSE_EQ',
      BSE_D: 'BSE_FNO',
      BSE_FO: 'BSE_FNO',
      BSE_FNO: 'BSE_FNO',
      BSE_EQ: 'BSE_EQ',
      MCX_COMM: 'MCX_COMM',
      IDX_I: 'IDX_I',
      NSE_I: 'IDX_I',
    };
    return MAP[key] ?? 'NSE_FNO';
  }

  /**
   * Map instruments.instrumentType (entity values) to a Dhan DhanInstrumentType.
   *
   * Entity values: 'INDEX_OPTION' | 'STOCK_OPTION' | 'INDEX_FUTURE' | 'STOCK_FUTURE' | 'INDEX'
   * Dhan API values: 'OPTIDX' | 'OPTSTK' | 'FUTIDX' | 'FUTSTK' | ...
   */
  private toDhanInstrumentType(instrumentType: string): DhanInstrumentType {
    const MAP: Partial<Record<string, DhanInstrumentType>> = {
      INDEX_OPTION: 'OPTIDX',
      STOCK_OPTION: 'OPTSTK',
      INDEX_FUTURE: 'FUTIDX',
      STOCK_FUTURE: 'FUTSTK',
      INDEX: 'EQUITY',
      EQUITY: 'EQUITY',
      // Legacy Dhan segment codes (if stored directly)
      OPTIDX: 'OPTIDX',
      OPTSTK: 'OPTSTK',
      FUTIDX: 'FUTIDX',
      FUTSTK: 'FUTSTK',
      FUTCOM: 'FUTCOM',
    };
    return MAP[instrumentType.toUpperCase()] ?? 'OPTIDX';
  }
}
