/**
 * execution.service.ts
 *
 * ExecutionService — full order lifecycle management with idempotency guard
 * plus 5-check pre-trade validation chain.
 *
 * Idempotency guard (Requirements 16.6, 16.7):
 *   0. Redis key `orders:idempotency:{key}` already set → reject "duplicate-order-rejected"
 *      Returns the existing orderId so callers can safely retry.
 *      After successful placement the key is written with TTL = 300 s.
 *
 * Armed-state gates (Requirements 11.1, 11.3) — LIVE engine only:
 *   0a. LiveTradingService.isArmed() === false  → reject "engine-not-armed"
 *   0b. LiveTradingService.isNewEntryBlocked()  → reject "entry-blocked"
 *       (covers CLOSING phase, TWO_LOSS_LOCKOUT, EMERGENCY_HALT, kill switch)
 *
 * Pre-trade validation chain (Requirements 11.3, 11.4):
 *   1. compositeScore ≥ 80           → reject "score-below-threshold"
 *   2. RiskManagementService approval → reject "risk-engine-rejected"
 *   3. Available margin ≥ required    → reject "insufficient-margin"
 *   4. No duplicate open order        → reject "duplicate-order"
 *   5. Active trading session phase   → reject "session-time-violation"
 *
 * Checks run in this exact order; the first failure stops the chain and no
 * broker submission is made.  All checks pass → order submitted to Dhan,
 * persisted to Orders table with idempotency_key, Redis key stored.
 *
 * Fill events update Orders status and insert a row into Executions.
 *
 * Requirements: 11.3, 11.4, 16.6, 16.7
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Execution } from '../../database/entities/executions.entity';
import { Order } from '../../database/entities/orders.entity';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { DhanOrderType } from '../dhan/dhan-api.types';
import { RiskManagementService } from '../risk-management/risk-management.service';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { SessionPhase } from '../session-manager/session-manager.types';
import { LiveTradingService } from '../live-trading/live-trading.service';
import { SecretsService } from '../secrets/secrets.service';
import { RedisService } from '../redis/redis.service';

import {
  FillData,
  OrderModification,
  OrderRequest,
  OrderResponse,
  PreTradeCheck,
  PreTradeCheckResult,
} from './execution.types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Redis key prefix for order idempotency entries.
 * Full key: `orders:idempotency:{idempotencyKey}`
 * TTL: 300 seconds (5 minutes).  Requirements 16.6, 16.7.
 */
const IDEMPOTENCY_KEY_PREFIX = 'orders:idempotency:';
const IDEMPOTENCY_TTL_SECONDS = 300;

/**
 * Session phases that allow new order entry.
 * Any phase NOT in this set is treated as a session-time-violation.
 *
 * Valid active trading phases: OPENING_VOLATILITY through AFTERNOON (09:15–14:30).
 * Closing (≥ 14:30) and market-closed windows block new orders.
 */
const ACTIVE_TRADING_PHASES = new Set<SessionPhase>([
  SessionPhase.OPENING_VOLATILITY,
  SessionPhase.ORB_FORMATION,
  SessionPhase.MORNING_MOMENTUM,
  SessionPhase.MID_SESSION,
  SessionPhase.AFTERNOON,
]);

/** Map from entity OrderType to the matching Dhan API orderType string. */
const ORDER_TYPE_MAP: Record<'MARKET' | 'LIMIT' | 'SL' | 'SL-M', DhanOrderType> = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  SL: 'STOP_LOSS',
  'SL-M': 'STOP_LOSS_MARKET',
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,

    @InjectRepository(Execution)
    private readonly executionsRepo: Repository<Execution>,

    private readonly dhanApiClient: DhanApiClient,
    private readonly riskManagementService: RiskManagementService,
    private readonly sessionManagerService: SessionManagerService,
    private readonly liveTradingService: LiveTradingService,
    private readonly secretsService: SecretsService,
    private readonly redisService: RedisService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run the 5-check pre-trade validation chain, then place the order via
   * DhanApiClient and persist it to the Orders table.
   *
   * Returns an OrderResponse indicating success or the name of the failing check.
   *
   * Requirements: 11.3, 11.4
   */
  async placeOrder(orderRequest: OrderRequest): Promise<OrderResponse> {
    // ── Check 0a/0b: Armed-state guards — LIVE engine only ───────────────────
    // PAPER orders bypass the armed-state machine entirely; they run in a fully
    // isolated simulation and must never be blocked by the live safety switch.
    //
    // For LIVE orders:
    //   0a. Engine must be in the ARMED state (Req 11.1, 11.3).
    //       DISARMED or ARMED_PENDING → reject immediately.
    //   0b. New entries must not be blocked (Req 17.3, 11.3).
    //       Covers: CLOSING phase, TWO_LOSS_LOCKOUT, EMERGENCY_HALT, kill switch.
    if (orderRequest.engine === 'LIVE') {
      if (!this.liveTradingService.isArmed()) {
        this.logger.warn(
          `[PreTrade] LIVE order rejected — engine is not ARMED ` +
            `(state=${this.liveTradingService.getArmedState()})`,
        );
        return {
          orderId: null,
          dhanOrderId: null,
          status: 'rejected',
          rejectedBy: 'engine-not-armed',
          rejectionReason:
            'Live trading engine is not armed — arm the engine before placing orders',
        };
      }

      if (this.liveTradingService.isNewEntryBlocked()) {
        this.logger.warn(
          `[PreTrade] LIVE order rejected — new entries are blocked ` +
            `(session phase or risk state prevents new entries)`,
        );
        return {
          orderId: null,
          dhanOrderId: null,
          status: 'rejected',
          rejectedBy: 'entry-blocked',
          rejectionReason:
            'New entries blocked: session is in CLOSING/EOD phase, or TWO_LOSS_LOCKOUT/EMERGENCY_HALT is active',
        };
      }
    }

    // ── Check 0: Idempotency (Redis) ─────────────────────────────────────────
    const idempotencyCheck = await this.checkIdempotency(orderRequest.idempotencyKey);
    if (!idempotencyCheck.passed) {
      this.logger.debug(
        `[PreTrade] Idempotency check FAILED for key=${orderRequest.idempotencyKey}: ` +
          `order already exists with id=${idempotencyCheck.existingOrderId}`,
      );
      return {
        orderId: idempotencyCheck.existingOrderId!,
        dhanOrderId: null,
        status: 'rejected',
        rejectedBy: 'duplicate-order-rejected',
        rejectionReason: `Duplicate request: idempotency key '${orderRequest.idempotencyKey}' was already processed`,
      };
    }

    // ── Check 1: Composite score ─────────────────────────────────────────────
    const scoreCheck = this.checkCompositeScore(orderRequest.compositeScore);
    if (!scoreCheck.passed) {
      this.logger.debug(
        `[PreTrade] Check 1 FAILED for instrument=${orderRequest.instrumentId}: ${scoreCheck.reason}`,
      );
      return this.buildRejectedResponse(scoreCheck.failingCheck!, scoreCheck.reason!);
    }

    // ── Check 2: RiskEngine approval ─────────────────────────────────────────
    const riskCheck = this.checkRiskEngine(orderRequest);
    if (!riskCheck.passed) {
      this.logger.debug(
        `[PreTrade] Check 2 FAILED for instrument=${orderRequest.instrumentId}: ${riskCheck.reason}`,
      );
      return this.buildRejectedResponse(riskCheck.failingCheck!, riskCheck.reason!);
    }

    // ── Check 3: Available margin ────────────────────────────────────────────
    const marginCheck = await this.checkMargin(orderRequest.requiredMargin);
    if (!marginCheck.passed) {
      this.logger.debug(
        `[PreTrade] Check 3 FAILED for instrument=${orderRequest.instrumentId}: ${marginCheck.reason}`,
      );
      return this.buildRejectedResponse(marginCheck.failingCheck!, marginCheck.reason!);
    }

    // ── Check 4: Duplicate order ─────────────────────────────────────────────
    const duplicateCheck = await this.checkDuplicateOrder(
      orderRequest.instrumentId,
      orderRequest.transactionType,
    );
    if (!duplicateCheck.passed) {
      this.logger.debug(
        `[PreTrade] Check 4 FAILED for instrument=${orderRequest.instrumentId}: ${duplicateCheck.reason}`,
      );
      return this.buildRejectedResponse(duplicateCheck.failingCheck!, duplicateCheck.reason!);
    }

    // ── Check 5: Session timing ──────────────────────────────────────────────
    const sessionCheck = this.checkSessionPhase();
    if (!sessionCheck.passed) {
      this.logger.debug(
        `[PreTrade] Check 5 FAILED for instrument=${orderRequest.instrumentId}: ${sessionCheck.reason}`,
      );
      return this.buildRejectedResponse(sessionCheck.failingCheck!, sessionCheck.reason!);
    }

    // ── All checks passed: submit to broker ──────────────────────────────────
    this.logger.log(
      `[Execution] All pre-trade checks passed for instrument=${orderRequest.instrumentId}; submitting to Dhan`,
    );

    const dhanClientId = await this.secretsService.get('DHAN_CLIENT_ID');

    const dhanResponse = await this.dhanApiClient.placeOrder({
      dhanClientId,
      correlationId: orderRequest.idempotencyKey.slice(0, 30),
      transactionType: orderRequest.transactionType,
      exchangeSegment: orderRequest.exchangeSegment,
      productType: orderRequest.productType,
      orderType: ORDER_TYPE_MAP[orderRequest.orderType],
      validity: 'DAY',
      securityId: orderRequest.securityId,
      quantity: orderRequest.quantity,
      price: orderRequest.price,
      triggerPrice: orderRequest.triggerPrice,
    });

    // ── Persist to Orders table ───────────────────────────────────────────────
    const order = this.ordersRepo.create({
      idempotency_key: orderRequest.idempotencyKey,
      engine: orderRequest.engine,
      signal_id: orderRequest.signalId ?? null,
      instrument_id: orderRequest.instrumentId,
      order_type: orderRequest.orderType,
      transaction_type: orderRequest.transactionType,
      quantity: orderRequest.quantity,
      price: orderRequest.price != null ? String(orderRequest.price) : null,
      trigger_price: orderRequest.triggerPrice != null ? String(orderRequest.triggerPrice) : null,
      dhan_order_id: dhanResponse.orderId,
      dhan_correlation_id: orderRequest.idempotencyKey.slice(0, 30),
      status: 'submitted',
      submitted_at: new Date(),
      filled_quantity: 0,
    });

    const saved = await this.ordersRepo.save(order);

    // ── Store idempotency key in Redis (TTL = 5 minutes) ─────────────────────
    await this.redisService.set(
      `${IDEMPOTENCY_KEY_PREFIX}${orderRequest.idempotencyKey}`,
      saved.id,
      IDEMPOTENCY_TTL_SECONDS,
    );

    this.logger.log(
      `[Execution] Order persisted: db_id=${saved.id}, dhan_order_id=${dhanResponse.orderId}`,
    );

    return {
      orderId: saved.id,
      dhanOrderId: dhanResponse.orderId,
      status: 'submitted',
    };
  }

  /**
   * Modify an existing pending or open order via DhanApiClient and update the
   * Orders table.
   *
   * @param orderId      DB UUID of the order to modify.
   * @param modification Fields to change.
   */
  async modifyOrder(orderId: string, modification: OrderModification): Promise<OrderResponse> {
    const order = await this.findOrderOrThrow(orderId);
    const dhanClientId = await this.secretsService.get('DHAN_CLIENT_ID');

    const targetOrderType = modification.orderType ?? order.order_type;
    const targetQuantity = modification.quantity ?? order.quantity;

    await this.dhanApiClient.modifyOrder(order.dhan_order_id!, {
      dhanClientId,
      orderId: order.dhan_order_id!,
      orderType: ORDER_TYPE_MAP[targetOrderType],
      quantity: targetQuantity,
      price: modification.price,
      disclosedQuantity: modification.disclosedQuantity,
      triggerPrice: modification.triggerPrice,
      validity: 'DAY',
    });

    // Update DB record
    if (modification.orderType) order.order_type = modification.orderType;
    if (modification.quantity != null) order.quantity = modification.quantity;
    if (modification.price != null) order.price = String(modification.price);
    if (modification.triggerPrice != null) order.trigger_price = String(modification.triggerPrice);

    const updated = await this.ordersRepo.save(order);

    this.logger.log(`[Execution] Order modified: db_id=${orderId}`);

    return {
      orderId: updated.id,
      dhanOrderId: updated.dhan_order_id,
      status: updated.status as OrderResponse['status'],
    };
  }

  /**
   * Cancel an existing pending or open order via DhanApiClient and update the
   * Orders table with status CANCELLED.
   *
   * @param orderId  DB UUID of the order to cancel.
   */
  async cancelOrder(orderId: string): Promise<OrderResponse> {
    const order = await this.findOrderOrThrow(orderId);

    await this.dhanApiClient.cancelOrder(order.dhan_order_id!);

    order.status = 'cancelled';
    const updated = await this.ordersRepo.save(order);

    this.logger.log(`[Execution] Order cancelled: db_id=${orderId}`);

    return {
      orderId: updated.id,
      dhanOrderId: updated.dhan_order_id,
      status: 'cancelled',
    };
  }

  /**
   * Process a fill event: update the parent Order's filled_quantity,
   * average_fill_price, and status; insert a row into the Executions table.
   *
   * @param fillData  Fill details received from the broker feed.
   */
  async handleFill(fillData: FillData): Promise<void> {
    const order = await this.findOrderOrThrow(fillData.orderId);

    const prevFilled = order.filled_quantity;
    const newFilled = prevFilled + fillData.fillQuantity;

    // VWAP calculation: (old_avg * old_qty + fill_price * fill_qty) / new_qty
    const prevAvg = order.average_fill_price != null ? parseFloat(order.average_fill_price) : 0;
    const fillPrice = parseFloat(fillData.fillPrice);
    const newAvg =
      newFilled > 0
        ? (prevAvg * prevFilled + fillPrice * fillData.fillQuantity) / newFilled
        : fillPrice;

    order.filled_quantity = newFilled;
    order.average_fill_price = newAvg.toFixed(2);
    order.status = newFilled >= order.quantity ? 'complete' : 'partial';

    await this.ordersRepo.save(order);

    // Insert Execution record
    const execution = this.executionsRepo.create({
      order_id: order.id,
      engine: fillData.engine,
      dhan_trade_id: fillData.dhanTradeId ?? null,
      fill_price: fillData.fillPrice,
      fill_quantity: fillData.fillQuantity,
      fill_timestamp: fillData.fillTimestamp,
      slippage: fillData.slippage ?? null,
    });

    await this.executionsRepo.save(execution);

    this.logger.log(
      `[Execution] Fill processed: order=${fillData.orderId}, ` +
        `qty=${fillData.fillQuantity}@${fillData.fillPrice}, ` +
        `total_filled=${newFilled}/${order.quantity}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Pre-trade check implementations
  // ---------------------------------------------------------------------------

  /**
   * Check 0 — idempotency guard (Requirements 16.6, 16.7).
   * Looks up `orders:idempotency:{key}` in Redis.
   * If the key exists the value is the existing DB orderId — return it so the
   * caller can safely retry without double-submitting to the broker.
   */
  private async checkIdempotency(
    idempotencyKey: string,
  ): Promise<{ passed: boolean; existingOrderId?: string }> {
    const redisKey = `${IDEMPOTENCY_KEY_PREFIX}${idempotencyKey}`;
    const existingOrderId = await this.redisService.get(redisKey);
    if (existingOrderId !== null) {
      return { passed: false, existingOrderId };
    }
    return { passed: true };
  }

  /**
   * Check 1 — compositeScore ≥ 80.
   * Runs synchronously; no external calls.
   */
  private checkCompositeScore(compositeScore: number): PreTradeCheckResult {
    if (compositeScore < 80) {
      return {
        passed: false,
        failingCheck: 'score-below-threshold',
        reason: `Composite score ${compositeScore} is below the required minimum of 80`,
      };
    }
    return { passed: true };
  }

  /**
   * Check 2 — RiskManagementService.evaluatePreEntryGates() must approve.
   * Synchronous — the RiskManagementService is a pure computation unit.
   */
  private checkRiskEngine(orderRequest: OrderRequest): PreTradeCheckResult {
    const result = this.riskManagementService.evaluatePreEntryGates({
      compositeScore: orderRequest.compositeScore,
      entryPrice: orderRequest.entryPrice,
      stopLossPrice: orderRequest.stopLossPrice,
      lotSize: orderRequest.lotSize,
      dynamicCapital: orderRequest.dynamicCapital,
      riskPercentage: orderRequest.riskPercentage,
      currentTotalExposure: orderRequest.currentTotalExposure,
      currentCorrelatedExposure: orderRequest.currentCorrelatedExposure,
      currentInstrumentExposure: orderRequest.currentInstrumentExposure,
      openPositionsCount: orderRequest.openPositionsCount,
      engine: orderRequest.engine as 'LIVE' | 'PAPER',
    });

    if (!result.approved) {
      return {
        passed: false,
        failingCheck: 'risk-engine-rejected',
        reason: `Risk engine rejected: ${result.reason} (gate: ${result.failingGate})`,
      };
    }
    return { passed: true };
  }

  /**
   * Check 3 — available margin ≥ required margin.
   * Calls DhanApiClient.getFundLimit() to retrieve the available balance.
   */
  private async checkMargin(requiredMargin: number): Promise<PreTradeCheckResult> {
    const fundLimit = await this.dhanApiClient.getFundLimit();
    // Note: Dhan API has a typo in the field name (`availabelBalance`)
    if (fundLimit.availabelBalance < requiredMargin) {
      return {
        passed: false,
        failingCheck: 'insufficient-margin',
        reason: `Available margin ₹${fundLimit.availabelBalance} is below required ₹${requiredMargin}`,
      };
    }
    return { passed: true };
  }

  /**
   * Check 4 — no existing PENDING or OPEN order for the same instrument + direction.
   * Queries the Orders table.
   */
  private async checkDuplicateOrder(
    instrumentId: string,
    transactionType: 'BUY' | 'SELL',
  ): Promise<PreTradeCheckResult> {
    const existing = await this.ordersRepo.findOne({
      where: {
        instrument_id: instrumentId,
        transaction_type: transactionType,
        status: In(['pending', 'submitted', 'open', 'partial']),
      },
    });

    if (existing) {
      return {
        passed: false,
        failingCheck: 'duplicate-order',
        reason:
          `Duplicate order detected: order ${existing.id} is already ${existing.status} ` +
          `for instrument=${instrumentId} direction=${transactionType}`,
      };
    }
    return { passed: true };
  }

  /**
   * Check 5 — current IST time must be in an active trading phase (not CLOSING or later).
   * Uses SessionManagerService.getCurrentPhase() (synchronous).
   */
  private checkSessionPhase(): PreTradeCheckResult {
    const phase = this.sessionManagerService.getCurrentPhase();
    if (!ACTIVE_TRADING_PHASES.has(phase)) {
      return {
        passed: false,
        failingCheck: 'session-time-violation',
        reason: `Order rejected: current session phase '${phase}' does not allow new entries`,
      };
    }
    return { passed: true };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Find an Order by its DB UUID, throwing NotFoundException if not found.
   */
  private async findOrderOrThrow(orderId: string): Promise<Order> {
    const order = await this.ordersRepo.findOne({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }
    return order;
  }

  /** Build an OrderResponse for a rejected pre-trade check (no DB persistence). */
  private buildRejectedResponse(failingCheck: PreTradeCheck, reason: string): OrderResponse {
    return {
      orderId: null,
      dhanOrderId: null,
      status: 'rejected',
      rejectedBy: failingCheck,
      rejectionReason: reason,
    };
  }
}
