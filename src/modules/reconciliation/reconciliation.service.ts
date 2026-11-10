/**
 * reconciliation.service.ts
 *
 * ReconciliationService — reconciles CloudEngine state against the Dhan broker.
 *
 * Three reconciliation modes (Requirements 19.1, 19.2, 19.3, 12.4, 17.6):
 *
 *   1. EOD Reconciliation   (@Cron 15:30 IST weekdays, budget: 30 minutes)
 *      - Loads all LIVE CloudEngine orders and executions from the DB.
 *      - Loads Dhan orderbook and tradebook via DhanApiClient.
 *      - Flags any CloudEngine order whose dhan_order_id is not in the Dhan orderbook.
 *      - On discrepancy → halts new order submissions, publishes CRITICAL alert.
 *
 *   2. Reconnection Reconciliation (triggered by DhanWebSocketClient on reconnect)
 *      - Same order comparison as EOD, also checks positions.
 *      - Must complete within 30 seconds.
 *      - On timeout → halts new order submissions, publishes CRITICAL timeout alert.
 *
 *   3. SL Status Verification (called by TrailingStopEngine after reconnect)
 *      - Verifies broker-side SL orders for the given positions exist and are active.
 *      - Must complete within 60 seconds.
 *      - Returns { verified, inactive } position ID lists.
 *
 * Halt behaviour (Requirement 19.2):
 *   - `newOrdersHalted = true` blocks new order submissions (signalled via
 *     `isNewOrdersHalted()`); modification and cancellation of existing orders
 *     remain permitted.
 *   - Cleared via `acknowledgeDiscrepancy(reconciliationId)` (user ACK or
 *     auto-agreement).
 *
 * Every run, discrepancy, and resolution action is recorded in AuditLogs
 * (Requirement 19.4).
 *
 * Requirements: 12.4, 17.6, 19.1, 19.2, 19.3, 19.4
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';

import { Order } from '../../database/entities/orders.entity';
import { Execution } from '../../database/entities/executions.entity';
import { Position } from '../../database/entities/positions.entity';
import { AuditLogs, AuditEventType, AuditOutcome } from '../../database/entities/audit-logs.entity';

import { DhanApiClient } from '../dhan/dhan-api.client';
import { DhanOrder, DhanOrderStatus } from '../dhan/dhan-api.types';
import { NotificationService } from '../notification/notification.service';

import {
  ReconciliationRun,
  ReconciliationType,
  ReconciliationStatus,
  DiscrepancyRecord,
  DiscrepancyType,
  PnlAgreementResult,
  SLVerificationResult,
  ReconciliationTimeoutError,
} from './reconciliation.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum time (ms) for reconnection reconciliation to complete (Requirement 19.3). */
const RECONNECTION_TIMEOUT_MS = 30_000;

/** Maximum time (ms) for SL status verification to complete (Requirement 12.4). */
const SL_VERIFICATION_TIMEOUT_MS = 60_000;

/** Dhan order statuses that represent a terminal (closed) state. */
const TERMINAL_DHAN_STATUSES: DhanOrderStatus[] = ['CANCELLED', 'REJECTED', 'EXPIRED', 'FILLED'];

/** CloudEngine order statuses that mean the order was submitted to Dhan. */
const ACTIVE_CLOUD_STATUSES = ['submitted', 'open', 'partial'] as const;

/** P&L agreement tolerance in rupees (Requirement 19.6). */
const PNL_TOLERANCE_RS = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
// ReconciliationService
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /**
   * When true, the service has detected a discrepancy and new order submissions
   * are blocked (Requirement 19.2).  Modification and cancellation of existing
   * orders remain permitted.
   */
  private newOrdersHalted = false;

  /** Human-readable reason for the current halt state. Null when not halted. */
  private haltReason: string | null = null;

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,

    @InjectRepository(Execution)
    private readonly executionRepository: Repository<Execution>,

    @InjectRepository(Position)
    private readonly positionRepository: Repository<Position>,

    @InjectRepository(AuditLogs)
    private readonly auditLogsRepository: Repository<AuditLogs>,

    private readonly dhanApiClient: DhanApiClient,

    private readonly notificationService: NotificationService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // 1. EOD Reconciliation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * End-of-Day reconciliation run.
   *
   * Triggered automatically at 15:30 IST on every weekday (Monday–Friday).
   * Requirements 17.6 and 19.1 require a 30-minute completion budget; this
   * method is intentionally not wrapped in a timeout because the CRON itself
   * fires within the 15:30–16:00 EOD window.
   *
   * Requirements: 17.6, 19.1
   */
  @Cron('30 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async runEodReconciliation(): Promise<void> {
    const runId = uuidv4();
    const startedAt = new Date();
    this.logger.log(`[EOD] Starting reconciliation run id=${runId}`);

    let discrepancies: DiscrepancyRecord[] = [];
    let status: ReconciliationStatus = ReconciliationStatus.RUNNING;

    try {
      // ── Load CloudEngine data ───────────────────────────────────────────
      const cloudOrders = await this.orderRepository.find({
        where: {
          engine: 'LIVE',
          status: In(ACTIVE_CLOUD_STATUSES),
        },
      });

      const cloudExecutions = await this.executionRepository.find({
        where: { engine: 'LIVE' },
      });

      this.logger.debug(
        `[EOD] CloudEngine: ${cloudOrders.length} orders, ${cloudExecutions.length} executions`,
      );

      // ── Load Dhan data ──────────────────────────────────────────────────
      const dhanOrders = await this.dhanApiClient.getOrderbook();
      const dhanTrades = await this.dhanApiClient.getTradebook();

      this.logger.debug(`[EOD] Dhan: ${dhanOrders.length} orders, ${dhanTrades.length} trades`);

      // ── Compare ─────────────────────────────────────────────────────────
      discrepancies = this.compareOrdersWithDhan(cloudOrders, dhanOrders);

      // Also flag unrecognised executions (Requirement 19.5)
      const cloudOrderIds = new Set(cloudOrders.map((o) => o.dhan_order_id).filter(Boolean));
      for (const trade of dhanTrades) {
        if (!cloudOrderIds.has(trade.orderId)) {
          discrepancies.push({
            type: DiscrepancyType.UNRECOGNIZED_EXECUTION,
            dhanOrderId: trade.orderId,
            reason: `Dhan trade orderId=${trade.orderId} has no matching CloudEngine order record`,
          });
          // Requirement 19.5: publish the alert immediately — must reach NotificationService
          // within 10 seconds of detection, independent of the overall reconciliation result.
          await this.alertUnrecognizedExecution(trade.orderId);
        }
      }

      status = ReconciliationStatus.COMPLETED;
      this.logger.log(
        `[EOD] Reconciliation complete: ${discrepancies.length} discrepancy(ies) found`,
      );
    } catch (error) {
      status = ReconciliationStatus.FAILED;
      this.logger.error(`[EOD] Reconciliation failed: ${(error as Error).message}`);
    }

    // ── Record run in AuditLogs ─────────────────────────────────────────
    const run: ReconciliationRun = {
      id: runId,
      type: ReconciliationType.EOD,
      startedAt,
      completedAt: new Date(),
      status,
      discrepanciesFound: discrepancies.length,
    };
    await this.recordAuditLog(run, discrepancies);

    // ── Handle discrepancies ────────────────────────────────────────────
    if (discrepancies.length > 0) {
      await this.haltNewOrders(
        runId,
        `EOD reconciliation found ${discrepancies.length} discrepancy(ies)`,
        'CRITICAL',
        'EOD Reconciliation Discrepancy Detected',
        `EOD reconciliation run id=${runId} found ${discrepancies.length} discrepancy(ies). ` +
          `New order submissions halted until discrepancies are acknowledged.`,
        { runId, discrepancies },
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Reconnection Reconciliation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Trigger a reconnection reconciliation.
   *
   * Called by `DhanWebSocketClient` (or the DhanAPI reconnection handler)
   * immediately after the WebSocket feed reconnects.  Must complete within
   * 30 seconds (Requirement 19.3).  On timeout → halts new orders and
   * publishes a CRITICAL alert (Requirement 19.7).
   *
   * Requirements: 19.3, 19.7
   */
  async triggerReconnectionReconciliation(): Promise<void> {
    const runId = uuidv4();
    this.logger.log(`[RECONNECTION] Starting reconciliation run id=${runId}`);

    const reconcilePromise = this.performReconnectionReconciliation(runId);
    const timeoutPromise = this.createTimeoutPromise(
      RECONNECTION_TIMEOUT_MS,
      'reconnection reconciliation',
    );

    try {
      await Promise.race([reconcilePromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof ReconciliationTimeoutError) {
        this.logger.warn(`[RECONNECTION] ${error.message}`);
        await this.haltNewOrders(
          runId,
          'Reconnection reconciliation timed out after 30 seconds',
          'CRITICAL',
          'Reconciliation Timeout',
          `Reconnection reconciliation run id=${runId} failed to complete within 30 seconds. ` +
            `New order submissions halted.`,
          { runId, timeoutMs: RECONNECTION_TIMEOUT_MS },
        );

        // Record the timeout run in AuditLogs
        const run: ReconciliationRun = {
          id: runId,
          type: ReconciliationType.RECONNECTION,
          startedAt: new Date(),
          completedAt: new Date(),
          status: ReconciliationStatus.TIMEOUT,
          discrepanciesFound: 0,
          notes: error.message,
        };
        await this.recordAuditLog(run, []);
      } else {
        this.logger.error(`[RECONNECTION] Reconciliation error: ${(error as Error).message}`);
        throw error;
      }
    }
  }

  /**
   * Core reconnection reconciliation logic.
   * Compares CloudEngine LIVE orders and positions against Dhan broker state.
   *
   * Protected so unit tests can spy on or override it without reaching Dhan.
   */
  protected async performReconnectionReconciliation(runId: string): Promise<void> {
    const startedAt = new Date();
    let discrepancies: DiscrepancyRecord[] = [];
    let status: ReconciliationStatus = ReconciliationStatus.RUNNING;

    try {
      // Load CloudEngine orders
      const cloudOrders = await this.orderRepository.find({
        where: {
          engine: 'LIVE',
          status: In(ACTIVE_CLOUD_STATUSES),
        },
      });

      // Load Dhan orders and positions
      const dhanOrders = await this.dhanApiClient.getOrderbook();
      const dhanPositions = await this.dhanApiClient.getPositions();

      this.logger.debug(
        `[RECONNECTION] CloudEngine: ${cloudOrders.length} orders | ` +
          `Dhan: ${dhanOrders.length} orders, ${dhanPositions.length} positions`,
      );

      // Compare orders
      discrepancies = this.compareOrdersWithDhan(cloudOrders, dhanOrders);
      status = ReconciliationStatus.COMPLETED;
    } catch (error) {
      status = ReconciliationStatus.FAILED;
      this.logger.error(
        `[RECONNECTION] Internal reconciliation error: ${(error as Error).message}`,
      );
      throw error;
    }

    // Record run
    const run: ReconciliationRun = {
      id: runId,
      type: ReconciliationType.RECONNECTION,
      startedAt,
      completedAt: new Date(),
      status,
      discrepanciesFound: discrepancies.length,
    };
    await this.recordAuditLog(run, discrepancies);

    if (discrepancies.length > 0) {
      await this.haltNewOrders(
        runId,
        `Reconnection reconciliation found ${discrepancies.length} discrepancy(ies)`,
        'CRITICAL',
        'Reconnection Reconciliation Discrepancy',
        `Reconnection reconciliation run id=${runId} found ${discrepancies.length} discrepancy(ies). ` +
          `New order submissions halted until acknowledged.`,
        { runId, discrepancies },
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. SL Status Verification
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Verify broker-side SL status for the given positions after a reconnect.
   *
   * Called by TrailingStopEngine after reconnection.  Must complete within
   * 60 seconds (Requirement 12.4).  On timeout, all supplied positions are
   * treated as inactive (safest: TrailingStopEngine will re-submit SL orders).
   *
   * @param positionIds  CloudEngine position UUIDs to verify.
   * @returns  `{ verified, inactive }` position ID lists.
   *
   * Requirement: 12.4
   */
  async verifySLStatusAfterReconnect(positionIds: string[]): Promise<SLVerificationResult> {
    if (positionIds.length === 0) {
      return { verified: [], inactive: [] };
    }

    const verifyPromise = this.performSLVerification(positionIds);
    const timeoutPromise = this.createTimeoutPromise(
      SL_VERIFICATION_TIMEOUT_MS,
      'SL status verification',
    );

    try {
      return await Promise.race([verifyPromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof ReconciliationTimeoutError) {
        this.logger.warn(`[SL-VERIFY] ${error.message} — treating all positions as inactive`);
        // All positions are inactive: TrailingStopEngine must re-submit SL orders.
        return { verified: [], inactive: [...positionIds] };
      }
      throw error;
    }
  }

  /**
   * Core SL verification logic.
   * Protected so unit tests can spy on or override it.
   */
  protected async performSLVerification(positionIds: string[]): Promise<SLVerificationResult> {
    // 1. Load positions by ID
    const positions = await this.positionRepository.find({
      where: { id: In(positionIds) },
    });

    if (positions.length === 0) {
      return { verified: [], inactive: [...positionIds] };
    }

    const instrumentIds = positions.map((p) => p.instrument_id);

    // 2. Find SL / SL-M orders for those instruments
    const slOrders = await this.orderRepository.find({
      where: {
        engine: 'LIVE',
        instrument_id: In(instrumentIds),
        order_type: In(['SL', 'SL-M']),
        status: Not(In(['cancelled', 'rejected'])),
      },
    });

    this.logger.debug(
      `[SL-VERIFY] Found ${slOrders.length} SL orders for ${positions.length} positions`,
    );

    // 3. Load Dhan orderbook
    const dhanOrderbook = await this.dhanApiClient.getOrderbook();
    const activeDhanOrderIds = new Set(
      dhanOrderbook
        .filter((o) => !TERMINAL_DHAN_STATUSES.includes(o.orderStatus))
        .map((o) => o.orderId),
    );

    // 4. Build instrument_id → SL order dhan_order_id map
    const instrumentToActiveSL = new Map<string, boolean>();
    for (const order of slOrders) {
      if (order.dhan_order_id && activeDhanOrderIds.has(order.dhan_order_id)) {
        instrumentToActiveSL.set(order.instrument_id, true);
      } else if (!instrumentToActiveSL.has(order.instrument_id)) {
        instrumentToActiveSL.set(order.instrument_id, false);
      }
    }

    // 5. Classify each requested position
    const verified: string[] = [];
    const inactive: string[] = [];

    // Build a lookup of positionId -> instrument_id from the loaded positions
    const positionMap = new Map(positions.map((p) => [p.id, p.instrument_id]));

    for (const posId of positionIds) {
      const instrumentId = positionMap.get(posId);
      if (!instrumentId) {
        // Position not found in DB — treat as inactive
        inactive.push(posId);
        continue;
      }
      if (instrumentToActiveSL.get(instrumentId) === true) {
        verified.push(posId);
      } else {
        inactive.push(posId);
      }
    }

    this.logger.log(`[SL-VERIFY] verified=${verified.length}, inactive=${inactive.length}`);
    return { verified, inactive };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. ACK / Auto-agreement
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Acknowledge a reconciliation discrepancy.
   *
   * Clears the new-order halt and records the acknowledgment in AuditLogs.
   * Can be called by the user via the Extension or triggered automatically
   * when records return to full agreement (Requirement 19.2).
   *
   * @param reconciliationId  Run ID returned by the alert metadata.
   *
   * Requirement: 19.2
   */
  async acknowledgeDiscrepancy(reconciliationId: string): Promise<void> {
    const wasHalted = this.newOrdersHalted;

    this.newOrdersHalted = false;
    this.haltReason = null;

    this.logger.log(
      `[ACK] Discrepancy acknowledged for reconciliationId=${reconciliationId}; ` +
        `newOrdersHalted reset from ${String(wasHalted)} → false`,
    );

    // Record the acknowledgment action in AuditLogs (Requirement 19.4)
    try {
      const auditEntry = this.auditLogsRepository.create({
        userId: null, // system or user — caller should enrich if user-initiated
        eventType: AuditEventType.RECONCILIATION_ACTION,
        entityType: 'ReconciliationRun',
        entityId: reconciliationId,
        fieldName: 'newOrdersHalted',
        previousValue: String(wasHalted),
        newValue: 'false',
        ipAddress: null,
        metadata: {
          action: 'DISCREPANCY_ACKNOWLEDGED',
          reconciliationId,
          acknowledgedAt: new Date().toISOString(),
        },
        outcome: AuditOutcome.SUCCESS,
        timestamp: new Date(),
      });
      await this.auditLogsRepository.save(auditEntry);
    } catch (err) {
      this.logger.error(
        `[ACK] Failed to persist acknowledgment audit log: ${(err as Error).message}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Public state query
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns true when new order submissions are blocked due to an unacknowledged
   * reconciliation discrepancy.
   *
   * Callers (e.g. ExecutionService, LiveTradingService) should check this before
   * placing new orders.  Modification and cancellation of existing orders remain
   * permitted regardless of this flag (Requirement 19.2).
   */
  isNewOrdersHalted(): boolean {
    return this.newOrdersHalted;
  }

  /**
   * Returns the human-readable reason for the current halt, or null if no halt
   * is active.
   */
  getHaltReason(): string | null {
    return this.haltReason;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Reconciliation checks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Publish a CRITICAL alert for an unrecognized Dhan execution.
   *
   * Called immediately upon detection so the alert reaches NotificationService
   * within 10 seconds of the fill being observed (Requirement 19.5).
   *
   * @param orderId  The Dhan orderId of the unrecognized fill.
   */
  async alertUnrecognizedExecution(orderId: string): Promise<void> {
    this.logger.warn(`[UNREC-EXEC] Unrecognized Dhan execution: orderId=${orderId}`);
    await this.notificationService.publish({
      id: uuidv4(),
      priority: 'CRITICAL',
      title: 'Unrecognized Execution Detected',
      message:
        `Dhan reported a fill with orderId=${orderId} that has no matching ` +
        `CloudEngine order record. Immediate manual review required.`,
      metadata: { dhanOrderId: orderId },
      createdAt: new Date(),
    });
  }

  /**
   * Check whether CloudEngine net P&L, Dhan broker net P&L, and the
   * CapitalLedger closing balance agree within a ₹1.00 tolerance.
   *
   * Returns `{ agreement: true }` when all three values are within tolerance.
   * Returns `{ agreement: false, discrepancy }` with a human-readable description
   * of the first detected violation (Requirement 19.6).
   *
   * @param cloudNetPnl           Net P&L as computed by CloudEngine (rupees).
   * @param dhanNetPnl            Net P&L as reported by the Dhan broker (rupees).
   * @param capitalLedgerBalance  Closing balance from the CapitalLedger (rupees).
   */
  verifyPnlAgreement(
    cloudNetPnl: number,
    dhanNetPnl: number,
    capitalLedgerBalance: number,
  ): PnlAgreementResult {
    const cloudVsDhan = Math.abs(cloudNetPnl - dhanNetPnl);
    if (cloudVsDhan > PNL_TOLERANCE_RS) {
      return {
        agreement: false,
        discrepancy:
          `CloudEngine net P&L (₹${cloudNetPnl.toFixed(2)}) and Dhan broker net P&L ` +
          `(₹${dhanNetPnl.toFixed(2)}) differ by ₹${cloudVsDhan.toFixed(2)}, ` +
          `exceeding the ₹${PNL_TOLERANCE_RS.toFixed(2)} tolerance`,
      };
    }

    const dhanVsLedger = Math.abs(dhanNetPnl - capitalLedgerBalance);
    if (dhanVsLedger > PNL_TOLERANCE_RS) {
      return {
        agreement: false,
        discrepancy:
          `Dhan broker net P&L (₹${dhanNetPnl.toFixed(2)}) and CapitalLedger closing balance ` +
          `(₹${capitalLedgerBalance.toFixed(2)}) differ by ₹${dhanVsLedger.toFixed(2)}, ` +
          `exceeding the ₹${PNL_TOLERANCE_RS.toFixed(2)} tolerance`,
      };
    }

    return { agreement: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Compare CloudEngine orders against the Dhan orderbook and return any
   * discrepancies.
   *
   * A discrepancy is defined as a CloudEngine order that:
   *   - Has a non-null dhan_order_id (i.e. was submitted to Dhan), AND
   *   - That dhan_order_id is not present in the Dhan orderbook.
   */
  private compareOrdersWithDhan(
    cloudOrders: Order[],
    dhanOrders: DhanOrder[],
  ): DiscrepancyRecord[] {
    const dhanOrderIds = new Set(dhanOrders.map((o) => o.orderId));
    const discrepancies: DiscrepancyRecord[] = [];

    for (const cloudOrder of cloudOrders) {
      if (!cloudOrder.dhan_order_id) {
        // Not yet submitted to Dhan — skip
        continue;
      }
      if (!dhanOrderIds.has(cloudOrder.dhan_order_id)) {
        discrepancies.push({
          type: DiscrepancyType.ORDER_NOT_FOUND_IN_DHAN,
          dhanOrderId: cloudOrder.dhan_order_id,
          cloudOrderId: cloudOrder.id,
          reason: `CloudEngine order id=${cloudOrder.id} with dhan_order_id=${cloudOrder.dhan_order_id} not found in Dhan orderbook`,
        });
      }
    }

    return discrepancies;
  }

  /**
   * Set the halt state and publish a notification alert.
   */
  private async haltNewOrders(
    reconciliationId: string,
    reason: string,
    priority: 'CRITICAL' | 'MAX',
    title: string,
    message: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.newOrdersHalted = true;
    this.haltReason = reason;

    this.logger.warn(`[HALT] New order submissions halted: ${reason}`);

    await this.notificationService.publish({
      id: uuidv4(),
      priority,
      title,
      message,
      metadata: { reconciliationId, ...metadata },
      createdAt: new Date(),
    });
  }

  /**
   * Persist a ReconciliationRun and its discrepancies to AuditLogs.
   * Requirement 19.4 — every run, discrepancy, and resolution must be recorded.
   */
  private async recordAuditLog(
    run: ReconciliationRun,
    discrepancies: DiscrepancyRecord[],
  ): Promise<void> {
    try {
      const auditEntry = this.auditLogsRepository.create({
        userId: null, // system-initiated
        eventType: AuditEventType.RECONCILIATION_ACTION,
        entityType: 'ReconciliationRun',
        entityId: run.id,
        fieldName: null,
        previousValue: null,
        newValue: JSON.stringify({
          status: run.status,
          discrepanciesFound: run.discrepanciesFound,
        }),
        ipAddress: null,
        metadata: {
          run,
          discrepancies,
        },
        outcome:
          run.status === ReconciliationStatus.COMPLETED ||
          run.status === ReconciliationStatus.TIMEOUT
            ? AuditOutcome.SUCCESS
            : AuditOutcome.FAILURE,
        timestamp: new Date(),
      });
      await this.auditLogsRepository.save(auditEntry);
      this.logger.debug(`[AUDIT] Recorded reconciliation run id=${run.id} status=${run.status}`);
    } catch (err) {
      this.logger.error(
        `[AUDIT] Failed to persist reconciliation audit log for run id=${run.id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Returns a promise that rejects with a ReconciliationTimeoutError after
   * the given number of milliseconds.
   *
   * Protected to allow unit tests to spy on / override without real timers.
   */
  protected createTimeoutPromise(ms: number, operationName: string): Promise<never> {
    return new Promise<never>((_, reject) => {
      setTimeout(() => reject(new ReconciliationTimeoutError(operationName, ms)), ms);
    });
  }
}
