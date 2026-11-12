/**
 * historical-data-import.service.ts
 *
 * HistoricalDataImportService — CSV import pipeline for historical NSE options
 * candle data into the `historical_candles` table.
 *
 * # Purpose (DEFECT-005 partial fix)
 *
 * DEFECT-005 (P0) is classified as BLOCKED_EXTERNAL: strategy profitability
 * cannot be established without historical expired NSE options data.  This
 * service provides the import infrastructure so that once an operator sources
 * real historical data, it can be loaded into the system without code changes.
 *
 * # What this service does NOT do
 *
 * - It does NOT fabricate historical data.
 * - It does NOT claim backtest validity for imported data without operator
 *   verification of data quality.
 * - It does NOT enable backtesting on synthetic/incomplete data.
 *
 * # Required CSV format (documented here as the data contract)
 *
 * ```csv
 * instrument_id,granularity,timestamp,open,high,low,close,volume,oi
 * <uuid>,1m,2024-01-15T09:15:00+05:30,245.50,247.00,244.75,246.25,1250000,
 * <uuid>,1m,2024-01-15T09:16:00+05:30,246.25,248.50,245.90,247.80,890000,
 * ```
 *
 * Fields:
 *   instrument_id  — UUID from the instruments table (must exist as FK)
 *   granularity    — "1m" | "5m" | "15m" | "1d"
 *   timestamp      — ISO 8601 with timezone (IST preferred: +05:30)
 *   open/high/low/close — price in INR (decimal, up to 2dp)
 *   volume         — integer (lot units)
 *   oi             — open interest (integer, optional — leave blank for equities)
 *
 * # Data sources for real historical NSE options data
 *
 *   1. NSE Bharat (https://www.nseindia.com/report-detail/eq_bhavcopy_csv)
 *      — Free end-of-day data, requires parsing into the above format.
 *   2. Truedata (https://truedata.in/) — Paid intraday F&O tick/OHLCV data.
 *   3. Dhan historical API (https://dhanhq.co/docs/v2/historical-candles/)
 *      — Covered by HistoricalCandleIngestionService for current/recent data.
 *      — Does NOT provide expired-contract historical data beyond ~90 days.
 *   4. OpenAlgo / Zerodha Kite Connect — Alternative paid data sources.
 *
 * # Validation performed before import
 *
 *   - instrument_id must exist in the instruments table (FK check)
 *   - granularity must be one of: "1m", "5m", "15m", "1d"
 *   - timestamp must be a valid ISO date after 2010-01-01
 *   - open, high, low, close must all be positive
 *   - high >= max(open, close), low <= min(open, close)
 *   - volume >= 0
 *
 * # Deduplication
 *
 *   Import uses INSERT ... ON CONFLICT DO NOTHING on the UNIQUE constraint
 *   (instrument_id, granularity, timestamp), so re-running an import is
 *   idempotent.  To UPDATE existing rows, use the `overwrite` flag.
 *
 * Requirements: DEFECT-005 (partial) — historical data import infrastructure
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as readline from 'readline';
import {
  HistoricalCandles,
  CandleGranularity,
} from '../../database/entities/historical-candles.entity';
import { Instruments } from '../../database/entities/instruments.entity';

/** Summary of a completed import run. */
export interface ImportResult {
  /** Total rows in the CSV file (excluding header). */
  totalRows: number;
  /** Rows that passed validation and were attempted for insert. */
  validRows: number;
  /** Rows successfully inserted into the DB. */
  insertedRows: number;
  /** Rows skipped because a conflicting row already exists. */
  skippedDuplicates: number;
  /** Rows that failed validation — includes reason. */
  validationErrors: Array<{ row: number; reason: string; data: string }>;
  /** Rows that failed DB insert with an unexpected error. */
  dbErrors: Array<{ row: number; reason: string }>;
}

/** OHLCV CSV row after parsing. */
interface CsvRow {
  instrumentId: string;
  granularity: CandleGranularity;
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  oi: string | null;
}

/** Expected CSV column names (case-insensitive). */
const EXPECTED_HEADERS = [
  'instrument_id',
  'granularity',
  'timestamp',
  'open',
  'high',
  'low',
  'close',
  'volume',
];

const VALID_GRANULARITIES = new Set<string>(['1m', '5m', '15m', '1d']);
const MIN_VALID_TIMESTAMP_MS = new Date('2010-01-01T00:00:00Z').getTime();
const BATCH_INSERT_SIZE = 500;

@Injectable()
export class HistoricalDataImportService {
  private readonly logger = new Logger(HistoricalDataImportService.name);

  constructor(
    @InjectRepository(HistoricalCandles)
    private readonly candlesRepo: Repository<HistoricalCandles>,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Import OHLCV candle data from a CSV file into the `historical_candles` table.
   *
   * The file is read line-by-line to avoid loading large CSVs into memory.
   * Rows are inserted in batches of BATCH_INSERT_SIZE (500) for efficiency.
   *
   * @param csvFilePath  Absolute or relative path to the CSV file.
   * @param overwrite    When true, UPDATE existing rows on conflict instead of
   *                     skipping them.  Defaults to false (insert-only).
   * @returns ImportResult summary.
   */
  async importFromCsv(csvFilePath: string, overwrite = false): Promise<ImportResult> {
    this.logger.log(`[DataImport] Starting import from ${csvFilePath} (overwrite=${overwrite})`);

    // ── Validate file exists ───────────────────────────────────────────────
    if (!fs.existsSync(csvFilePath)) {
      throw new Error(`CSV file not found: ${csvFilePath}`);
    }

    const result: ImportResult = {
      totalRows: 0,
      validRows: 0,
      insertedRows: 0,
      skippedDuplicates: 0,
      validationErrors: [],
      dbErrors: [],
    };

    // ── Pre-load valid instrument IDs ──────────────────────────────────────
    // Validate FK before attempting inserts (avoids FK violation errors).
    const knownInstrumentIds = await this.loadKnownInstrumentIds();
    this.logger.log(`[DataImport] Loaded ${knownInstrumentIds.size} known instrument UUIDs`);

    // ── Parse CSV line by line ─────────────────────────────────────────────
    const fileStream = fs.createReadStream(csvFilePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let headerProcessed = false;
    let columnMap: Map<string, number> | null = null;
    let batch: Partial<HistoricalCandles>[] = [];
    let rowNum = 0;

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // ── Header row ──────────────────────────────────────────────────────
      if (!headerProcessed) {
        const headerResult = this.parseHeader(trimmed);
        if (!headerResult.valid) {
          throw new Error(
            `CSV header validation failed: ${headerResult.reason}\n` +
              `Expected columns: ${EXPECTED_HEADERS.join(', ')}\n` +
              `Got: ${trimmed}`,
          );
        }
        columnMap = headerResult.columnMap!;
        headerProcessed = true;
        continue;
      }

      rowNum++;
      result.totalRows++;

      // ── Parse row ────────────────────────────────────────────────────────
      const parseResult = this.parseCsvRow(trimmed, columnMap!, rowNum);
      if (!parseResult.valid) {
        result.validationErrors.push({
          row: rowNum,
          reason: parseResult.reason!,
          data: trimmed.slice(0, 120),
        });
        continue;
      }

      const row = parseResult.row!;

      // ── FK validation ─────────────────────────────────────────────────
      if (!knownInstrumentIds.has(row.instrumentId)) {
        result.validationErrors.push({
          row: rowNum,
          reason: `instrument_id '${row.instrumentId}' not found in instruments table`,
          data: trimmed.slice(0, 120),
        });
        continue;
      }

      result.validRows++;
      batch.push({
        instrumentId: row.instrumentId,
        granularity: row.granularity,
        timestamp: row.timestamp,
        openPrice: row.open,
        highPrice: row.high,
        lowPrice: row.low,
        closePrice: row.close,
        volume: row.volume,
        oi: row.oi,
      });

      // ── Flush batch ──────────────────────────────────────────────────────
      if (batch.length >= BATCH_INSERT_SIZE) {
        const batchResult = await this.flushBatch(batch, overwrite);
        result.insertedRows += batchResult.inserted;
        result.skippedDuplicates += batchResult.skipped;
        result.dbErrors.push(...batchResult.errors.map((e) => ({ row: rowNum, reason: e })));
        batch = [];
      }
    }

    // ── Flush remaining rows ───────────────────────────────────────────────
    if (batch.length > 0) {
      const batchResult = await this.flushBatch(batch, overwrite);
      result.insertedRows += batchResult.inserted;
      result.skippedDuplicates += batchResult.skipped;
      result.dbErrors.push(...batchResult.errors.map((e) => ({ row: rowNum, reason: e })));
    }

    this.logger.log(
      `[DataImport] Complete — total=${result.totalRows} valid=${result.validRows} ` +
        `inserted=${result.insertedRows} skipped=${result.skippedDuplicates} ` +
        `validationErrors=${result.validationErrors.length} dbErrors=${result.dbErrors.length}`,
    );

    if (result.validationErrors.length > 0) {
      this.logger.warn(
        `[DataImport] ${result.validationErrors.length} validation error(s) — ` +
          `first error: row ${result.validationErrors[0].row}: ` +
          `${result.validationErrors[0].reason}`,
      );
    }

    return result;
  }

  /**
   * Validates the CSV format and returns a summary without inserting any data.
   *
   * Useful for pre-flight checking a large CSV before committing to a full import.
   *
   * @param csvFilePath  Path to the CSV file to validate.
   * @returns ImportResult with totalRows, validRows, and validation errors — no DB writes.
   */
  async validateCsv(
    csvFilePath: string,
  ): Promise<Omit<ImportResult, 'insertedRows' | 'skippedDuplicates' | 'dbErrors'>> {
    this.logger.log(`[DataImport] Validating CSV format: ${csvFilePath}`);

    if (!fs.existsSync(csvFilePath)) {
      throw new Error(`CSV file not found: ${csvFilePath}`);
    }

    const knownInstrumentIds = await this.loadKnownInstrumentIds();

    const result = {
      totalRows: 0,
      validRows: 0,
      validationErrors: [] as ImportResult['validationErrors'],
    };
    const fileStream = fs.createReadStream(csvFilePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let headerProcessed = false;
    let columnMap: Map<string, number> | null = null;
    let rowNum = 0;

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (!headerProcessed) {
        const headerResult = this.parseHeader(trimmed);
        if (!headerResult.valid) {
          result.validationErrors.push({
            row: 0,
            reason: `Bad header: ${headerResult.reason}`,
            data: trimmed,
          });
          return result;
        }
        columnMap = headerResult.columnMap!;
        headerProcessed = true;
        continue;
      }

      rowNum++;
      result.totalRows++;
      const parseResult = this.parseCsvRow(trimmed, columnMap!, rowNum);
      if (!parseResult.valid) {
        result.validationErrors.push({
          row: rowNum,
          reason: parseResult.reason!,
          data: trimmed.slice(0, 120),
        });
        continue;
      }
      if (!knownInstrumentIds.has(parseResult.row!.instrumentId)) {
        result.validationErrors.push({
          row: rowNum,
          reason: `instrument_id '${parseResult.row!.instrumentId}' not in instruments table`,
          data: trimmed.slice(0, 120),
        });
        continue;
      }
      result.validRows++;
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async loadKnownInstrumentIds(): Promise<Set<string>> {
    const instruments = await this.instrumentsRepo.find({ select: { id: true } });
    return new Set(instruments.map((i) => i.id));
  }

  private parseHeader(headerLine: string): {
    valid: boolean;
    reason?: string;
    columnMap?: Map<string, number>;
  } {
    const cols = headerLine.split(',').map((c) => c.trim().toLowerCase());
    const columnMap = new Map<string, number>();

    for (const expected of EXPECTED_HEADERS) {
      const idx = cols.indexOf(expected);
      if (idx === -1) {
        return { valid: false, reason: `Missing required column: '${expected}'` };
      }
      columnMap.set(expected, idx);
    }

    // oi column is optional
    const oiIdx = cols.indexOf('oi');
    if (oiIdx !== -1) columnMap.set('oi', oiIdx);

    return { valid: true, columnMap };
  }

  private parseCsvRow(
    line: string,
    columnMap: Map<string, number>,
    rowNum: number,
  ): { valid: boolean; reason?: string; row?: CsvRow } {
    const cols = line.split(',').map((c) => c.trim());

    const get = (name: string): string => cols[columnMap.get(name)!] ?? '';

    const instrumentId = get('instrument_id');
    const granularityRaw = get('granularity');
    const timestampRaw = get('timestamp');
    const openRaw = get('open');
    const highRaw = get('high');
    const lowRaw = get('low');
    const closeRaw = get('close');
    const volumeRaw = get('volume');
    const oiRaw = columnMap.has('oi') ? get('oi') : '';

    // ── Validate instrument_id ────────────────────────────────────────────
    if (!instrumentId || instrumentId.length < 36) {
      return { valid: false, reason: `Row ${rowNum}: invalid instrument_id '${instrumentId}'` };
    }

    // ── Validate granularity ──────────────────────────────────────────────
    if (!VALID_GRANULARITIES.has(granularityRaw)) {
      return {
        valid: false,
        reason: `Row ${rowNum}: invalid granularity '${granularityRaw}' (must be 1m|5m|15m|1d)`,
      };
    }

    // ── Validate timestamp ────────────────────────────────────────────────
    const tsMs = Date.parse(timestampRaw);
    if (isNaN(tsMs)) {
      return { valid: false, reason: `Row ${rowNum}: invalid timestamp '${timestampRaw}'` };
    }
    if (tsMs < MIN_VALID_TIMESTAMP_MS) {
      return {
        valid: false,
        reason: `Row ${rowNum}: timestamp before 2010-01-01: '${timestampRaw}'`,
      };
    }

    // ── Validate OHLCV ────────────────────────────────────────────────────
    const open = parseFloat(openRaw);
    const high = parseFloat(highRaw);
    const low = parseFloat(lowRaw);
    const close = parseFloat(closeRaw);
    const volume = parseFloat(volumeRaw);

    if ([open, high, low, close].some((v) => isNaN(v) || v <= 0)) {
      return { valid: false, reason: `Row ${rowNum}: OHLC values must be positive numbers` };
    }
    if (high < Math.max(open, close)) {
      return { valid: false, reason: `Row ${rowNum}: high (${high}) < max(open, close)` };
    }
    if (low > Math.min(open, close)) {
      return { valid: false, reason: `Row ${rowNum}: low (${low}) > min(open, close)` };
    }
    if (isNaN(volume) || volume < 0) {
      return { valid: false, reason: `Row ${rowNum}: volume must be a non-negative number` };
    }

    return {
      valid: true,
      row: {
        instrumentId,
        granularity: granularityRaw as CandleGranularity,
        timestamp: new Date(tsMs),
        open: open.toFixed(2),
        high: high.toFixed(2),
        low: low.toFixed(2),
        close: close.toFixed(2),
        volume: String(Math.round(volume)),
        oi: oiRaw ? String(Math.round(parseFloat(oiRaw))) : null,
      },
    };
  }

  private async flushBatch(
    batch: Partial<HistoricalCandles>[],
    overwrite: boolean,
  ): Promise<{ inserted: number; skipped: number; errors: string[] }> {
    const result = { inserted: 0, skipped: 0, errors: [] as string[] };

    try {
      if (overwrite) {
        // Upsert: replace on conflict.
        await this.candlesRepo
          .createQueryBuilder()
          .insert()
          .into(HistoricalCandles)
          .values(batch)
          .orUpdate(
            ['open_price', 'high_price', 'low_price', 'close_price', 'volume', 'oi'],
            ['instrument_id', 'granularity', 'timestamp'],
          )
          .execute();
        result.inserted = batch.length;
      } else {
        // Insert-only: skip on conflict.
        const qr = await this.candlesRepo
          .createQueryBuilder()
          .insert()
          .into(HistoricalCandles)
          .values(batch)
          .orIgnore()
          .execute();
        result.inserted = qr.identifiers?.length ?? batch.length;
        result.skipped = batch.length - result.inserted;
      }
    } catch (err) {
      this.logger.error(`[DataImport] Batch insert error: ${(err as Error).message}`);
      result.errors.push((err as Error).message);
    }

    return result;
  }
}
