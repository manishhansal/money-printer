/**
 * dhan-rolling-option-backfill.service.ts
 *
 * DhanRollingOptionBackfillService — resumable chunked backfill of expired /
 * rolling option historical data using POST /v2/charts/rollingoption.
 *
 * # What this service does
 *
 * Fetches ATM-relative historical option OHLCV + IV + OI + spot data for a
 * specified underlying, expiry type, strike range and date range, persisting
 * it to the `rolling_option_candles` table with idempotent upsert semantics.
 *
 * # Why rolling data, not fixed-contract data
 *
 * Dhan's `/v2/charts/rollingoption` endpoint continuously re-indexes options
 * relative to the ATM strike at each timestamp.  This eliminates the need to
 * enumerate thousands of expired contract security IDs — the API does the
 * rolling stitching server-side.  Backtest logic must therefore interpret each
 * candle's `actualStrike` to reconstruct which absolute contract was active.
 *
 * # Request window constraint
 *
 * Dhan documents a maximum of 30 calendar days per request.  This service
 * automatically chunks the requested date range into ≤ 30-day windows.
 *
 * # Resumability
 *
 * The service persists each chunk as it completes.  If interrupted, re-running
 * the same request will skip already-persisted candles (ON CONFLICT DO NOTHING)
 * and continue from the first missing chunk.  The result summary reports
 * per-chunk success/failure so the operator can identify gaps.
 *
 * # Rate limits
 *
 * Uses the DhanApiClient's built-in circuit breaker and rate-limit queue.
 * An inter-chunk delay of 500 ms prevents burst flooding.
 *
 * Requirements: Phase 2 — Dhan Historical Backfill (rolling / expired options)
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DhanApiClient } from '../dhan/dhan-api.client';
import {
  DhanRollingOptionRequest,
  DhanRollingOptionLeg,
  DhanRollingOptionStrike,
} from '../dhan/dhan-api.types';
import {
  RollingOptionCandles,
  RollingStrikeOffset,
} from '../../database/entities/rolling-option-candles.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum calendar days per Dhan rolling option request (documented limit). */
const CHUNK_DAYS = 30;

/** Milliseconds to wait between successive API chunks. */
const INTER_CHUNK_DELAY_MS = 500;

/** All data fields to request (fetching everything avoids repeat backfills). */
const ALL_REQUIRED_DATA: DhanRollingOptionRequest['requiredData'] = [
  'open',
  'high',
  'low',
  'close',
  'iv',
  'volume',
  'strike',
  'oi',
  'spot',
];

/** Strike ranges by instrument type (per Dhan documentation). */
const STRIKE_RANGES: Record<'OPTIDX' | 'OPTSTK', RollingStrikeOffset[]> = {
  OPTIDX: [
    'ATM-10',
    'ATM-9',
    'ATM-8',
    'ATM-7',
    'ATM-6',
    'ATM-5',
    'ATM-4',
    'ATM-3',
    'ATM-2',
    'ATM-1',
    'ATM',
    'ATM+1',
    'ATM+2',
    'ATM+3',
    'ATM+4',
    'ATM+5',
    'ATM+6',
    'ATM+7',
    'ATM+8',
    'ATM+9',
    'ATM+10',
  ],
  OPTSTK: ['ATM-3', 'ATM-2', 'ATM-1', 'ATM', 'ATM+1', 'ATM+2', 'ATM+3'],
};

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

/** Parameters for one backfill job. */
export interface RollingOptionBackfillRequest {
  /** Underlying security ID (e.g. '13' for NIFTY, '25' for BANKNIFTY). */
  securityId: string;
  /** Human-readable symbol for logging (e.g. 'NIFTY'). */
  underlyingSymbol: string;
  /** Exchange segment of the OPTION contract (e.g. 'NSE_FNO'). */
  exchangeSegment: string;
  /** Instrument type: index or stock option. */
  instrument: 'OPTIDX' | 'OPTSTK';
  /** Expiry type: weekly or monthly. */
  expiryFlag: 'WEEK' | 'MONTH';
  /** Expiry ordinal: 0 = current, 1 = next. Default: 0. */
  expiryCode?: 0 | 1 | 2 | 3;
  /** Option type(s) to fetch. Default: both CALL and PUT. */
  optionTypes?: Array<'CALL' | 'PUT'>;
  /**
   * Strike offsets to fetch.
   * Default: full range for the instrument type (ATM±10 for index, ATM±3 for stocks).
   * Pass a narrower list for a faster targeted backfill.
   */
  strikeOffsets?: RollingStrikeOffset[];
  /** Candle interval in minutes. Default: '5'. */
  interval?: '1' | '5' | '15' | '25' | '60';
  /** Range start, YYYY-MM-DD. */
  fromDate: string;
  /** Range end, YYYY-MM-DD (inclusive for the caller; service adds +1 day for the non-inclusive API). */
  toDate: string;
  /**
   * When true, overwrite existing rows on conflict.
   * Default: false (insert-only — idempotent on re-run).
   */
  overwrite?: boolean;
}

/** Per-chunk result entry. */
export interface ChunkResult {
  fromDate: string;
  toDate: string;
  strikeOffset: RollingStrikeOffset;
  optionType: 'CE' | 'PE';
  candlesInserted: number;
  skipped: number;
  error: string | null;
}

/** Overall backfill result. */
export interface RollingOptionBackfillResult {
  securityId: string;
  underlyingSymbol: string;
  fromDate: string;
  toDate: string;
  totalCandlesInserted: number;
  totalSkipped: number;
  totalErrors: number;
  durationMs: number;
  chunks: ChunkResult[];
  coverageGaps: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class DhanRollingOptionBackfillService {
  private readonly logger = new Logger(DhanRollingOptionBackfillService.name);

  constructor(
    @InjectRepository(RollingOptionCandles)
    private readonly repo: Repository<RollingOptionCandles>,
    private readonly dhanApiClient: DhanApiClient,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute a resumable chunked backfill of rolling option historical data.
   *
   * Fetches every combination of (strikeOffset × optionType) over the
   * requested date range in ≤ 30-day chunks, persisting results as they
   * arrive.  Idempotent: re-running with the same parameters will skip
   * already-persisted candles.
   */
  async backfill(request: RollingOptionBackfillRequest): Promise<RollingOptionBackfillResult> {
    const startMs = Date.now();
    const {
      securityId,
      underlyingSymbol,
      exchangeSegment,
      instrument,
      expiryFlag,
      expiryCode = 0,
      optionTypes = ['CALL', 'PUT'],
      interval = '5',
      overwrite = false,
    } = request;

    const strikeOffsets = request.strikeOffsets ?? STRIKE_RANGES[instrument];
    const dateChunks = this.chunkDateRange(request.fromDate, request.toDate, CHUNK_DAYS);

    this.logger.log(
      `[RollingBackfill] Starting: ${underlyingSymbol} ${instrument} ${expiryFlag} ` +
        `${request.fromDate}→${request.toDate} | ` +
        `strikes=${strikeOffsets.length} types=${optionTypes.join('+')} ` +
        `chunks=${dateChunks.length} interval=${interval}m`,
    );

    const allChunks: ChunkResult[] = [];
    let totalInserted = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const strikeOffset of strikeOffsets) {
      for (const optType of optionTypes) {
        for (const chunk of dateChunks) {
          const result = await this.fetchAndPersistChunk({
            securityId,
            underlyingSymbol,
            exchangeSegment,
            instrument,
            expiryFlag,
            expiryCode,
            strikeOffset,
            optionType: optType,
            interval,
            fromDate: chunk.from,
            toDate: chunk.to,
            overwrite,
          });

          allChunks.push(result);
          totalInserted += result.candlesInserted;
          totalSkipped += result.skipped;
          if (result.error) totalErrors++;

          if (result.error) {
            this.logger.warn(
              `[RollingBackfill] Chunk FAILED: ${strikeOffset} ${optType} ` +
                `${chunk.from}→${chunk.to}: ${result.error}`,
            );
          } else {
            this.logger.debug(
              `[RollingBackfill] Chunk OK: ${strikeOffset} ${optType} ` +
                `${chunk.from}→${chunk.to}: +${result.candlesInserted} rows`,
            );
          }

          await this.sleep(INTER_CHUNK_DELAY_MS);
        }
      }
    }

    const coverageGaps = this.detectCoverageGaps(allChunks);
    const durationMs = Date.now() - startMs;

    this.logger.log(
      `[RollingBackfill] Complete: ${underlyingSymbol} ` +
        `inserted=${totalInserted} skipped=${totalSkipped} errors=${totalErrors} ` +
        `gaps=${coverageGaps.length} duration=${durationMs}ms`,
    );

    return {
      securityId,
      underlyingSymbol,
      fromDate: request.fromDate,
      toDate: request.toDate,
      totalCandlesInserted: totalInserted,
      totalSkipped,
      totalErrors,
      durationMs,
      chunks: allChunks,
      coverageGaps,
    };
  }

  /**
   * Query persisted coverage for a given underlying and date range.
   * Returns the count of rows available per (strikeOffset, optionType) combination.
   */
  async getCoverage(
    securityId: string,
    expiryFlag: 'WEEK' | 'MONTH',
    fromDate: string,
    toDate: string,
  ): Promise<Record<string, number>> {
    const rows = await this.repo
      .createQueryBuilder('r')
      .select(['r.strike_offset', 'r.option_type', 'COUNT(*) as count'])
      .where('r.underlyingSecurityId = :securityId', { securityId })
      .andWhere('r.expiryFlag = :expiryFlag', { expiryFlag })
      .andWhere('r.timestamp >= :from', { from: fromDate })
      .andWhere('r.timestamp < :to', { to: toDate })
      .groupBy('r.strike_offset, r.option_type')
      .getRawMany<{ strike_offset: string; option_type: string; count: string }>();

    const coverage: Record<string, number> = {};
    for (const row of rows) {
      coverage[`${row.strike_offset}:${row.option_type}`] = parseInt(row.count, 10);
    }
    return coverage;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async fetchAndPersistChunk(params: {
    securityId: string;
    underlyingSymbol: string;
    exchangeSegment: string;
    instrument: 'OPTIDX' | 'OPTSTK';
    expiryFlag: 'WEEK' | 'MONTH';
    expiryCode: 0 | 1 | 2 | 3;
    strikeOffset: RollingStrikeOffset;
    optionType: 'CALL' | 'PUT';
    interval: '1' | '5' | '15' | '25' | '60';
    fromDate: string;
    toDate: string;
    overwrite: boolean;
  }): Promise<ChunkResult> {
    const ce = params.optionType === 'CALL' ? 'CE' : 'PE';

    // Dhan toDate is non-inclusive; add 1 day to include the user's toDate.
    const apiToDate = this.addDays(params.toDate, 1);

    const apiRequest: DhanRollingOptionRequest = {
      exchangeSegment: params.exchangeSegment as DhanRollingOptionRequest['exchangeSegment'],
      interval: params.interval,
      securityId: params.securityId,
      instrument: params.instrument,
      expiryFlag: params.expiryFlag,
      expiryCode: params.expiryCode,
      strike: params.strikeOffset as DhanRollingOptionStrike,
      drvOptionType: params.optionType,
      requiredData: ALL_REQUIRED_DATA,
      fromDate: params.fromDate,
      toDate: apiToDate,
    };

    try {
      const response = await this.dhanApiClient.getRollingOptionData(apiRequest);

      const leg: DhanRollingOptionLeg | null =
        params.optionType === 'CALL' ? response.data.ce : response.data.pe;

      if (!leg || !leg.timestamp || leg.timestamp.length === 0) {
        return {
          fromDate: params.fromDate,
          toDate: params.toDate,
          strikeOffset: params.strikeOffset,
          optionType: ce,
          candlesInserted: 0,
          skipped: 0,
          error: null, // Empty response — no data for this period (not an error)
        };
      }

      const rows = this.buildRows(params, leg, ce);
      const { inserted, skipped } = await this.upsertRows(rows, params.overwrite);

      return {
        fromDate: params.fromDate,
        toDate: params.toDate,
        strikeOffset: params.strikeOffset,
        optionType: ce,
        candlesInserted: inserted,
        skipped,
        error: null,
      };
    } catch (err) {
      return {
        fromDate: params.fromDate,
        toDate: params.toDate,
        strikeOffset: params.strikeOffset,
        optionType: ce,
        candlesInserted: 0,
        skipped: 0,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Build RollingOptionCandles rows from a Dhan API leg response.
   * Validates OHLC relationships and marks suspicious candles.
   */
  private buildRows(
    params: {
      securityId: string;
      underlyingSymbol: string;
      exchangeSegment: string;
      instrument: 'OPTIDX' | 'OPTSTK';
      expiryFlag: 'WEEK' | 'MONTH';
      expiryCode: number;
      strikeOffset: RollingStrikeOffset;
      interval: string;
    },
    leg: DhanRollingOptionLeg,
    optionType: 'CE' | 'PE',
  ): Partial<RollingOptionCandles>[] {
    const fetchedAt = new Date();
    const rows: Partial<RollingOptionCandles>[] = [];

    for (let i = 0; i < leg.timestamp.length; i++) {
      const ts = leg.timestamp[i];
      if (!ts) continue;

      // Dhan returns Unix epoch seconds; convert to milliseconds for Date.
      const timestamp = new Date(ts * 1_000);

      const open = leg.open?.[i] ?? null;
      const high = leg.high?.[i] ?? null;
      const low = leg.low?.[i] ?? null;
      const close = leg.close?.[i] ?? null;
      const volume = leg.volume?.[i] ?? null;
      const iv = leg.iv?.[i] ?? null;
      const oi = leg.oi?.[i] ?? null;
      const strike = leg.strike?.[i] ?? null;
      const spot = leg.spot?.[i] ?? null;

      // Validate OHLC relationships.
      let dataQuality: RollingOptionCandles['dataQuality'] = 'ok';
      if (
        open !== null &&
        high !== null &&
        low !== null &&
        close !== null &&
        (high < low || high < open || high < close || low > open || low > close)
      ) {
        dataQuality = 'suspicious';
      } else if (open === null || close === null) {
        dataQuality = 'missing_fields';
      }

      rows.push({
        underlyingSecurityId: params.securityId,
        underlyingSymbol: params.underlyingSymbol,
        exchangeSegment: params.exchangeSegment,
        instrumentType: params.instrument,
        expiryFlag: params.expiryFlag,
        expiryCode: params.expiryCode,
        strikeOffset: params.strikeOffset,
        optionType,
        interval: params.interval as RollingOptionCandles['interval'],
        timestamp,
        openPrice: open !== null ? String(open) : null,
        highPrice: high !== null ? String(high) : null,
        lowPrice: low !== null ? String(low) : null,
        closePrice: close !== null ? String(close) : null,
        volume: volume !== null ? String(volume) : null,
        impliedVolatility: iv !== null ? String(iv) : null,
        openInterest: oi !== null ? String(oi) : null,
        actualStrike: strike !== null ? String(strike) : null,
        spotPrice: spot !== null ? String(spot) : null,
        dataQuality,
        fetchedAt,
        dataSourceVersion: 'v2',
      });
    }

    return rows;
  }

  /**
   * Persist rows to the database using either insert-ignore or upsert.
   * Returns the count of inserted and skipped rows.
   */
  private async upsertRows(
    rows: Partial<RollingOptionCandles>[],
    overwrite: boolean,
  ): Promise<{ inserted: number; skipped: number }> {
    if (rows.length === 0) return { inserted: 0, skipped: 0 };

    const BATCH = 500;
    let totalInserted = 0;
    let totalSkipped = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      try {
        if (overwrite) {
          await this.repo
            .createQueryBuilder()
            .insert()
            .into(RollingOptionCandles)
            .values(batch as RollingOptionCandles[])
            .orUpdate(
              [
                'open_price',
                'high_price',
                'low_price',
                'close_price',
                'volume',
                'implied_volatility',
                'open_interest',
                'actual_strike',
                'spot_price',
                'data_quality',
                'fetched_at',
              ],
              [
                'underlying_security_id',
                'expiry_flag',
                'expiry_code',
                'strike_offset',
                'option_type',
                'interval',
                'timestamp',
              ],
            )
            .execute();
          totalInserted += batch.length;
        } else {
          const result = await this.repo
            .createQueryBuilder()
            .insert()
            .into(RollingOptionCandles)
            .values(batch as RollingOptionCandles[])
            .orIgnore()
            .execute();
          const inserted = result.identifiers.filter((id) => id.id).length;
          totalInserted += inserted;
          totalSkipped += batch.length - inserted;
        }
      } catch (err) {
        this.logger.warn(
          `[RollingBackfill] Batch persist failed (${batch.length} rows): ${(err as Error).message}`,
        );
        totalSkipped += batch.length;
      }
    }

    return { inserted: totalInserted, skipped: totalSkipped };
  }

  /**
   * Chunk a date range into windows of at most maxDays calendar days.
   * Returns an array of { from, to } pairs in YYYY-MM-DD format.
   * Both `from` and `to` are INCLUSIVE dates for the caller's perspective.
   */
  private chunkDateRange(
    fromDate: string,
    toDate: string,
    maxDays: number,
  ): Array<{ from: string; to: string }> {
    const chunks: Array<{ from: string; to: string }> = [];
    let cursor = new Date(`${fromDate}T00:00:00Z`);
    const end = new Date(`${toDate}T00:00:00Z`);

    while (cursor <= end) {
      const chunkEnd = new Date(cursor);
      chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());

      chunks.push({
        from: this.formatDate(cursor),
        to: this.formatDate(chunkEnd),
      });

      cursor = new Date(chunkEnd);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return chunks;
  }

  /**
   * Detect date gaps in the chunk results — windows where every
   * (strikeOffset × optionType) combination returned an error.
   */
  private detectCoverageGaps(chunks: ChunkResult[]): string[] {
    const gaps: string[] = [];
    // Group by date window
    const byWindow = new Map<string, ChunkResult[]>();
    for (const c of chunks) {
      const key = `${c.fromDate}:${c.toDate}`;
      if (!byWindow.has(key)) byWindow.set(key, []);
      byWindow.get(key)!.push(c);
    }
    for (const [window, results] of byWindow) {
      const allErrored = results.every((r) => r.error !== null);
      if (allErrored) {
        gaps.push(window.replace(':', ' → '));
      }
    }
    return gaps;
  }

  /** Add N calendar days to a YYYY-MM-DD string. */
  private addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return this.formatDate(d);
  }

  /** Format a Date as YYYY-MM-DD (UTC). */
  private formatDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
