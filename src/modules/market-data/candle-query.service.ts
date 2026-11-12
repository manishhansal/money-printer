/**
 * candle-query.service.ts
 *
 * CandleQueryService — read-only access to the `historical_candles` table.
 *
 * Responsibilities:
 *  - Convert raw NUMERIC/BIGINT DB strings to the `OHLCV` number interface
 *    expected by TechnicalAnalysisService.
 *  - Provide efficient "latest N candles" and "today's candles" query helpers
 *    so callers never deal with raw HistoricalCandles entities directly.
 *  - Return empty arrays (never null) when no data is available, so callers
 *    can pass the result directly to TechnicalAnalysisService methods that
 *    gracefully return null when given insufficient candles.
 *
 * Design note:
 *   This service is intentionally a thin adapter over the TypeORM repo. All
 *   indicator computation is delegated to TechnicalAnalysisService; this
 *   service only handles the data-access and type-mapping concern.
 *
 * Requirements: DEFECT-002 fix — provides candle data for real indicator
 * computation in SignalScannerService.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import {
  HistoricalCandles,
  CandleGranularity,
} from '../../database/entities/historical-candles.entity';
import { OHLCV } from '../technical-analysis/technical-analysis.types';

/** IST offset in milliseconds (UTC+05:30). */
const IST_OFFSET_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000;

@Injectable()
export class CandleQueryService {
  private readonly logger = new Logger(CandleQueryService.name);

  constructor(
    @InjectRepository(HistoricalCandles)
    private readonly candlesRepo: Repository<HistoricalCandles>,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public query helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the most recent `limit` candles for an instrument at a given
   * granularity, sorted oldest-first so they are ready for direct use by
   * TechnicalAnalysisService methods that require chronological order.
   *
   * Returns an empty array when no candles exist in the table.
   *
   * @param instrumentId  DB UUID of the instrument.
   * @param granularity   Candle period ('1m' | '5m' | '15m' | '1d').
   * @param limit         Maximum number of candles to return (most recent first
   *                      in DB query, then reversed to oldest-first for TA use).
   */
  async getRecentCandles(
    instrumentId: string,
    granularity: CandleGranularity,
    limit: number,
  ): Promise<OHLCV[]> {
    try {
      const rows = await this.candlesRepo.find({
        where: { instrumentId, granularity },
        order: { timestamp: 'DESC' },
        take: limit,
        select: {
          openPrice: true,
          highPrice: true,
          lowPrice: true,
          closePrice: true,
          volume: true,
          timestamp: true,
        },
      });

      // Reverse to chronological (oldest first) order required by TA methods.
      return rows.reverse().map(this.toOHLCV);
    } catch (err) {
      this.logger.debug(
        `[CandleQuery] getRecentCandles failed for ${instrumentId}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Returns all 1-minute candles for an instrument from midnight IST today
   * onwards.  Used to compute intraday indicators (VWAP, ORB, intraday EMA)
   * in the signal scanner.
   *
   * Returns an empty array when today's candles have not yet been ingested.
   *
   * @param instrumentId  DB UUID of the instrument.
   */
  async getTodayCandles(instrumentId: string): Promise<OHLCV[]> {
    // Compute midnight IST for today as a UTC Date.
    const nowUtc = new Date();
    const nowIstMs = nowUtc.getTime() + IST_OFFSET_MS;
    const istDate = new Date(nowIstMs);
    // Zero out IST time components to get midnight IST.
    const midnightIstMs =
      Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate()) -
      IST_OFFSET_MS;
    const midnightIst = new Date(midnightIstMs);

    try {
      const rows = await this.candlesRepo.find({
        where: {
          instrumentId,
          granularity: '1m' as CandleGranularity,
          timestamp: MoreThanOrEqual(midnightIst),
        },
        order: { timestamp: 'ASC' },
        select: {
          openPrice: true,
          highPrice: true,
          lowPrice: true,
          closePrice: true,
          volume: true,
          timestamp: true,
        },
      });

      return rows.map(this.toOHLCV);
    } catch (err) {
      this.logger.debug(
        `[CandleQuery] getTodayCandles failed for ${instrumentId}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Returns `lookbackDays + 1` days worth of 1-minute candles for an
   * instrument (today + prior N days).  Used by
   * TechnicalAnalysisService.computeRelativeVolume().
   *
   * @param instrumentId  DB UUID of the instrument.
   * @param lookbackDays  Number of historical days to include (default: 5).
   */
  async getMultiDayCandles(instrumentId: string, lookbackDays = 5): Promise<OHLCV[]> {
    // Go back (lookbackDays + 1) days from midnight IST.
    const nowUtc = new Date();
    const nowIstMs = nowUtc.getTime() + IST_OFFSET_MS;
    const istDate = new Date(nowIstMs);
    const cutoffUtcMs =
      Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate()) -
      IST_OFFSET_MS -
      lookbackDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffUtcMs);

    try {
      const rows = await this.candlesRepo.find({
        where: {
          instrumentId,
          granularity: '1m' as CandleGranularity,
          timestamp: MoreThanOrEqual(cutoff),
        },
        order: { timestamp: 'ASC' },
        select: {
          openPrice: true,
          highPrice: true,
          lowPrice: true,
          closePrice: true,
          volume: true,
          timestamp: true,
        },
      });

      return rows.map(this.toOHLCV);
    } catch (err) {
      this.logger.debug(
        `[CandleQuery] getMultiDayCandles failed for ${instrumentId}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Maps a raw `HistoricalCandles` row to the `OHLCV` interface.
   *
   * TypeORM returns NUMERIC columns as strings and BIGINT as strings.
   * TechnicalAnalysisService expects plain JavaScript numbers.
   */
  private readonly toOHLCV = (row: Partial<HistoricalCandles>): OHLCV => ({
    open: parseFloat(row.openPrice ?? '0'),
    high: parseFloat(row.highPrice ?? '0'),
    low: parseFloat(row.lowPrice ?? '0'),
    close: parseFloat(row.closePrice ?? '0'),
    volume: parseFloat(row.volume ?? '0'),
    timestamp: row.timestamp ?? new Date(0),
  });
}
