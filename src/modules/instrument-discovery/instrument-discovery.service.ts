/**
 * instrument-discovery.service.ts
 *
 * InstrumentDiscoveryService — scans all eligible NSE F&O instruments,
 * classifies them as UNDERLYING or TRADABLE_OPTION, persists results to the
 * Instruments table, and maintains an in-memory tradability cache.
 *
 * Cron schedule:
 *   @Cron('15 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
 *   → fires at 09:15 IST on every weekday (Monday–Friday)
 *
 * Classification rules (Requirement 4.6):
 *   - instrumentType === 'INDEX'         → UNDERLYING   | isTradable = false
 *   - instrumentType === 'INDEX_OPTION'  → TRADABLE_OPTION (always eligible)
 *   - instrumentType === 'STOCK_OPTION'  → TRADABLE_OPTION if OI ≥ minOI AND
 *                                          ADV ≥ minADV (Requirement 4.8)
 *   - instrumentType === 'INDEX_FUTURE'  → TRADABLE_OPTION (always eligible)
 *   - instrumentType === 'STOCK_FUTURE'  → TRADABLE_OPTION (always eligible)
 *
 * Underlying index instruments (instrumentType = 'INDEX') are NEVER submitted
 * to ExecutionService regardless of any other logic (Requirement 4.6).
 *
 * After every successful scan the service emits:
 *   'instruments.universe.updated' (NestJS EventEmitter2)
 *
 * If the scan does not complete within 5 minutes of market open the service:
 *   - retains the prior session's instrument universe (tradableCache unchanged)
 *   - emits 'instruments.scan.failed' (NestJS EventEmitter2)
 *   - publishes a CRITICAL notification via NotificationService
 *   - records a SCAN_FAILURE entry in SystemHealthEvents (fire-and-forget)
 *
 * Requirements: 4.1, 4.6, 4.7, 4.8
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import { Instruments } from '../../database/entities/instruments.entity';
import { SystemHealthEvents } from '../../database/entities/system-health-events.entity';
import { NotificationService } from '../notification/notification.service';
import { NotificationAlert } from '../notification/notification.types';

// ---------------------------------------------------------------------------
// Exported types & constants
// ---------------------------------------------------------------------------

/**
 * NSE/BSE indices whose options are eligible for trading.
 * Any INDEX_OPTION whose underlying is NOT in this list is blocked.
 */
export const ALLOWED_INDEX_UNDERLYINGS = [
  'NIFTY', // Nifty 50
  'BANKNIFTY', // Bank Nifty
  'FINNIFTY', // Nifty Financial Services
  'MIDCPNIFTY', // Nifty Midcap Select
  'SENSEX', // BSE Sensex
  'BANKEX', // BSE Bankex
  'NIFTYNXT50', // Nifty Next 50
] as const;

/** Segments that are allowed for STOCK_OPTION instruments. */
export const ALLOWED_FNO_SEGMENTS = ['NSE_FNO', 'BSE_FNO'] as const;

/**
 * High-level instrument classification used by the discovery service.
 *
 * - UNDERLYING    — an index used for directional signal computation only.
 *                   MUST never be forwarded to ExecutionService.
 * - TRADABLE_OPTION — an options or futures contract eligible for order
 *                     submission after passing eligibility checks.
 */
export type InstrumentClassification = 'UNDERLYING' | 'TRADABLE_OPTION';

/** Result returned by classifyInstrument() for a single instrument. */
export interface ClassificationResult {
  /** High-level category of this instrument. */
  classification: InstrumentClassification;
  /**
   * Whether the instrument may be submitted to ExecutionService.
   * Always false for UNDERLYING instruments.
   */
  isTradable: boolean;
  /**
   * Whether this instrument should appear in the active universe.
   * INDEX instruments are active (needed for regime/signal computation)
   * but NOT tradable.
   */
  isActive: boolean;
}

/** Payload of the 'instruments.universe.updated' NestJS event. */
export interface InstrumentsUniverseUpdatedEvent {
  /** UTC timestamp when the scan completed. */
  scannedAt: Date;
  /** Total number of instruments processed in this scan. */
  total: number;
  /** Number of instruments classified as tradable (isTradable = true). */
  tradable: number;
  /** Number of underlying index instruments (isTradable = false). */
  underlying: number;
}

/** NestJS event emitted after every successful instrument discovery scan. */
export const INSTRUMENTS_UNIVERSE_UPDATED_EVENT = 'instruments.universe.updated';

/**
 * NestJS event emitted when the instrument discovery scan fails or times out.
 * The prior session's tradable universe is retained on this event.
 *
 * Requirement: 4.7
 */
export const INSTRUMENTS_SCAN_FAILED_EVENT = 'instruments.scan.failed';

// ---------------------------------------------------------------------------
// InstrumentDiscoveryService
// ---------------------------------------------------------------------------

@Injectable()
export class InstrumentDiscoveryService {
  private readonly logger = new Logger(InstrumentDiscoveryService.name);

  /**
   * In-memory tradability cache: securityId → isTradable.
   *
   * Rebuilt synchronously after every successful scan so that
   * isInstrumentTradable() never incurs a database round-trip.
   * Node.js is single-threaded, so no mutex is needed.
   *
   * On scan failure the cache is intentionally NOT cleared, retaining the
   * prior session's instrument universe (Requirement 4.7).
   */
  private readonly tradableCache = new Map<string, boolean>();

  constructor(
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
    @InjectRepository(SystemHealthEvents)
    private readonly systemHealthEventsRepo: Repository<SystemHealthEvents>,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly notificationService: NotificationService,
  ) {}

  // -------------------------------------------------------------------------
  // Cron-triggered scan
  // -------------------------------------------------------------------------

  /**
   * Run the instrument discovery scan at 09:15 IST on every weekday.
   *
   * Delegates to runScanWithTimeout() which enforces a 5-minute deadline.
   * On any failure (scan error or timeout):
   *  - tradableCache is left untouched (prior session universe retained)
   *  - instruments.scan.failed event is emitted
   *  - CRITICAL notification is published
   *  - SCAN_FAILURE entry is written to SystemHealthEvents (fire-and-forget)
   *
   * Requirements: 4.1, 4.6, 4.7
   */
  @Cron('15 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scanInstruments(): Promise<void> {
    this.logger.log('InstrumentDiscovery: starting NSE F&O universe scan at 09:15 IST');

    try {
      await this.runScanWithTimeout();
    } catch (err) {
      const errorMessage = (err as Error).message;

      // Log the error — tradableCache is intentionally NOT modified here
      // so the prior session's universe remains valid (Requirement 4.7).
      this.logger.error(
        `InstrumentDiscovery: scan failed — retaining prior session universe. Error: ${errorMessage}`,
      );

      // Emit the scan-failed event so downstream subscribers can react.
      this.eventEmitter.emit(INSTRUMENTS_SCAN_FAILED_EVENT, {
        failedAt: new Date(),
        reason: errorMessage,
      });

      // Publish a CRITICAL notification to the Extension (Requirement 4.7).
      const alert: NotificationAlert = {
        id: uuidv4(),
        priority: 'CRITICAL',
        title: 'Instrument Scan Failed — Using Prior Session Universe',
        message: `Instrument discovery scan failed: ${errorMessage}`,
        metadata: { error: errorMessage, failedAt: new Date().toISOString() },
        createdAt: new Date(),
      };
      await this.notificationService.publish(alert);

      // Fire-and-forget: record the failure in SystemHealthEvents for audit.
      const healthEvent = this.systemHealthEventsRepo.create({
        event_type: 'SCAN_FAILURE',
        module_name: 'InstrumentDiscoveryService',
        severity: 'CRITICAL',
        message: `Instrument discovery scan failed: ${errorMessage}`,
        metadata: { error: errorMessage },
        timestamp: new Date(),
      });
      this.systemHealthEventsRepo.save(healthEvent).catch((saveErr) => {
        this.logger.error(
          `InstrumentDiscovery: failed to persist SystemHealthEvent: ${(saveErr as Error).message}`,
        );
      });
    }
  }

  // -------------------------------------------------------------------------
  // Scan with timeout enforcement (Requirement 4.7)
  // -------------------------------------------------------------------------

  /**
   * Wraps performScan() in a Promise.race() against a 5-minute deadline.
   *
   * If performScan() does not resolve within 5 minutes the timeout promise
   * rejects with 'Scan timeout: exceeded 5 minutes', which propagates to
   * the caller (scanInstruments) for failure handling.
   *
   * The timeout timer is always cleared in the finally block so there are
   * no dangling timers regardless of outcome.
   *
   * Requirement: 4.7
   */
  private async runScanWithTimeout(): Promise<void> {
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Scan timeout: exceeded 5 minutes')),
        TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([this.performScan(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // -------------------------------------------------------------------------
  // Core scan body
  // -------------------------------------------------------------------------

  /**
   * Execute the full instrument discovery scan.
   *
   * Steps:
   *  1. Read all instruments from the Instruments table (master catalogue).
   *  2. Classify each instrument per Requirements 4.6 and 4.8.
   *  3. Persist updated isTradable, isActive, and lastScannedAt fields.
   *  4. Rebuild the in-memory tradable cache.
   *  5. Emit 'instruments.universe.updated' to notify downstream modules.
   *
   * Returns early (without updating the cache or emitting) if the master
   * catalogue is empty — this is a warning condition, not a scan failure.
   *
   * Requirements: 4.1, 4.6
   */
  private async performScan(): Promise<void> {
    const scannedAt = new Date();
    const minOiThreshold = this.configService.get<number>('MIN_OI_THRESHOLD', 0) ?? 0;
    const minAdvThreshold = this.configService.get<number>('MIN_ADV_THRESHOLD', 0) ?? 0;

    // Read the full instrument master from the Instruments table.
    const instruments = await this.instrumentsRepo.find();

    if (instruments.length === 0) {
      this.logger.warn(
        'InstrumentDiscovery: no instruments found in the master catalogue; ' +
          'ensure the Instruments table is seeded before the first scan.',
      );
      return;
    }

    this.logger.log(
      `InstrumentDiscovery: classifying ${instruments.length} instruments ` +
        `(minOI=${minOiThreshold}, minADV=${minAdvThreshold})`,
    );

    let tradableCount = 0;
    let underlyingCount = 0;

    // Classify and update each instrument in place.
    for (const instrument of instruments) {
      const { classification, isTradable, isActive } = this.classifyInstrument(
        instrument,
        minOiThreshold,
        minAdvThreshold,
      );

      instrument.isTradable = isTradable;
      instrument.isActive = isActive;
      instrument.lastScannedAt = scannedAt;

      if (classification === 'UNDERLYING') {
        underlyingCount++;
      } else if (isTradable) {
        tradableCount++;
      }
    }

    // Persist all classification updates in a single save operation.
    await this.instrumentsRepo.save(instruments);

    // Rebuild the synchronous tradable cache for downstream O(1) lookups.
    this.rebuildCache(instruments);

    // Notify downstream modules that the active universe has been refreshed.
    const payload: InstrumentsUniverseUpdatedEvent = {
      scannedAt,
      total: instruments.length,
      tradable: tradableCount,
      underlying: underlyingCount,
    };
    this.eventEmitter.emit(INSTRUMENTS_UNIVERSE_UPDATED_EVENT, payload);

    this.logger.log(
      `InstrumentDiscovery scan complete: ${instruments.length} instruments processed — ` +
        `${tradableCount} tradable, ${underlyingCount} underlying indices.`,
    );
  }

  // -------------------------------------------------------------------------
  // Classification logic
  // -------------------------------------------------------------------------

  /**
   * Classify a single instrument and determine its tradability.
   *
   * This method is public to allow direct testing and downstream inspection.
   *
   * @param instrument     The instrument entity to classify.
   * @param minOiThreshold Minimum open-interest threshold (0 = unconfigured).
   * @param minAdvThreshold Minimum average-daily-volume threshold (0 = unconfigured).
   * @returns ClassificationResult with classification, isTradable, and isActive.
   *
   * Requirements: 4.6, 4.8
   */
  classifyInstrument(
    instrument: Instruments,
    minOiThreshold: number,
    minAdvThreshold: number,
  ): ClassificationResult {
    // ── Rule 1: INDEX instruments are UNDERLYING — NEVER tradable ─────────
    // This is a hard constraint (Requirement 4.6).  No other logic may
    // override it; underlying indices must never reach ExecutionService.
    if (instrument.instrumentType === 'INDEX') {
      return {
        classification: 'UNDERLYING',
        isTradable: false,
        isActive: true, // Active for regime/signal computation, not for orders.
      };
    }

    // ── Rule 2: Options and futures are TRADABLE_OPTION candidates ─────────
    const eligible = this.passesEligibilityCheck(instrument, minOiThreshold, minAdvThreshold);
    return {
      classification: 'TRADABLE_OPTION',
      isTradable: eligible,
      isActive: eligible,
    };
  }

  /**
   * Evaluate whether an instrument meets the OI and ADV eligibility thresholds.
   *
   * Eligibility rules (Requirement 4.8):
   *  - INDEX_OPTION  — always eligible (NIFTY / BANKNIFTY / etc. index options).
   *  - INDEX_FUTURE  — always eligible.
   *  - STOCK_FUTURE  — always eligible.
   *  - STOCK_OPTION  — must satisfy BOTH minimum OI AND minimum ADV thresholds
   *                    simultaneously; failing either threshold is sufficient to
   *                    exclude the instrument from the active universe.
   *
   * When both thresholds are 0 (unconfigured), all instruments pass.
   *
   * Global invariant (Requirement 4.8): this check is applied uniformly on
   * every scan; there are no per-instrument overrides.
   *
   * @param instrument      The instrument to evaluate.
   * @param minOiThreshold  Minimum open interest (contracts); 0 = unconfigured.
   * @param minAdvThreshold Minimum average daily volume (contracts); 0 = unconfigured.
   * @returns true if the instrument is eligible for the active universe.
   */
  passesEligibilityCheck(
    instrument: Instruments,
    minOiThreshold: number,
    minAdvThreshold: number,
  ): boolean {
    // ── INDEX_OPTION: only allow the configured index underlyings ─────────
    // Nifty, BankNifty, FinNifty, MidcpNifty, Sensex, Bankex, NiftyNxt50.
    if (instrument.instrumentType === 'INDEX_OPTION') {
      return (ALLOWED_INDEX_UNDERLYINGS as readonly string[]).includes(instrument.underlying);
    }

    // ── FUTURES are blocked — bot trades options buying only ──────────────
    if (
      instrument.instrumentType === 'INDEX_FUTURE' ||
      instrument.instrumentType === 'STOCK_FUTURE'
    ) {
      return false;
    }

    // ── STOCK_OPTION: must be from NSE_FNO or BSE_FNO segment ─────────────
    if (!(ALLOWED_FNO_SEGMENTS as readonly string[]).includes(instrument.segment)) {
      return false;
    }

    // ── STOCK_OPTION: enforce global OI and ADV invariants (Requirement 4.8)
    // When both thresholds are 0 (unconfigured), admit all stock options.
    if (minOiThreshold === 0 && minAdvThreshold === 0) {
      return true;
    }

    // Both OI and ADV must simultaneously satisfy their configured thresholds.
    // A threshold of 0 for a single dimension means that dimension is unconfigured
    // (always passes); only a non-zero threshold enforces a real lower bound.
    const passesOi = minOiThreshold === 0 || (instrument.openInterest ?? 0) >= minOiThreshold;
    const passesAdv = minAdvThreshold === 0 || (instrument.avgDailyVolume ?? 0) >= minAdvThreshold;
    return passesOi && passesAdv;
  }

  // -------------------------------------------------------------------------
  // Active universe query
  // -------------------------------------------------------------------------

  /**
   * Return all instruments in the active trading universe.
   *
   * An instrument is in the active universe iff:
   *   is_active = true  AND  is_tradable = true
   *
   * Results are ordered by descending liquidity score so callers can easily
   * access the highest-quality instruments first.
   *
   * Note: underlying INDEX instruments are active but NOT tradable, so they
   * are intentionally excluded from this result set.
   *
   * Requirements: 4.1
   */
  async getActiveUniverse(): Promise<Instruments[]> {
    return this.instrumentsRepo.find({
      where: { isActive: true, isTradable: true },
      order: { liquidityScore: 'DESC' },
    });
  }

  // -------------------------------------------------------------------------
  // Synchronous tradability check (in-memory cache)
  // -------------------------------------------------------------------------

  /**
   * Synchronous O(1) tradability check.
   *
   * Uses the in-memory tradable cache populated during the last scan.
   * Returns false for instruments not yet scanned or not present in the cache.
   *
   * INDEX instruments are always false — this is enforced both by the
   * classification logic and by never inserting INDEX securityIds with
   * isTradable = true into the cache.
   *
   * @param instrumentId  The Dhan securityId of the instrument to check.
   * @returns true if the instrument may be submitted to ExecutionService.
   *
   * Requirements: 4.6
   */
  isInstrumentTradable(instrumentId: string): boolean {
    return this.tradableCache.get(instrumentId) ?? false;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Rebuild the in-memory tradable cache from a freshly classified instrument set.
   * Keyed by securityId (the Dhan broker-side identifier).
   */
  private rebuildCache(instruments: Instruments[]): void {
    this.tradableCache.clear();
    for (const inst of instruments) {
      this.tradableCache.set(inst.securityId, inst.isTradable);
    }
    this.logger.debug(
      `InstrumentDiscovery: tradable cache rebuilt with ${this.tradableCache.size} entries.`,
    );
  }
}
