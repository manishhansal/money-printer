/**
 * PortfolioService — authoritative in-memory portfolio state and Dynamic_Capital tracking.
 *
 * Responsibilities:
 *  1. Dynamic_Capital tracking (Req 9.1, 18.2, 18.3, 18.4):
 *       - Loads initial capital from CapitalLedgers (or UserSettings if no ledger entries)
 *         for each engine during startup.
 *       - Accumulates realized net P&L in-memory using BigInt arithmetic to avoid
 *         IEEE-754 floating-point rounding errors.
 *       - Writes each capital-change event to CapitalLedgers inside a PostgreSQL
 *         transaction; updates in-memory capital only on successful commit.
 *       - On transaction failure: emits `capital.ledger.failure` to halt signal
 *         evaluations and preserves the last committed balance (Req 18.4).
 *
 *  2. Open-position in-memory cache (Req 9.1):
 *       - Maintains per-engine lists of open Position entities (fast synchronous reads).
 *       - add/remove operations are called by the ExecutionService on fill events.
 *       - `refreshFromDatabase` re-syncs authoritative state on startup or reconnect.
 *
 * Requirements: 9.1, 18.2, 18.3, 18.4
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  CapitalLedgers,
  CapitalLedgerEventType,
} from '../../database/entities/capital-ledgers.entity';
import { Position } from '../../database/entities/positions.entity';
import { UserSettings } from '../../database/entities/user-settings.entity';
import {
  SystemHealthEvents,
  HealthEventSeverity,
} from '../../database/entities/system-health-events.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Exported constants & types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NestJS event emitted when the CapitalLedger PostgreSQL transaction fails.
 *
 * Subscribers (e.g. the signal-evaluation pipeline) MUST block new signal
 * evaluations upon receiving this event (Requirement 18.4).
 */
export const CAPITAL_LEDGER_FAILURE_EVENT = 'capital.ledger.failure';

/** Payload shape for CAPITAL_LEDGER_FAILURE_EVENT. */
export interface CapitalLedgerFailurePayload {
  /** Trading engine that experienced the failure. */
  engine: 'LIVE' | 'PAPER';
  /** FK → trades.id of the trade whose P&L triggered the ledger update. */
  tradeId: string;
  /** Human-readable error message from the caught exception. */
  error: string;
  /** Wall-clock timestamp when the failure was detected. */
  timestamp: Date;
}

/**
 * Minimal completed-trade data required to record a capital-ledger entry.
 *
 * This is intentionally lean — callers (ExecutionService, PaperEngine) already
 * hold the full Trade record; only the fields needed for the ledger write are
 * required here to keep coupling minimal.
 */
export interface CompletedTradeData {
  /** FK → trades.id — the trade whose P&L is being ledgered. */
  tradeId: string;
  /**
   * Net P&L after all charges (INR, NUMERIC string e.g. "360.40" or "-50.20").
   * Must match the `net_pnl` column persisted in the Trade entity.
   */
  netPnl: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLA threshold
// ─────────────────────────────────────────────────────────────────────────────

/** Soft SLA: CapitalLedger update + Dynamic_Capital recomputation (Req 18.3). */
const CAPITAL_UPDATE_SLA_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class PortfolioService implements OnModuleInit {
  private readonly logger = new Logger(PortfolioService.name);

  /**
   * In-memory Dynamic_Capital per engine, stored as integer 10,000ths (BigInt).
   *
   * Storing in 10,000ths gives 4 dp precision, matching the highest-precision
   * cost columns in the Trade entity (NUMERIC 10,4).  External callers always
   * receive a rounded 2 dp decimal string via `getDynamicCapital()`.
   *
   * Initialised during onModuleInit(); updated by each successful
   * `recordTradeAndUpdateCapital()` call.
   */
  private readonly dynamicCapital = new Map<string, bigint>();

  /**
   * In-memory open-position list per engine.
   *
   * Populated from PostgreSQL during onModuleInit() and kept in sync by
   * `addPosition` / `removePosition` callers throughout the trading session.
   */
  private readonly openPositions = new Map<string, Position[]>();

  constructor(
    @InjectRepository(CapitalLedgers)
    private readonly capitalLedgersRepo: Repository<CapitalLedgers>,

    @InjectRepository(Position)
    private readonly positionsRepo: Repository<Position>,

    @InjectRepository(UserSettings)
    private readonly userSettingsRepo: Repository<UserSettings>,

    @InjectRepository(SystemHealthEvents)
    private readonly systemHealthEventsRepo: Repository<SystemHealthEvents>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Loads Dynamic_Capital and open positions for both LIVE and PAPER engines.
   *
   * Errors are caught per-engine: a single engine failure does not block the
   * other or prevent the module from starting.  Defaults to 0.00 capital and
   * empty positions when DB initialisation fails.
   */
  async onModuleInit(): Promise<void> {
    for (const engine of ['LIVE', 'PAPER'] as const) {
      try {
        await this.refreshFromDatabase(engine);
      } catch (err) {
        this.logger.error(
          `[Portfolio] Failed to initialise ${engine} portfolio state: ` +
            `${(err as Error).message}. Defaulting to zero capital and empty positions.`,
        );
        // Safe defaults so the service is usable even after a DB bootstrap failure.
        this.dynamicCapital.set(engine, 0n);
        this.openPositions.set(engine, []);
      }
    }

    this.logger.log(
      `[Portfolio] Initialised — ` +
        `LIVE capital=${this.getDynamicCapital('LIVE')}, ` +
        `PAPER capital=${this.getDynamicCapital('PAPER')}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dynamic_Capital API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the current Dynamic_Capital for the given engine as a decimal
   * string with 2 decimal places (e.g. "125000.00").
   *
   *   Dynamic_Capital = starting_capital + SUM(realized net_pnl for all closed trades)
   *
   * This is a synchronous, O(1) in-memory read — no database round-trip.
   *
   * Requirements: 9.1, 18.2
   *
   * @param engine  Trading engine context: 'LIVE' or 'PAPER'.
   */
  getDynamicCapital(engine: 'LIVE' | 'PAPER'): string {
    const value = this.dynamicCapital.get(engine) ?? 0n;
    return PortfolioService.int10kToDecimal2dp(value);
  }

  /**
   * Atomically records a completed trade's net P&L in the CapitalLedger and
   * updates the in-memory Dynamic_Capital.
   *
   * Contract (Requirements 18.3, 18.4):
   *   - SLA: must complete within 500 ms (soft limit; violations are logged).
   *   - A single PostgreSQL transaction INSERTs the CapitalLedgers row with
   *     `balance_before`, `amount` (= netPnl), and `balance_after`.
   *   - On commit: in-memory capital is updated to the new balance.
   *   - On failure:
   *       (a) `capital.ledger.failure` event is emitted — subscribers MUST
   *           halt new signal evaluations (Req 18.4).
   *       (b) In-memory capital is NOT modified; the last committed balance
   *           is preserved (Req 18.4).
   *       (c) The original error is re-thrown so callers can chain additional
   *           error-handling (e.g., recording a SystemHealthEvent).
   *
   * @param tradeData  Completed trade data containing tradeId and netPnl.
   * @param engine     Trading engine this trade belongs to.
   */
  async recordTradeAndUpdateCapital(
    tradeData: CompletedTradeData,
    engine: 'LIVE' | 'PAPER',
  ): Promise<void> {
    const slaStart = Date.now();

    const currentCapitalInt = this.dynamicCapital.get(engine) ?? 0n;
    const pnlInt = PortfolioService.decimalToInt10k(tradeData.netPnl);
    const newCapitalInt = currentCapitalInt + pnlInt;

    const balanceBefore = PortfolioService.int10kToDecimal2dp(currentCapitalInt);
    const balanceAfter = PortfolioService.int10kToDecimal2dp(newCapitalInt);
    const amountStr = PortfolioService.int10kToDecimal2dp(pnlInt);

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.insert(CapitalLedgers, {
          engine,
          event_type: 'TRADE_PNL' as CapitalLedgerEventType,
          trade_id: tradeData.tradeId,
          amount: amountStr,
          balance_before: balanceBefore,
          balance_after: balanceAfter,
          description: null,
          occurred_at: new Date(),
        });
      });

      // ── Transaction committed — update in-memory state ─────────────────────
      this.dynamicCapital.set(engine, newCapitalInt);

      // SLA monitoring (Req 18.3)
      const elapsed = Date.now() - slaStart;
      if (elapsed > CAPITAL_UPDATE_SLA_MS) {
        this.logger.warn(
          `[Portfolio] SLA breach: CapitalLedger update for ${engine} completed in ` +
            `${elapsed} ms (SLA: ${CAPITAL_UPDATE_SLA_MS} ms)`,
        );
      }

      this.logger.log(
        `[Portfolio] ${engine} capital updated: ${balanceBefore} → ${balanceAfter} ` +
          `(trade=${tradeData.tradeId}, pnl=${tradeData.netPnl})`,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const failureTimestamp = new Date();

      // ── Requirement 18.4: emit failure event to halt signal evaluations ─────
      const payload: CapitalLedgerFailurePayload = {
        engine,
        tradeId: tradeData.tradeId,
        error: error.message,
        timestamp: failureTimestamp,
      };
      this.eventEmitter.emit(CAPITAL_LEDGER_FAILURE_EVENT, payload);

      this.logger.error(
        `[Portfolio] CapitalLedger transaction FAILED for ${engine} ` +
          `(trade=${tradeData.tradeId}): ${error.message}. ` +
          'In-memory capital preserved at last committed balance.',
      );

      // ── Requirement 18.4: record error in SystemHealthEvents within 1 second ─
      const healthSlaStart = Date.now();
      try {
        const healthEvent = this.systemHealthEventsRepo.create({
          event_type: 'CAPITAL_LEDGER_FAIL',
          module_name: 'PortfolioService',
          severity: 'CRITICAL' as HealthEventSeverity,
          message: `CapitalLedger write failed for trade ${tradeData.tradeId}: ${error.message}`,
          metadata: null,
          timestamp: failureTimestamp,
        });
        await this.systemHealthEventsRepo.save(healthEvent);

        const healthElapsed = Date.now() - healthSlaStart;
        if (healthElapsed > 1000) {
          this.logger.warn(
            `[Portfolio] SLA breach: SystemHealthEvent write for ${engine} completed in ` +
              `${healthElapsed} ms (SLA: 1000 ms)`,
          );
        }
      } catch (healthErr) {
        this.logger.error(
          `[Portfolio] Failed to record SystemHealthEvent for ${engine} ` +
            `(trade=${tradeData.tradeId}): ${(healthErr as Error).message}`,
        );
      }

      // Re-throw the original error so callers can chain additional handling.
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Open Positions API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the in-memory list of open positions for the given engine.
   * Synchronous O(1) — no DB round-trip.
   *
   * @param engine  Trading engine context: 'LIVE' or 'PAPER'.
   */
  getOpenPositions(engine: 'LIVE' | 'PAPER'): Position[] {
    return this.openPositions.get(engine) ?? [];
  }

  /**
   * Appends a position to the in-memory open-positions list.
   *
   * The target engine bucket is inferred from `position.engine`.
   * Called by ExecutionService when a new position is opened.
   *
   * @param position  The newly opened Position entity.
   */
  addPosition(position: Position): void {
    const engine = position.engine as 'LIVE' | 'PAPER';
    const existing = this.openPositions.get(engine) ?? [];
    // Create a new array to avoid mutating a potentially shared reference.
    this.openPositions.set(engine, [...existing, position]);
  }

  /**
   * Removes the position with the given ID from the in-memory list.
   *
   * Searches both engine buckets so the caller does not need to track the
   * engine; position IDs are globally unique UUIDs.
   * Called by ExecutionService when a position is fully closed.
   *
   * @param positionId  UUID of the position to remove.
   */
  removePosition(positionId: string): void {
    for (const [engine, positions] of this.openPositions) {
      const idx = positions.findIndex((p) => p.id === positionId);
      if (idx !== -1) {
        // Create a new array to avoid mutating a potentially shared reference.
        this.openPositions.set(
          engine,
          positions.filter((p) => p.id !== positionId),
        );
        return;
      }
    }
  }

  /**
   * Reloads open positions and Dynamic_Capital from PostgreSQL for the given
   * engine.
   *
   * Called during `onModuleInit` for both engines, and can be called again
   * after a DhanAPI reconnection to re-synchronise in-memory state with the
   * authoritative DB (e.g., after a CloudEngine restart where positions may
   * have been modified externally).
   *
   * Capital loading priority:
   *   1. Latest CapitalLedgers.balance_after for this engine — authoritative
   *      running balance that already incorporates all historical P&L.
   *   2. UserSettings.liveStartingCapital / paperStartingCapital — used only
   *      when no ledger entries exist (first-ever session for this engine).
   *   3. 0.00 — fallback if UserSettings has no rows (logged as a warning).
   *
   * @param engine  Trading engine context: 'LIVE' or 'PAPER'.
   */
  async refreshFromDatabase(engine: 'LIVE' | 'PAPER'): Promise<void> {
    // ── 1. Reload open positions ─────────────────────────────────────────────
    const positions = await this.positionsRepo.find({
      where: { engine, is_open: true },
    });
    this.openPositions.set(engine, positions);
    this.logger.debug(
      `[Portfolio] ${engine} open positions refreshed: ${positions.length} position(s)`,
    );

    // ── 2. Reload Dynamic_Capital ────────────────────────────────────────────
    const latestLedger = await this.capitalLedgersRepo.findOne({
      where: { engine },
      order: { occurred_at: 'DESC' },
    });

    if (latestLedger) {
      this.dynamicCapital.set(engine, PortfolioService.decimalToInt10k(latestLedger.balance_after));
      this.logger.log(
        `[Portfolio] ${engine} capital loaded from latest ledger entry: ` +
          `${latestLedger.balance_after}`,
      );
      return;
    }

    // No ledger entries yet — fall back to configured starting capital.
    const settings = await this.userSettingsRepo.findOne({ where: {} });
    if (!settings) {
      this.logger.warn(
        `[Portfolio] No UserSettings record found — defaulting ${engine} ` +
          'Dynamic_Capital to 0.00',
      );
      this.dynamicCapital.set(engine, 0n);
      return;
    }

    const startingCapital =
      engine === 'LIVE' ? settings.liveStartingCapital : settings.paperStartingCapital;

    this.dynamicCapital.set(engine, PortfolioService.decimalToInt10k(startingCapital));
    this.logger.log(
      `[Portfolio] ${engine} capital loaded from UserSettings.` +
        `${engine === 'LIVE' ? 'liveStartingCapital' : 'paperStartingCapital'}: ` +
        startingCapital,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BigInt decimal arithmetic helpers
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Same approach as TradeJournalService.calculateNetPnl — all values are
  // converted to integer 10,000ths to avoid IEEE-754 accumulation errors.
  // The 4-dp precision matches the highest-precision NUMERIC(x,4) cost columns.

  /**
   * Convert a decimal string to an integer count of 10,000ths (BigInt).
   *
   * Handles negative values and up to 4 decimal places; digits beyond 4 dp
   * are truncated (consistent with NUMERIC(x,4) DB storage).
   *
   * Examples:
   *   '100.00'    → 1_000_000n
   *   '-50.1250'  → -501_250n
   *   '360.40'    → 3_604_000n
   *   '0'         → 0n
   */
  private static decimalToInt10k(value: string): bigint {
    const trimmed = value.trim();
    const isNegative = trimmed.startsWith('-');
    const abs = isNegative ? trimmed.slice(1) : trimmed;

    const dotIndex = abs.indexOf('.');
    const intStr = dotIndex === -1 ? abs : abs.slice(0, dotIndex);
    const fracStr = dotIndex === -1 ? '' : abs.slice(dotIndex + 1);

    // Normalise to exactly 4 decimal digits
    const frac4 = fracStr.padEnd(4, '0').slice(0, 4);
    const result = BigInt(intStr || '0') * 10_000n + BigInt(frac4);
    return isNegative ? -result : result;
  }

  /**
   * Convert an integer count of 10,000ths back to a decimal string rounded
   * half-up to 2 decimal places.
   *
   * Examples:
   *   1_004_250n  → '100.43'  (0.0025 rounds up the 2nd decimal)
   *   3_604_000n  → '360.40'
   *           0n  → '0.00'
   *   -501_250n   → '-50.13'
   *
   * Note: '-0.00' is normalised to '0.00'.
   */
  private static int10kToDecimal2dp(value: bigint): string {
    const isNegative = value < 0n;
    const abs = isNegative ? -value : value;

    // Round half-up: if the last two of the four fractional digits are ≥ 50, round up.
    const lastTwo = abs % 100n;
    const rounded100 = lastTwo >= 50n ? abs / 100n + 1n : abs / 100n;

    const wholePart = rounded100 / 100n;
    const fracPart = rounded100 % 100n;
    const result = `${wholePart}.${fracPart.toString().padStart(2, '0')}`;

    // Suppress '-0.00' — zero has no meaningful sign.
    return isNegative && result !== '0.00' ? `-${result}` : result;
  }
}
