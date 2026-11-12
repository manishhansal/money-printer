/**
 * historical-candle-ingestion.service.ts
 *
 * HistoricalCandleIngestionService — fetches intraday 1-minute OHLCV candles
 * from Dhan's /v2/charts/intraday API and upserts them into the
 * `historical_candles` table.
 *
 * Schedule:
 *  - On startup (`onModuleInit`): backfill today's candles for all active
 *    tradeable instruments (non-blocking, errors are logged not thrown).
 *  - Daily cron at 15:35 IST (Mon–Fri): ingest the full day's 1m candles
 *    after market close, before EOD reconciliation runs at 15:30.
 *
 * Rate-limiting:
 *  - Instruments are processed in batches of 5 with a 500ms inter-batch delay
 *    to stay well within Dhan's API rate limits.
 *  - Each instrument failure is caught and logged without blocking the batch.
 *
 * Requirements: Phase 1 — historical candle data for GET /market-data/candles
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { Instruments } from '../../database/entities/instruments.entity';
import {
  HistoricalCandles,
  CandleGranularity,
} from '../../database/entities/historical-candles.entity';

/** Instruments processed per batch (Dhan rate-limit friendly). */
const BATCH_SIZE = 5;
/** Delay between batches in milliseconds. */
const INTER_BATCH_DELAY_MS = 500;
/** Candle granularity to ingest (1-minute intraday). */
const INGEST_GRANULARITY: CandleGranularity = '1m';
/** Dhan interval string for 1-minute candles. */
const DHAN_INTERVAL = '1' as const;

@Injectable()
export class HistoricalCandleIngestionService implements OnModuleInit {
  private readonly logger = new Logger(HistoricalCandleIngestionService.name);

  constructor(
    private readonly dhanApiClient: DhanApiClient,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
    @InjectRepository(HistoricalCandles)
    private readonly candlesRepo: Repository<HistoricalCandles>,
  ) {}

  /**
   * On startup: backfill today's 1m candles for all active tradeable
   * instruments.  Runs asynchronously (fire-and-forget) with a 10-second
   * delay to allow DB connections to stabilise.
   */
  onModuleInit(): void {
    setTimeout(() => {
      void this.ingestTodayCandles();
    }, 10_000);
  }

  /**
   * Daily cron at 15:35 IST — ingest today's full 1m candle set after
   * market close.
   */
  @Cron('35 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async ingestEodCandles(): Promise<void> {
    this.logger.log("[CandleIngestion] EOD cron triggered — ingesting today's 1m candles");
    await this.ingestTodayCandles();
  }

  /**
   * Fetches and upserts 1-minute candles for all active tradeable instruments
   * for the current calendar date.
   *
   * Processes instruments in batches of BATCH_SIZE with an inter-batch delay
   * to stay within Dhan API rate limits.
   */
  async ingestTodayCandles(): Promise<void> {
    const today = this.formatDate(new Date());
    this.logger.log(`[CandleIngestion] Starting 1m candle ingestion for ${today}`);

    let instruments: Instruments[];
    try {
      instruments = await this.instrumentsRepo.find({
        where: { isActive: true, isTradable: true },
        select: { id: true, securityId: true, tradingSymbol: true, segment: true, exchange: true },
        // Limit to the top 500 most liquid instruments to avoid Dhan rate limits.
        // Full ingestion of 130k+ instruments would take hours and exhaust the rate quota.
        order: { liquidityScore: 'DESC' },
        take: 500,
      });
    } catch (err) {
      this.logger.error(`[CandleIngestion] Failed to load instruments: ${(err as Error).message}`);
      return;
    }

    if (instruments.length === 0) {
      this.logger.warn('[CandleIngestion] No active tradeable instruments found — skipping');
      return;
    }

    this.logger.log(
      `[CandleIngestion] Processing ${instruments.length} instruments in batches of ${BATCH_SIZE}`,
    );

    let ingested = 0;
    const skipped = 0;
    let errors = 0;

    // Process in batches
    for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
      const batch = instruments.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((instr) => this.ingestInstrumentCandles(instr, today, today)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          ingested += result.value;
        } else {
          errors++;
          this.logger.debug(`[CandleIngestion] Batch error: ${(result.reason as Error).message}`);
        }
      }

      // Inter-batch delay (skip after last batch)
      if (i + BATCH_SIZE < instruments.length) {
        await this.sleep(INTER_BATCH_DELAY_MS);
      }
    }

    this.logger.log(
      `[CandleIngestion] Done — ingested=${ingested} skipped=${skipped} errors=${errors}`,
    );
  }

  /**
   * Fetches and upserts 1m candles for a single instrument and date range.
   * Returns the number of candles upserted.
   */
  private async ingestInstrumentCandles(
    instrument: Instruments,
    fromDate: string,
    toDate: string,
  ): Promise<number> {
    const exchangeSegment = this.toExchangeSegment(instrument.exchange, instrument.segment);

    let response: Awaited<ReturnType<typeof this.dhanApiClient.getHistoricalCandles>>;
    try {
      response = await this.dhanApiClient.getHistoricalCandles({
        securityId: instrument.securityId,
        exchangeSegment,
        instrument: 'OPTIDX',
        interval: DHAN_INTERVAL,
        fromDate,
        toDate,
      });
    } catch (err) {
      this.logger.debug(
        `[CandleIngestion] Dhan API error for ${instrument.tradingSymbol}: ${(err as Error).message}`,
      );
      return 0;
    }

    const { open, high, low, close, volume, timestamp, open_interest } = response;
    if (!timestamp || timestamp.length === 0) return 0;

    // Build candle rows — skip if any OHLC value is missing
    const rows: Partial<HistoricalCandles>[] = [];
    for (let i = 0; i < timestamp.length; i++) {
      if (open[i] == null || close[i] == null) continue;
      rows.push({
        instrumentId: instrument.id,
        granularity: INGEST_GRANULARITY,
        openPrice: String(open[i]),
        highPrice: String(high[i]),
        lowPrice: String(low[i]),
        closePrice: String(close[i]),
        volume: String(volume[i] ?? 0),
        oi: open_interest?.[i] != null ? String(open_interest[i]) : null,
        timestamp: new Date(timestamp[i] * 1_000), // Dhan epoch is in seconds
      });
    }

    if (rows.length === 0) return 0;

    // Upsert — ON CONFLICT DO NOTHING (unique constraint on instrumentId + granularity + timestamp)
    await this.candlesRepo
      .createQueryBuilder()
      .insert()
      .into(HistoricalCandles)
      .values(rows as HistoricalCandles[])
      .orIgnore()
      .execute();

    return rows.length;
  }

  /** Convert exchange + segment to Dhan exchangeSegment string. */
  private toExchangeSegment(
    exchange: string,
    segment: string,
  ): import('../dhan/dhan-api.types').DhanExchangeSegment {
    const key = `${exchange.toUpperCase()}_${segment.toUpperCase()}`;
    const map: Record<string, string> = {
      NSE_FO: 'NSE_FNO',
      NSE_EQ: 'NSE_EQ',
      BSE_FO: 'BSE_FNO',
      IDX_I: 'IDX_I',
    };
    return (map[key] ?? 'NSE_FNO') as import('../dhan/dhan-api.types').DhanExchangeSegment;
  }

  /** Format a Date to YYYY-MM-DD. */
  private formatDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
