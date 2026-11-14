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
  // Multi-timeframe candle loading
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load candles at all standard intraday timeframes for multi-timeframe
   * momentum analysis. Returns a map keyed by granularity, each array
   * in chronological order (oldest first).
   *
   * Granularities and limits:
   *   '1m'  — entry timing (last 100 candles)
   *   '5m'  — primary momentum confirmation (last 60 candles)
   *   '15m' — trend and structure (last 40 candles)
   *   '1d'  — broader trend context (last 30 candles)
   *
   * @param instrumentId  DB UUID of the underlying instrument.
   */
  async getMultiTimeframeCandles(
    instrumentId: string,
  ): Promise<Record<CandleGranularity, OHLCV[]>> {
    const [m1, m5, m15, daily] = await Promise.all([
      this.getRecentCandles(instrumentId, '1m', 100),
      this.getRecentCandles(instrumentId, '5m', 60),
      this.getRecentCandles(instrumentId, '15m', 40),
      this.getRecentCandles(instrumentId, '1d', 30),
    ]);
    return { '1m': m1, '5m': m5, '15m': m15, '1d': daily };
  }

  /**
   * Returns the previous trading day's 1-minute candles for computing
   * previous-day high/low support/resistance levels.
   *
   * "Previous day" = most recent completed weekday before today (IST).
   *
   * @param instrumentId  DB UUID of the instrument.
   */
  async getPreviousDayCandles(instrumentId: string): Promise<OHLCV[]> {
    const nowUtc = new Date();
    const nowIstMs = nowUtc.getTime() + IST_OFFSET_MS;
    const istDate = new Date(nowIstMs);

    const todayMidnightUtcMs =
      Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate()) -
      IST_OFFSET_MS;

    // Walk back to previous weekday
    const prevDay = new Date(todayMidnightUtcMs - 24 * 60 * 60 * 1000);
    while (prevDay.getUTCDay() === 0 || prevDay.getUTCDay() === 6) {
      prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    }
    const nextDay = new Date(prevDay.getTime() + 24 * 60 * 60 * 1000);

    try {
      const rows = await this.candlesRepo.find({
        where: {
          instrumentId,
          granularity: '1m' as CandleGranularity,
          timestamp: MoreThanOrEqual(prevDay),
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
      return rows
        .filter((r) => r.timestamp && r.timestamp.getTime() < nextDay.getTime())
        .map(this.toOHLCV);
    } catch (err) {
      this.logger.debug(
        `[CandleQuery] getPreviousDayCandles failed for ${instrumentId}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Convenience wrapper: returns previous day's high and low as a single
   * object, or null when no previous-day candles are available.
   *
   * @param instrumentId  DB UUID of the instrument.
   */
  async getPreviousDayHighLow(instrumentId: string): Promise<{ high: number; low: number } | null> {
    const candles = await this.getPreviousDayCandles(instrumentId);
    if (candles.length === 0) return null;
    const high = Math.max(...candles.map((c) => c.high));
    const low = Math.min(...candles.map((c) => c.low));
    return { high, low };
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
