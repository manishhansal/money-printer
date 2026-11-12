/**
 * TradeJournalService — immutable append-only record keeper for all trading
 * activity, risk events, system errors, and configuration changes.
 *
 * Design invariants (Requirement 13.3):
 *   - Only INSERT operations are issued on journal tables.
 *   - No UPDATE or DELETE is ever performed after initial creation.
 *
 * Write retry policy (Requirement 13.7):
 *   - Up to 3 retries within a 30-second window using exponential backoff.
 *   - On all-retry exhaustion: emit an operator alert via NestJS EventEmitter2
 *     identifying the record type and failure reason.
 *   - Records are NEVER silently dropped.
 *
 * Persistence SLAs (Requirements 13.5, 13.8):
 *   - risk_events and system_errors: must persist within 1 second.
 *   - All other record sets: must persist within 5 seconds.
 *   - SLA violations are logged as warnings; they do not abort the write.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Signals } from '../../database/entities/signals.entity';
import { Order } from '../../database/entities/orders.entity';
import { Execution } from '../../database/entities/executions.entity';
import { Position } from '../../database/entities/positions.entity';
import { Trade } from '../../database/entities/trades.entity';
import { RiskEvents } from '../../database/entities/risk-events.entity';
import { SystemHealthEvents } from '../../database/entities/system-health-events.entity';
import { AuditLogs } from '../../database/entities/audit-logs.entity';

import { CreateSignalDto } from './dto/create-signal.dto';
import { RejectedSignalDto } from './dto/rejected-signal.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateFillDto } from './dto/create-fill.dto';
import { CreatePositionDto } from './dto/create-position.dto';
import { CompletedTradeDto } from './dto/completed-trade.dto';
import { RiskEventDto } from './dto/risk-event.dto';
import { SystemErrorDto } from './dto/system-error.dto';
import { ConfigChangeDto } from './dto/config-change.dto';
import { DecisionMemoryService } from '../agents/decision-memory.service';

/** Event name published when all write retries are exhausted. */
export const JOURNAL_WRITE_FAILED_EVENT = 'trade-journal.write.failed';

/** Payload shape for the JOURNAL_WRITE_FAILED_EVENT. */
export interface JournalWriteFailedPayload {
  recordType: string;
  failureReason: string;
  timestamp: Date;
}

/** Retry configuration constants. */
const MAX_RETRIES = 3;
const RETRY_WINDOW_MS = 30_000;

/** Exponential backoff delays: 1 s, 2 s, 4 s — total ≈ 7 s, well within 30 s. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/** SLA thresholds in milliseconds. */
const SLA_RISK_EVENT_MS = 1_000;
const SLA_SYSTEM_ERROR_MS = 1_000;
const SLA_STANDARD_MS = 5_000;

@Injectable()
export class TradeJournalService {
  private readonly logger = new Logger(TradeJournalService.name);

  constructor(
    @InjectRepository(Signals)
    private readonly signalsRepo: Repository<Signals>,

    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,

    @InjectRepository(Execution)
    private readonly executionsRepo: Repository<Execution>,

    @InjectRepository(Position)
    private readonly positionsRepo: Repository<Position>,

    @InjectRepository(Trade)
    private readonly tradesRepo: Repository<Trade>,

    @InjectRepository(RiskEvents)
    private readonly riskEventsRepo: Repository<RiskEvents>,

    @InjectRepository(SystemHealthEvents)
    private readonly systemHealthEventsRepo: Repository<SystemHealthEvents>,

    @InjectRepository(AuditLogs)
    private readonly auditLogsRepo: Repository<AuditLogs>,

    private readonly eventEmitter: EventEmitter2,

    /**
     * @Optional() — AgentsModule may not be loaded in all test environments.
     * When present, settlement is called after a completed trade is journaled
     * so that research decisions accumulate outcome data for calibration.
     */
    @Optional()
    private readonly decisionMemory: DecisionMemoryService | null,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Public write methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Journal a new signal.
   *
   * Maps CreateSignalDto → Signals entity INSERT.
   * SLA: 5 seconds.
   *
   * Requirements: 13.1
   */
  async recordSignal(data: CreateSignalDto): Promise<void> {
    await this.writeWithRetry('signals', SLA_STANDARD_MS, () => this.insertSignal(data));
  }

  /**
   * Journal a rejected signal.
   *
   * Per Requirement 13.6: records instrument, strategy, entry timestamp,
   * rejection timestamp (via createdAt), composite score, all 8 component
   * scores, and rejection reason in the Signals table with status = 'rejected'.
   * SLA: 5 seconds.
   *
   * Requirements: 13.1, 13.6, 13.8
   */
  async recordRejectedSignal(data: RejectedSignalDto): Promise<void> {
    await this.writeWithRetry('rejected_signals', SLA_STANDARD_MS, () =>
      this.insertRejectedSignal(data),
    );
  }

  /**
   * Journal a new order.
   *
   * Maps CreateOrderDto → Order entity INSERT.
   * SLA: 5 seconds.
   *
   * Requirements: 13.1
   */
  async recordOrder(data: CreateOrderDto): Promise<void> {
    await this.writeWithRetry('orders', SLA_STANDARD_MS, () => this.insertOrder(data));
  }

  /**
   * Journal a fill (execution).
   *
   * Maps CreateFillDto → Execution entity INSERT.
   * SLA: 5 seconds.
   *
   * Requirements: 13.1
   */
  async recordFill(data: CreateFillDto): Promise<void> {
    await this.writeWithRetry('fills', SLA_STANDARD_MS, () => this.insertFill(data));
  }

  /**
   * Journal a new position.
   *
   * Maps CreatePositionDto → Position entity INSERT.
   * SLA: 5 seconds.
   *
   * Requirements: 13.1
   */
  async recordPosition(data: CreatePositionDto): Promise<void> {
    await this.writeWithRetry('positions', SLA_STANDARD_MS, () => this.insertPosition(data));
  }

  /**
   * Journal a completed trade.
   *
   * Per Requirement 13.2: records all 20+ fields including MFE, MAE,
   * per-component charges, exit reason, slippage, and Dhan order IDs.
   * SLA: 5 seconds.
   *
   * Requirements: 13.1, 13.2, 13.8
   */
  async recordCompletedTrade(data: CompletedTradeDto): Promise<void> {
    await this.writeWithRetry('completed_trades', SLA_STANDARD_MS, () =>
      this.insertCompletedTrade(data),
    );

    // Settle the agent research decision that preceded this trade, if any.
    // Non-blocking — a settlement failure must never block trade journaling.
    if (data.workflowId && this.decisionMemory) {
      const netPnl = parseFloat(data.netPnl);
      const outcome = netPnl > 0 ? 'PROFITABLE' : netPnl < 0 ? 'LOSS' : ('BREAKEVEN' as const);
      void this.decisionMemory
        .settle({
          workflowId: data.workflowId,
          wasExecuted: true,
          tradeId: data.positionId,
          actualNetPnl: netPnl,
          outcome,
          directionCorrect: netPnl >= 0,
        })
        .catch((err: Error) =>
          this.logger.warn(
            `Decision settlement failed for workflow ${data.workflowId}: ${err.message}`,
          ),
        );
    }
  }

  /**
   * Journal a risk event.
   *
   * Per Requirement 13.5: records event type, timestamp, triggering metric
   * name/value, threshold, affected instrument/strategy, and initiating actor.
   * SLA: 1 second (strict — risk events drive downstream safety decisions).
   *
   * Requirements: 13.1, 13.5
   */
  async recordRiskEvent(data: RiskEventDto): Promise<void> {
    await this.writeWithRetry('risk_events', SLA_RISK_EVENT_MS, () => this.insertRiskEvent(data));
  }

  /**
   * Journal a system error or module health event.
   *
   * Maps SystemErrorDto → SystemHealthEvents entity INSERT.
   * SLA: 1 second.
   *
   * Requirements: 13.1, 2.7
   */
  async recordSystemError(data: SystemErrorDto): Promise<void> {
    await this.writeWithRetry('system_errors', SLA_SYSTEM_ERROR_MS, () =>
      this.insertSystemError(data),
    );
  }

  /**
   * Journal a user-initiated configuration change.
   *
   * Per Requirement 13.4: records user_id, timestamp, field_name,
   * previous_value, and new_value in the AuditLogs table.
   * SLA: 5 seconds.
   *
   * Requirements: 13.1, 13.4, 13.8
   */
  async recordConfigChange(data: ConfigChangeDto): Promise<void> {
    await this.writeWithRetry('configuration_changes', SLA_STANDARD_MS, () =>
      this.insertConfigChange(data),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Entity mapping helpers (INSERT only — no UPDATE / DELETE)
  // ─────────────────────────────────────────────────────────────────────────────

  private async insertSignal(data: CreateSignalDto): Promise<void> {
    const entity = this.signalsRepo.create({
      strategy: { id: data.strategyId } as any,
      instrumentId: data.instrumentId,
      engine: data.engine,
      direction: data.direction,
      entryPrice: data.entryPrice,
      stopLossPrice: data.stopLossPrice,
      targetPrice: data.targetPrice,
      positionSize: data.positionSize,
      compositeScore: data.compositeScore,
      scoreRegimeAlignment: data.scoreRegimeAlignment,
      scorePriceStructure: data.scorePriceStructure,
      scoreVolumeConfirmation: data.scoreVolumeConfirmation,
      scoreMomentum: data.scoreMomentum,
      scoreVwapTrend: data.scoreVwapTrend,
      scoreOptionsFutures: data.scoreOptionsFutures,
      scoreLiquidityExecution: data.scoreLiquidityExecution,
      scoreRrQuality: data.scoreRrQuality,
      measuredInputs: data.measuredInputs,
      status: data.status,
      rejectionReason: data.rejectionReason ?? null,
      signalTimestamp: data.signalTimestamp,
      expiryTimestamp: data.expiryTimestamp ?? null,
      dhanOrderId: data.dhanOrderId ?? null,
      regime: data.regime ?? null,
    });
    await this.signalsRepo.save(entity);
  }

  private async insertRejectedSignal(data: RejectedSignalDto): Promise<void> {
    // Requirement 13.6: rejection timestamp is captured via `expiryTimestamp`
    // (the signal lifecycle ended at that point) and implicitly via `createdAt`.
    const entity = this.signalsRepo.create({
      strategy: { id: data.strategyId } as any,
      instrumentId: data.instrumentId,
      engine: data.engine,
      direction: data.direction,
      entryPrice: data.entryPrice,
      stopLossPrice: data.stopLossPrice,
      targetPrice: data.targetPrice,
      positionSize: data.positionSize,
      compositeScore: data.compositeScore,
      scoreRegimeAlignment: data.scoreRegimeAlignment,
      scorePriceStructure: data.scorePriceStructure,
      scoreVolumeConfirmation: data.scoreVolumeConfirmation,
      scoreMomentum: data.scoreMomentum,
      scoreVwapTrend: data.scoreVwapTrend,
      scoreOptionsFutures: data.scoreOptionsFutures,
      scoreLiquidityExecution: data.scoreLiquidityExecution,
      scoreRrQuality: data.scoreRrQuality,
      measuredInputs: data.measuredInputs ?? {},
      status: 'rejected',
      rejectionReason: data.rejectionReason,
      signalTimestamp: data.signalTimestamp,
      // Store rejection timestamp in expiryTimestamp for audit traceability
      expiryTimestamp: data.rejectionTimestamp,
      dhanOrderId: null,
      regime: data.regime ?? null,
    });
    await this.signalsRepo.save(entity);
  }

  private async insertOrder(data: CreateOrderDto): Promise<void> {
    const entity = this.ordersRepo.create({
      idempotency_key: data.idempotencyKey,
      engine: data.engine,
      signal_id: data.signalId ?? null,
      instrument_id: data.instrumentId,
      order_type: data.orderType,
      transaction_type: data.transactionType,
      quantity: data.quantity,
      price: data.price ?? null,
      trigger_price: data.triggerPrice ?? null,
      dhan_order_id: data.dhanOrderId ?? null,
      dhan_correlation_id: data.dhanCorrelationId ?? null,
      status: data.status,
      rejection_reason: data.rejectionReason ?? null,
      submitted_at: data.submittedAt ?? null,
      filled_quantity: 0,
      average_fill_price: null,
    });
    await this.ordersRepo.save(entity);
  }

  private async insertFill(data: CreateFillDto): Promise<void> {
    const entity = this.executionsRepo.create({
      order_id: data.orderId,
      engine: data.engine,
      dhan_trade_id: data.dhanTradeId ?? null,
      fill_price: data.fillPrice,
      fill_quantity: data.fillQuantity,
      fill_timestamp: data.fillTimestamp,
      slippage: data.slippage ?? null,
    });
    await this.executionsRepo.save(entity);
  }

  private async insertPosition(data: CreatePositionDto): Promise<void> {
    const entity = this.positionsRepo.create({
      engine: data.engine,
      instrument_id: data.instrumentId,
      signal_id: data.signalId ?? null,
      direction: data.direction,
      quantity: data.quantity,
      average_entry_price: data.averageEntryPrice,
      current_sl: data.currentSl ?? null,
      target_price: data.targetPrice ?? null,
      trailing_stop_mechanism: data.trailingStopMechanism ?? null,
      unrealized_pnl: '0',
      mfe: '0',
      mae: '0',
      is_open: true,
      opened_at: data.openedAt,
      closed_at: null,
    });
    await this.positionsRepo.save(entity);
  }

  private async insertCompletedTrade(data: CompletedTradeDto): Promise<void> {
    const entity = this.tradesRepo.create({
      position_id: data.positionId,
      instrument_id: data.instrumentId,
      strategy_id: data.strategyId,
      signal_id: data.signalId ?? null,
      engine: data.engine,
      direction: data.direction,
      quantity: data.quantity,
      lot_size: data.lotSize,
      entry_price: data.entryPrice,
      exit_price: data.exitPrice,
      entry_time: data.entryTime,
      exit_time: data.exitTime,
      mfe: data.mfe,
      mae: data.mae,
      gross_pnl: data.grossPnl,
      brokerage: data.brokerage,
      stt: data.stt,
      exchange_charges: data.exchangeCharges,
      gst: data.gst,
      sebi_charges: data.sebiCharges,
      stamp_duty: data.stampDuty,
      net_pnl: data.netPnl,
      exit_reason: data.exitReason,
      execution_slippage: data.executionSlippage,
      signal_score: data.signalScore ?? null,
      dhan_entry_order_id: data.dhanEntryOrderId ?? null,
      dhan_exit_order_id: data.dhanExitOrderId ?? null,
      // QCR and exit classification are computed by AnalyticsService post-close
      qcr: null,
      exit_classification: null,
      execution_quality: null,
    });
    await this.tradesRepo.save(entity);
  }

  private async insertRiskEvent(data: RiskEventDto): Promise<void> {
    const entity = this.riskEventsRepo.create({
      engine: data.engine,
      event_type: data.eventType,
      reason: data.reason,
      triggering_metric_name: data.triggeringMetricName ?? null,
      triggering_metric_value: data.triggeringMetricValue ?? null,
      threshold_value: data.thresholdValue ?? null,
      affected_instrument_id: data.affectedInstrumentId ?? null,
      affected_strategy_id: data.affectedStrategyId ?? null,
      initiating_actor: data.initiatingActor,
      occurred_at: data.occurredAt,
    });
    await this.riskEventsRepo.save(entity);
  }

  private async insertSystemError(data: SystemErrorDto): Promise<void> {
    const entity = this.systemHealthEventsRepo.create({
      event_type: data.eventType,
      module_name: data.moduleName,
      severity: data.severity,
      message: data.message,
      metadata: data.metadata ?? null,
      timestamp: data.timestamp,
    });
    await this.systemHealthEventsRepo.save(entity);
  }

  private async insertConfigChange(data: ConfigChangeDto): Promise<void> {
    const entity = this.auditLogsRepo.create({
      userId: data.userId,
      eventType: 'CONFIG_CHANGE',
      entityType: data.entityType,
      entityId: data.entityId,
      fieldName: data.fieldName,
      previousValue: data.previousValue,
      newValue: data.newValue,
      ipAddress: data.ipAddress ?? null,
      metadata: null,
      outcome: 'SUCCESS',
      // Auto-generated: callers do not supply a timestamp (Requirement 13.4)
      timestamp: new Date(),
    });
    await this.auditLogsRepo.save(entity);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Retry + SLA enforcement core
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute `operation` with up to MAX_RETRIES retries using exponential backoff.
   *
   * Contract:
   *   - Total retry window: ≤ RETRY_WINDOW_MS (30 seconds).
   *   - On each failure: wait RETRY_DELAYS_MS[attempt] before the next retry.
   *   - If all retries are exhausted: publish JOURNAL_WRITE_FAILED_EVENT via
   *     EventEmitter2 so the NotificationService can alert the operator.
   *   - Records are NEVER silently dropped (operator alert is the guarantee).
   *
   * SLA monitoring:
   *   - If the wall-clock time from call entry to successful INSERT exceeds
   *     `slaSoftLimitMs`, a WARNING is logged.
   *
   * @param recordType  Human-readable name of the journal record set (for alerts/logs).
   * @param slaSoftLimitMs  SLA threshold in milliseconds for this record type.
   * @param operation  Async write operation to attempt.
   */
  private async writeWithRetry(
    recordType: string,
    slaSoftLimitMs: number,
    operation: () => Promise<void>,
  ): Promise<void> {
    const writeStartedAt = Date.now();
    let lastError: Error = new Error('Unknown journal write failure');

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await operation();

        // ── SLA check ──────────────────────────────────────────────────────
        const elapsedMs = Date.now() - writeStartedAt;
        if (elapsedMs > slaSoftLimitMs) {
          this.logger.warn(
            `[TradeJournal] SLA breach on "${recordType}": ` +
              `write completed in ${elapsedMs} ms (SLA: ${slaSoftLimitMs} ms)`,
          );
        }

        return; // Success — exit immediately
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < MAX_RETRIES) {
          const delayMs = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
          const elapsedMs = Date.now() - writeStartedAt;
          const remainingMs = RETRY_WINDOW_MS - elapsedMs;

          if (remainingMs <= 0) {
            this.logger.warn(
              `[TradeJournal] Retry window (${RETRY_WINDOW_MS} ms) exhausted ` +
                `for "${recordType}" after attempt ${attempt + 1}.`,
            );
            break;
          }

          const actualDelayMs = Math.min(delayMs, remainingMs);

          this.logger.warn(
            `[TradeJournal] Write failed for "${recordType}" ` +
              `(attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}. ` +
              `Retrying in ${actualDelayMs} ms…`,
          );

          await TradeJournalService.sleep(actualDelayMs);
        }
      }
    }

    // ── All retries exhausted — emit operator alert ──────────────────────────
    // Requirement 13.7: emit an operator alert; never silently drop the record.
    this.logger.error(
      `[TradeJournal] All ${MAX_RETRIES} retries exhausted for "${recordType}". ` +
        `Failure reason: ${lastError.message}. Publishing operator alert.`,
    );

    const payload: JournalWriteFailedPayload = {
      recordType,
      failureReason: lastError.message,
      timestamp: new Date(),
    };

    this.eventEmitter.emit(JOURNAL_WRITE_FAILED_EVENT, payload);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Net P&L calculation helper (Requirements: 13.2)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute net P&L using string-based decimal arithmetic.
   *
   *   net_pnl = gross_pnl − (brokerage + stt + exchange_charges
   *                           + gst + sebi_charges + stamp_duty)
   *
   * All values are converted to integer 10,000ths (BigInt) to avoid IEEE-754
   * floating-point rounding errors.  The result is rounded half-up to 2
   * decimal places before being returned as a string.
   *
   * Requirements: 13.2
   */
  calculateNetPnl(dto: CompletedTradeDto): string {
    const gross = TradeJournalService.decimalToInt10k(dto.grossPnl);
    const totalCharges = [
      dto.brokerage,
      dto.stt,
      dto.exchangeCharges,
      dto.gst,
      dto.sebiCharges,
      dto.stampDuty,
    ].reduce((sum, charge) => sum + TradeJournalService.decimalToInt10k(charge), 0n);

    return TradeJournalService.int10kToDecimal2dp(gross - totalCharges);
  }

  /**
   * Convert a decimal string to an integer count of 10,000ths (BigInt).
   *
   * Handles negative values and up to 4 decimal places; digits beyond 4dp
   * are truncated (not rounded) at parse time, consistent with NUMERIC(x,4)
   * database storage.
   *
   * Examples:
   *   '100.00'   → 1_000_000n
   *   '-50.1250' → -501_250n
   *   '0'        → 0n
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
   *   1_004_250n → '100.43'  (0.0025 rounds up the 2nd decimal)
   *   -501_250n  → '-50.13'  (rounds magnitude half-up)
   *            0n → '0.00'
   *
   * Note: '-0.00' is normalised to '0.00'.
   */
  private static int10kToDecimal2dp(value: bigint): string {
    const isNegative = value < 0n;
    const abs = isNegative ? -value : value;

    // Round to nearest 100ths: if the last two digits (of 4dp) are ≥ 50, round up.
    const lastTwo = abs % 100n;
    const rounded100 = lastTwo >= 50n ? abs / 100n + 1n : abs / 100n;

    const wholePart = rounded100 / 100n;
    const fracPart = rounded100 % 100n;
    const result = `${wholePart}.${fracPart.toString().padStart(2, '0')}`;

    // Suppress '-0.00' — zero has no meaningful sign.
    return isNegative && result !== '0.00' ? `-${result}` : result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────────────────

  /** Promise-based sleep to avoid blocking the event loop. */
  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
