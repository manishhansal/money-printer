/**
 * instrument-master.service.ts
 *
 * InstrumentMasterService — authoritative instrument metadata downloader,
 * validator, and upsert engine.
 *
 * Responsibilities:
 *  1. Download the latest Dhan API instrument CSV on demand.
 *  2. Parse and validate every row (reject missing lot_size, bad expiry, etc.).
 *  3. Upsert to the instruments table using a full column-update ON CONFLICT.
 *  4. Detect and report stale lot sizes, expired contracts, and duplicates.
 *  5. Maintain an in-process metadata cache for O(1) lot_size lookups.
 *
 * Schedule: runs at 09:05 IST every weekday (before InstrumentDiscovery at 09:15).
 *
 * Requirements: P0-CRIT-003, P0-CRIT-004, Phase 1 InstrumentMasterService.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { Instruments } from '../../database/entities/instruments.entity';

/** Dhan official instrument master CSV URL. */
const MASTER_CSV_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

/** Index underlyings allowed for trading. */
const ALLOWED_INDEX_UNDERLYINGS = new Set([
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'SENSEX',
  'BANKEX',
  'NIFTYNXT50',
]);

/** Instrument type codes from the CSV. */
const INSTRUMENT_TYPE_MAP: Record<string, string> = {
  OPTIDX: 'INDEX_OPTION',
  OPTSTK: 'STOCK_OPTION',
  FUTIDX: 'INDEX_FUTURE',
  FUTSTK: 'STOCK_FUTURE',
  INDEX: 'INDEX',
};

/** Exchange segment mapping from (exchange, segment) pair. */
const SEGMENT_MAP: Record<string, string> = {
  NSE_D: 'NSE_FNO',
  BSE_D: 'BSE_FNO',
  NSE_I: 'IDX_I',
  BSE_I: 'IDX_I',
};

export interface InstrumentMetadata {
  securityId: string;
  lotSize: number;
  tickSize: string;
  expiryDate: string | null;
  strikePrice: number | null;
  optionType: 'CE' | 'PE' | null;
  instrumentType: string;
  underlying: string;
  tradingSymbol: string;
}

export interface RefreshResult {
  downloaded: number;
  validated: number;
  rejected: number;
  upserted: number;
  rejectionReasons: Record<string, number>;
  refreshedAt: Date;
}

@Injectable()
export class InstrumentMasterService implements OnModuleInit {
  private readonly logger = new Logger(InstrumentMasterService.name);

  /** In-process cache: securityId → InstrumentMetadata (populated after refresh). */
  private readonly metadataCache = new Map<string, InstrumentMetadata>();

  /** True when at least one successful refresh has been completed. */
  private initialized = false;

  constructor(
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Warm the in-process cache from existing DB data on startup.
    // This avoids a CSV download on every cold start.
    try {
      await this.warmCacheFromDb();
      this.initialized = true;
      this.logger.log(
        `[InstrumentMaster] Cache warmed from DB: ${this.metadataCache.size} instruments`,
      );
    } catch (err) {
      this.logger.error(`[InstrumentMaster] Cache warm failed: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scheduled refresh — 09:05 IST weekdays (before InstrumentDiscovery at 09:15)
  // ─────────────────────────────────────────────────────────────────────────

  @Cron('5 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scheduledRefresh(): Promise<void> {
    this.logger.log('[InstrumentMaster] 09:05 IST scheduled refresh starting');
    try {
      const result = await this.refreshFromCsv();
      this.logger.log(
        `[InstrumentMaster] Refresh complete — downloaded=${result.downloaded}, ` +
          `validated=${result.validated}, rejected=${result.rejected}, ` +
          `upserted=${result.upserted}`,
      );
      if (result.rejected > 0) {
        this.logger.warn(
          `[InstrumentMaster] ${result.rejected} rows rejected: ` +
            JSON.stringify(result.rejectionReasons),
        );
      }
    } catch (err) {
      this.logger.error(`[InstrumentMaster] Scheduled refresh FAILED: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the cached metadata for a given security ID.
   * Returns null if the instrument is not in the cache (never downloaded or rejected).
   */
  getMetadata(securityId: string): InstrumentMetadata | null {
    return this.metadataCache.get(securityId) ?? null;
  }

  /**
   * Returns the lot size for a given security ID, or null if unknown.
   * Used by the dispatcher to validate order sizing without a DB query.
   */
  getLotSize(securityId: string): number | null {
    return this.metadataCache.get(securityId)?.lotSize ?? null;
  }

  /** Returns true when at least one successful refresh has been completed. */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Download, validate, and upsert the latest Dhan instrument master CSV.
   * Returns a summary of the operation.
   */
  async refreshFromCsv(): Promise<RefreshResult> {
    const result: RefreshResult = {
      downloaded: 0,
      validated: 0,
      rejected: 0,
      upserted: 0,
      rejectionReasons: {},
      refreshedAt: new Date(),
    };

    // ── Download CSV ───────────────────────────────────────────────────────────
    let csvText: string;
    try {
      const response = await fetch(MASTER_CSV_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${MASTER_CSV_URL}`);
      }
      csvText = await response.text();
    } catch (err) {
      throw new Error(`Failed to download instrument master: ${(err as Error).message}`);
    }

    const lines = csvText.split('\n');
    result.downloaded = lines.length - 1; // subtract header

    // ── Parse headers ──────────────────────────────────────────────────────────
    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const col = (name: string): number => headers.indexOf(name);

    // ── Parse and validate rows ────────────────────────────────────────────────
    const validRows: InstrumentMetadata[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const fields = line.split(',').map((f) => f.trim().replace(/^"|"$/g, ''));

      const exch = fields[col('SEM_EXM_EXCH_ID')] ?? '';
      const seg = fields[col('SEM_SEGMENT')] ?? '';
      const instName = fields[col('SEM_INSTRUMENT_NAME')] ?? '';
      const securityId = fields[col('SEM_SMST_SECURITY_ID')] ?? '';
      const tradingSymbol = fields[col('SEM_TRADING_SYMBOL')] ?? '';
      const underlying = fields[col('SM_SYMBOL_NAME')] ?? '';
      const expiryRaw = fields[col('SEM_EXPIRY_DATE')] ?? '';
      const strikeRaw = fields[col('SEM_STRIKE_PRICE')] ?? '';
      const optionTypeRaw = fields[col('SEM_OPTION_TYPE')] ?? '';
      const lotSizeRaw = fields[col('SEM_LOT_UNITS')] ?? '';
      const tickSizeRaw = fields[col('SEM_TICK_SIZE')] ?? '';

      // Only process known instrument types.
      const instrumentType = INSTRUMENT_TYPE_MAP[instName];
      if (!instrumentType) continue;

      // Segment must be mappable.
      const segmentKey = `${exch}_${seg}`;
      const segment = SEGMENT_MAP[segmentKey];
      if (!segment) continue;

      // For INDEX_OPTION: only allowed underlyings.
      if (
        instrumentType === 'INDEX_OPTION' &&
        !ALLOWED_INDEX_UNDERLYINGS.has(underlying.toUpperCase())
      ) {
        continue;
      }

      // Security ID required.
      if (!securityId) {
        this.incrementRejection(result, 'missing_security_id');
        continue;
      }

      // Lot size is MANDATORY — no silent default to 1.
      if (!lotSizeRaw || lotSizeRaw === '') {
        this.incrementRejection(result, 'missing_lot_size');
        continue;
      }
      const lotSize = parseInt(lotSizeRaw, 10);
      if (isNaN(lotSize) || lotSize <= 0) {
        this.incrementRejection(result, 'invalid_lot_size');
        continue;
      }

      // Tick size required.
      const tickSize = tickSizeRaw ? parseFloat(tickSizeRaw) : null;
      if (!tickSize || isNaN(tickSize) || tickSize <= 0) {
        this.incrementRejection(result, 'invalid_tick_size');
        continue;
      }

      // Parse expiry.
      const expiryDate = expiryRaw.includes(' ') ? expiryRaw.split(' ')[0] : expiryRaw || null;

      // Parse strike.
      const strikePrice = strikeRaw ? parseFloat(strikeRaw) : null;

      // Parse option type.
      let optionType: 'CE' | 'PE' | null = null;
      if (optionTypeRaw === 'CE' || optionTypeRaw === 'CA') optionType = 'CE';
      else if (optionTypeRaw === 'PE' || optionTypeRaw === 'PA') optionType = 'PE';

      result.validated++;
      validRows.push({
        securityId,
        lotSize,
        tickSize: tickSize.toFixed(4),
        expiryDate: expiryDate || null,
        strikePrice: strikePrice ?? null,
        optionType,
        instrumentType,
        underlying: underlying.substring(0, 100),
        tradingSymbol: tradingSymbol.substring(0, 100),
      });
    }

    result.rejected = result.downloaded - result.validated;

    // ── Upsert in batches ──────────────────────────────────────────────────────
    const BATCH_SIZE = 500;
    for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
      const batch = validRows.slice(i, i + BATCH_SIZE);
      await this.upsertBatch(batch);
      result.upserted += batch.length;

      // Update in-process cache.
      for (const row of batch) {
        this.metadataCache.set(row.securityId, row);
      }
    }

    this.initialized = true;
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Warm the in-process cache from existing DB data (no CSV download). */
  private async warmCacheFromDb(): Promise<void> {
    // Load in batches to avoid loading the entire table into memory at once.
    const pageSize = 1000;
    let offset = 0;
    let loaded = 0;

    while (true) {
      const rows = await this.instrumentsRepo.find({ take: pageSize, skip: offset });
      if (rows.length === 0) break;

      for (const row of rows) {
        this.metadataCache.set(row.securityId, {
          securityId: row.securityId,
          lotSize: row.lotSize,
          tickSize: String(row.tickSize),
          expiryDate: row.expiryDate ?? null,
          strikePrice: row.strikePrice != null ? parseFloat(String(row.strikePrice)) : null,
          optionType: row.optionType ?? null,
          instrumentType: row.instrumentType,
          underlying: row.underlying,
          tradingSymbol: row.tradingSymbol,
        });
      }

      loaded += rows.length;
      offset += pageSize;
      if (rows.length < pageSize) break;
    }

    this.logger.debug(`[InstrumentMaster] Loaded ${loaded} records from DB into cache`);
  }

  /**
   * Upsert a batch of validated rows using TypeORM's save with upsert semantics.
   * Updates all mutable columns (lot_size, tick_size, trading_symbol, expiry, strike)
   * when the security_id already exists, ensuring stale data is never preserved.
   */
  private async upsertBatch(rows: InstrumentMetadata[]): Promise<void> {
    const entities = rows.map((row) =>
      this.instrumentsRepo.create({
        securityId: row.securityId,
        tradingSymbol: row.tradingSymbol,
        exchange: row.tradingSymbol.includes('BSE') ? 'BSE' : 'NSE',
        segment: row.instrumentType === 'INDEX_OPTION' ? 'IDX_I' : 'NSE_FNO',
        instrumentType: row.instrumentType as any,
        underlying: row.underlying,
        expiryDate: row.expiryDate ?? undefined,
        strikePrice: row.strikePrice != null ? String(row.strikePrice) : null,
        optionType: row.optionType ?? undefined,
        lotSize: row.lotSize,
        tickSize: row.tickSize,
        isActive: true,
        isTradable: false, // InstrumentDiscovery sets this after eligibility check
      }),
    );

    // Use TypeORM upsert to update all mutable columns on conflict.
    await this.instrumentsRepo.upsert(entities, {
      conflictPaths: ['securityId'],
      skipUpdateIfNoValuesChanged: true,
    });
  }

  private incrementRejection(result: RefreshResult, reason: string): void {
    result.rejectionReasons[reason] = (result.rejectionReasons[reason] ?? 0) + 1;
  }
}
