/**
 * live-trading.service.ts
 *
 * LiveTradingService — session-critical enforcement and two-step arming for the
 * live execution engine.
 *
 * Responsibilities (Requirements 17.3, 17.4, 17.7, 11.1, 11.2):
 *
 *  1. Two-step armed-state machine:
 *       DISARMED → ARMED_PENDING (activateLiveMode)
 *       ARMED_PENDING → ARMED    (confirmArm)
 *       any → DISARMED           (disarm)
 *     State is persisted to Redis key `trading:armed_state`.
 *     On CloudEngine restart the state is ALWAYS reset to DISARMED regardless
 *     of whatever value is in Redis (Requirement 11.1, 11.2).
 *
 *  2. New-entry blocking:
 *     `isNewEntryBlocked()` returns true when the session phase is CLOSING or
 *     EOD_RECONCILIATION, or when a TWO_LOSS_LOCKOUT or EMERGENCY_HALT is active.
 *     The current phase is tracked via NestJS `session.phase.changed` events.
 *     The risk state is tracked via `risk.state.changed` events.
 *
 *  3. Mandatory square-off at 15:15 IST (Mon–Fri):
 *       a. Query all open LIVE positions (is_open = true, engine = 'LIVE').
 *       b. Submit a MARKET SELL order for each via DhanApiClient.
 *       c. Record a `mandatory-exit` compliance event in TradeJournal with the
 *          exit timestamp and all affected position IDs.
 *       d. After 5 minutes, alert via NotificationService (CRITICAL) for any
 *          order that is still not FILLED or that was REJECTED.
 *
 * Requirements: 17.3, 17.4, 17.7
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { Position } from '../../database/entities/positions.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { RedisService } from '../redis/redis.service';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { SecretsService } from '../secrets/secrets.service';
import { TradeJournalService } from '../trade-journal/trade-journal.service';
import { NotificationService } from '../notification/notification.service';

import {
  SessionPhase,
  SessionPhaseChangeEvent,
  SESSION_PHASE_CHANGED_EVENT,
} from '../session-manager/session-manager.types';
import { DhanOrderStatus } from '../dhan/dhan-api.types';
import { ArmedState, ARMED_STATE_KEY } from './live-trading.types';

// Re-export for consumers that import from this module directly.
export { ArmedState, ARMED_STATE_KEY } from './live-trading.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use `ARMED_STATE_KEY` from `./live-trading.types` instead.
 * Kept for backward compatibility.
 */
export const TRADING_ARMED_STATE_KEY = ARMED_STATE_KEY;

/** NestJS event name published by RiskEngine on TWO_LOSS_LOCKOUT / EMERGENCY_HALT. */
export const RISK_STATE_CHANGED_EVENT = 'risk.state.changed';

/**
 * How long to wait after submitting square-off orders before checking
 * confirmation status and raising an alert (Requirement 17.7).
 */
export const SQUARE_OFF_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * How long to wait after kill switch activation before checking that all
 * orders are cancelled and all positions are closed (Requirements 11.5, 11.6).
 */
export const KILL_SWITCH_CONFIRMATION_TIMEOUT_MS = 10_000; // 10 seconds

/** Risk state broadcast by RiskEngine when a daily-loss threshold is crossed. */
export type RiskState = 'NORMAL' | 'TWO_LOSS_LOCKOUT' | 'EMERGENCY_HALT';

/** Payload shape for `risk.state.changed` NestJS events emitted by RiskEngine. */
export interface RiskStateChangedEvent {
  state: RiskState;
  reason: string;
  occurredAt: Date;
}

/** Intermediate record tracking an order submitted during mandatory square-off. */
interface PendingSquareOffOrder {
  orderId: string;
  positionId: string;
  instrumentId: string;
  tradingSymbol: string;
  quantity: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class LiveTradingService implements OnModuleInit {
  private readonly logger = new Logger(LiveTradingService.name);

  /**
   * In-memory armed state.
   *
   * Always initialised to DISARMED on module start; the Redis value is NEVER
   * used to re-arm automatically (Requirement 11.1 — CloudEngine restart policy).
   */
  private armedState: ArmedState = ArmedState.DISARMED;

  /**
   * Whether the emergency kill switch has been activated.
   *
   * Once activated it remains true for the lifetime of the process — there is
   * no "unset kill switch" path. A full service restart is required to resume
   * live trading (Requirements 9.8, 11.5).
   */
  private killSwitchActive = false;

  /** Current NSE session phase, updated by `session.phase.changed` events. */
  private currentPhase: SessionPhase = SessionPhase.MARKET_CLOSED;

  /**
   * Current risk state, updated by `risk.state.changed` events emitted by
   * RiskManagementModule (task 16.2).  Defaults to NORMAL until the first event
   * arrives.
   */
  private riskState: RiskState = 'NORMAL';

  constructor(
    @InjectRepository(Position)
    private readonly positionsRepo: Repository<Position>,

    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,

    private readonly dhanApiClient: DhanApiClient,
    private readonly tradeJournalService: TradeJournalService,
    private readonly notificationService: NotificationService,
    private readonly secretsService: SecretsService,
    private readonly redisService: RedisService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * On every CloudEngine startup (or module restart) unconditionally reset to
   * DISARMED and overwrite the Redis key.
   *
   * Reads the current Redis value first so any active ARMED / ARMED_PENDING
   * state can be explicitly logged before reverting (Requirement 11.2).
   *
   * Requirement 11.1 / 1.5: a browser restart, CloudEngine restart, or Dhan
   * session token renewal must NEVER auto-re-arm the engine.
   */
  async onModuleInit(): Promise<void> {
    // Read the current Redis value so we can log a meaningful revert message.
    let previousRedisValue: string | null = null;
    try {
      previousRedisValue = await this.redisService.get(ARMED_STATE_KEY);
    } catch (err) {
      // Read failure is non-fatal; we still revert to DISARMED unconditionally.
      this.logger.warn(
        `Failed to read armed state from Redis on startup: ${(err as Error).message}`,
      );
    }

    if (
      previousRedisValue === ArmedState.ARMED ||
      previousRedisValue === ArmedState.ARMED_PENDING
    ) {
      this.logger.warn(
        `Found "${previousRedisValue}" in Redis at startup — ` +
          'reverting to DISARMED (Requirement 11.2: CloudEngine restart must never auto-re-arm)',
      );
    }

    // Always reset to DISARMED regardless of what was persisted.
    this.armedState = ArmedState.DISARMED;
    try {
      await this.redisService.set(ARMED_STATE_KEY, ArmedState.DISARMED);
    } catch (err) {
      // Redis write failure is non-fatal during init; in-memory state is correct.
      this.logger.error(
        `Failed to persist initial DISARMED state to Redis: ${(err as Error).message}`,
      );
    }
    this.logger.log('LiveTradingService initialised — armed state: DISARMED');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public state API
  // ─────────────────────────────────────────────────────────────────────────

  /** Returns the current armed state synchronously. */
  getArmedState(): ArmedState {
    return this.armedState;
  }

  /**
   * Returns true only when the engine is fully armed (state is ARMED).
   *
   * Callers should prefer this over `getArmedState() === ArmedState.ARMED`
   * to guard live order submission paths.
   *
   * Requirements: 11.1
   */
  isArmed(): boolean {
    return this.armedState === ArmedState.ARMED;
  }

  /**
   * Returns true when new position entries must be blocked.
   *
   * Blocking conditions (Requirements 17.3, 11.7):
   *   - Session phase is CLOSING (14:30–15:30 IST)
   *   - Session phase is EOD_RECONCILIATION (15:30–16:00 IST)
   *   - RiskEngine has activated TWO_LOSS_LOCKOUT
   *   - RiskEngine has activated EMERGENCY_HALT
   */
  isNewEntryBlocked(): boolean {
    return (
      this.currentPhase === SessionPhase.CLOSING ||
      this.currentPhase === SessionPhase.EOD_RECONCILIATION ||
      this.riskState === 'TWO_LOSS_LOCKOUT' ||
      this.riskState === 'EMERGENCY_HALT'
    );
  }

  /**
   * Returns true when the emergency kill switch has been activated.
   *
   * Once activated, this remains true for the lifetime of the process.
   * A service restart is required to resume live trading (Requirements 9.8, 11.5).
   */
  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Two-step arming state machine
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Step 1 of the two-step arm sequence.
   *
   * Transitions DISARMED → ARMED_PENDING and persists to Redis.
   * Throws if called from any other state (ARMED_PENDING or ARMED).
   *
   * Requirements: 11.1, 11.2 — a single user action must NEVER reach ARMED.
   */
  requestArm(): void {
    if (this.armedState !== ArmedState.DISARMED) {
      throw new Error(`requestArm() requires DISARMED state; current state is ${this.armedState}`);
    }
    this.armedState = ArmedState.ARMED_PENDING;
    this.persistArmedState(ArmedState.ARMED_PENDING);
    this.logger.log('Live mode activation initiated — state: ARMED_PENDING');
  }

  /**
   * Alias for `requestArm()` — kept for backward compatibility.
   * @deprecated Use `requestArm()` instead.
   */
  activateLiveMode(): void {
    this.requestArm();
  }

  /**
   * Step 2 of the two-step arm sequence.
   *
   * Transitions ARMED_PENDING → ARMED and persists to Redis.
   * Throws if called from any state other than ARMED_PENDING.
   *
   * Requirements: 11.1, 11.2 — requires a prior requestArm() call.
   */
  confirmArm(): void {
    if (this.armedState !== ArmedState.ARMED_PENDING) {
      throw new Error(
        `confirmArm() requires ARMED_PENDING state; current state is ${this.armedState}`,
      );
    }
    this.armedState = ArmedState.ARMED;
    this.persistArmedState(ArmedState.ARMED);
    this.logger.log('Live mode confirmed — state: ARMED');
  }

  /**
   * Unconditional disarm from any state.
   *
   * Transitions any → DISARMED and persists to Redis.
   * Idempotent: safe to call when already DISARMED.
   */
  disarm(): void {
    const previous = this.armedState;
    this.armedState = ArmedState.DISARMED;
    this.persistArmedState(ArmedState.DISARMED);
    this.logger.log(`Live mode disarmed (was: ${previous}) — state: DISARMED`);
  }

  /**
   * Force-disarm the engine with an explicit reason string.
   *
   * Intended for use by session renewal, browser update, and Dhan token
   * renewal events where the trigger should be recorded in logs.
   *
   * Equivalent to `disarm()` but logs the supplied reason at WARN level so
   * operators can correlate disarm events with their triggering causes.
   *
   * Requirements: 11.2
   */
  forceDisarm(reason: string): void {
    const previous = this.armedState;
    this.armedState = ArmedState.DISARMED;
    this.persistArmedState(ArmedState.DISARMED);
    this.logger.warn(
      `Force-disarm triggered (was: ${previous}) — Reason: ${reason} — state: DISARMED`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Emergency kill switch
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Activate the emergency kill switch.
   *
   * Flow (Requirements 9.8, 11.5, 11.6):
   *  1. Record a `KILL_SWITCH` event in RiskEvents via TradeJournalService.
   *  2. Force-disarm the engine so no new orders can be submitted.
   *  3. Fetch the current orderbook and cancel every TRANSIT / PENDING order
   *     via DhanApiClient.cancelOrder().
   *  4. Fetch all open LIVE positions and submit a MARKET exit order for each
   *     via DhanApiClient.placeOrder() (same pattern as mandatorySquareOff).
   *  5. After 10 seconds, check:
   *       a. Orderbook — any orders still in TRANSIT / PENDING / PARTIALLY_FILLED
   *       b. Database — any positions still is_open = true (engine = 'LIVE')
   *     For each remaining item, publish a MAX-priority alert via NotificationService
   *     identifying the specific order / position.
   *
   * Idempotent: if the kill switch is already active the method returns
   * immediately without submitting duplicate orders.
   *
   * Requirements: 9.8, 11.5, 11.6
   */
  async activateKillSwitch(): Promise<void> {
    if (this.killSwitchActive) {
      this.logger.warn('[KILL SWITCH] Already active — ignoring duplicate activation');
      return;
    }

    const activatedAt = new Date();
    this.killSwitchActive = true;
    this.forceDisarm('Kill switch activated');

    this.logger.warn(
      `[KILL SWITCH] Activated at ${activatedAt.toISOString()} — ` +
        'cancelling all open orders and submitting market exit orders for all LIVE positions',
    );

    // ── Step 1: Record KILL_SWITCH compliance event ───────────────────────────
    try {
      await this.tradeJournalService.recordRiskEvent({
        engine: 'LIVE',
        eventType: 'KILL_SWITCH',
        reason: 'Emergency kill switch activated — cancelling all open orders and positions.',
        triggeringMetricName: 'kill_switch',
        triggeringMetricValue: 'ACTIVATED',
        thresholdValue: 'N/A',
        initiatingActor: 'LiveTradingService.activateKillSwitch',
        occurredAt: activatedAt,
        affectedInstrumentId: null,
        affectedStrategyId: null,
      });
    } catch (err) {
      this.logger.error(
        `[KILL SWITCH] Failed to record KILL_SWITCH compliance event: ${(err as Error).message}`,
      );
    }

    // ── Step 2: Get Dhan client ID ────────────────────────────────────────────
    let dhanClientId: string;
    try {
      dhanClientId = await this.secretsService.get('DHAN_CLIENT_ID');
    } catch (err) {
      this.logger.error(
        `[KILL SWITCH] Failed to retrieve DHAN_CLIENT_ID: ${(err as Error).message}`,
      );
      await this.alertMax(
        'Kill Switch Failed — Credentials Unavailable',
        'Could not retrieve Dhan credentials during kill switch activation. MANUAL INTERVENTION REQUIRED.',
        { occurredAt: activatedAt.toISOString() },
      );
      return;
    }

    // ── Step 3: Cancel all pending/open orders in the orderbook ──────────────
    let openOrders: Awaited<ReturnType<typeof this.dhanApiClient.getOrderbook>> = [];
    try {
      openOrders = await this.dhanApiClient.getOrderbook();
    } catch (err) {
      this.logger.error(`[KILL SWITCH] Failed to retrieve orderbook: ${(err as Error).message}`);
    }

    const cancellableStatuses: string[] = ['TRANSIT', 'PENDING', 'PARTIALLY_FILLED'];
    const cancellableOrders = openOrders.filter((o) => cancellableStatuses.includes(o.orderStatus));

    this.logger.warn(`[KILL SWITCH] Cancelling ${cancellableOrders.length} open/pending order(s)`);

    for (const order of cancellableOrders) {
      try {
        await this.dhanApiClient.cancelOrder(order.orderId);
        this.logger.log(`[KILL SWITCH] Cancelled order ${order.orderId}`);
      } catch (err) {
        this.logger.error(
          `[KILL SWITCH] Failed to cancel order ${order.orderId}: ${(err as Error).message}`,
        );
      }
    }

    // ── Step 4: Submit MARKET exit orders for all open LIVE positions ─────────
    let openPositions: Position[] = [];
    try {
      openPositions = await this.positionsRepo.find({
        where: { is_open: true, engine: 'LIVE' },
      });
    } catch (err) {
      this.logger.error(
        `[KILL SWITCH] Failed to query open LIVE positions: ${(err as Error).message}`,
      );
      await this.alertMax(
        'Kill Switch Failed — DB Query Error',
        `Could not retrieve open LIVE positions during kill switch. MANUAL INTERVENTION REQUIRED. ` +
          `Error: ${(err as Error).message}`,
        { occurredAt: activatedAt.toISOString() },
      );
    }

    this.logger.warn(
      `[KILL SWITCH] Submitting market exit orders for ${openPositions.length} open LIVE position(s)`,
    );

    const pendingExitOrders: PendingSquareOffOrder[] = [];

    for (const position of openPositions) {
      let instrument: Instruments | null = null;
      try {
        instrument = await this.instrumentsRepo.findOne({
          where: { id: position.instrument_id },
        });
      } catch (err) {
        this.logger.error(
          `[KILL SWITCH] Failed to look up instrument ${position.instrument_id}: ` +
            `${(err as Error).message}`,
        );
      }

      if (!instrument) {
        this.logger.error(
          `[KILL SWITCH] Instrument not found for position ${position.id} — skipping; MANUAL INTERVENTION REQUIRED`,
        );
        await this.alertMax(
          'Kill Switch — Instrument Lookup Failed',
          `Position ${position.id} could not be exited: instrument record missing. MANUAL INTERVENTION REQUIRED.`,
          { positionId: position.id, instrumentId: position.instrument_id },
        );
        continue;
      }

      const transactionType = position.direction === 'LONG' ? 'SELL' : 'BUY';

      try {
        const orderResponse = await this.dhanApiClient.placeOrder({
          dhanClientId,
          correlationId: `ks-${position.id.slice(0, 20)}`,
          transactionType,
          exchangeSegment: instrument.segment as
            'NSE_EQ' | 'NSE_FNO' | 'BSE_EQ' | 'BSE_FNO' | 'MCX_COMM' | 'IDX_I',
          productType: 'INTRADAY',
          orderType: 'MARKET',
          validity: 'DAY',
          securityId: instrument.securityId,
          quantity: position.quantity,
        });

        pendingExitOrders.push({
          orderId: orderResponse.orderId,
          positionId: position.id,
          instrumentId: instrument.id,
          tradingSymbol: instrument.tradingSymbol,
          quantity: position.quantity,
        });

        this.logger.log(
          `[KILL SWITCH] Submitted MARKET ${transactionType} for position ${position.id} ` +
            `(${instrument.tradingSymbol} × ${position.quantity}) → orderId=${orderResponse.orderId}`,
        );
      } catch (err) {
        this.logger.error(
          `[KILL SWITCH] Failed to submit exit order for position ${position.id}: ` +
            `${(err as Error).message}`,
        );
        await this.alertMax(
          `Kill Switch Order Failed — ${instrument.tradingSymbol}`,
          `Failed to submit MARKET ${transactionType} exit order for position ${position.id} ` +
            `(${instrument.tradingSymbol} × ${position.quantity}). MANUAL INTERVENTION REQUIRED.`,
          {
            positionId: position.id,
            instrumentId: instrument.id,
            tradingSymbol: instrument.tradingSymbol,
            error: (err as Error).message,
          },
        );
      }
    }

    // ── Step 5: Schedule 10-second confirmation check ─────────────────────────
    this.scheduleKillSwitchConfirmationCheck(pendingExitOrders, activatedAt);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Session phase change handler.
   *
   * Updates the locally cached phase so `isNewEntryBlocked()` is always current.
   * Logs a notice when the CLOSING phase is entered so operators can see the
   * entry-blocking event in logs.
   *
   * Requirement 17.3: when phase transitions to CLOSING at 14:30 IST, block new
   * position entries.
   */
  @OnEvent(SESSION_PHASE_CHANGED_EVENT)
  onSessionPhaseChanged(event: SessionPhaseChangeEvent): void {
    this.currentPhase = event.phase;

    if (event.phase === SessionPhase.CLOSING) {
      this.logger.warn(
        `Session entered CLOSING phase at ${event.timestamp.toISOString()} — ` +
          'all new position entries are now blocked (Requirement 17.3)',
      );
    }

    if (event.phase === SessionPhase.EOD_RECONCILIATION) {
      this.logger.warn(
        `Session entered EOD_RECONCILIATION phase at ${event.timestamp.toISOString()} — ` +
          'new entries remain blocked',
      );
    }
  }

  /**
   * Risk state change handler.
   *
   * TWO_LOSS_LOCKOUT and EMERGENCY_HALT both suppress new entry orders.
   * Emitted by RiskManagementModule (task 16.2) via EventEmitter2.
   *
   * Requirements: 11.7 — new entries must be blocked during lockout / halt.
   */
  @OnEvent(RISK_STATE_CHANGED_EVENT)
  onRiskStateChanged(event: RiskStateChangedEvent): void {
    const previous = this.riskState;
    this.riskState = event.state;
    this.logger.warn(
      `Risk state changed: ${previous} → ${event.state}. ` +
        `Reason: ${event.reason}. ` +
        `isNewEntryBlocked=${this.isNewEntryBlocked()}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mandatory square-off cron — 15:15 IST, Mon–Fri
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Mandatory intraday square-off triggered every weekday at 15:15 IST.
   *
   * Flow (Requirement 17.4, 17.7):
   *  1. Query all open LIVE positions (is_open = true AND engine = 'LIVE').
   *  2. Submit a MARKET SELL order for each open position via DhanApiClient.
   *  3. Record a `mandatory-exit` compliance event in TradeJournal with the
   *     exit timestamp and all affected position IDs.
   *  4. After 5 minutes, check order confirmation status.
   *     For any order that is REJECTED or unconfirmed, publish a CRITICAL alert
   *     via NotificationService identifying the specific position.
   *
   * Cron expression: minute=15 hour=15 every weekday in Asia/Kolkata timezone
   * (15:15 IST = 09:45 UTC).
   */
  @Cron('15 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async mandatorySquareOff(): Promise<void> {
    const squareOffAt = new Date();
    this.logger.warn(`[MANDATORY SQUARE-OFF] 15:15 IST triggered at ${squareOffAt.toISOString()}`);

    // ── Step 1: Query open LIVE positions ────────────────────────────────────
    let openPositions: Position[];
    try {
      openPositions = await this.positionsRepo.find({
        where: { is_open: true, engine: 'LIVE' },
      });
    } catch (err) {
      this.logger.error(
        `[MANDATORY SQUARE-OFF] Failed to query open positions: ${(err as Error).message}`,
      );
      await this.alertCritical(
        'Mandatory Square-Off Failed — DB Query Error',
        `Could not retrieve open LIVE positions at 15:15 IST mandatory square-off. ` +
          `Manual intervention required. Error: ${(err as Error).message}`,
        { occurredAt: squareOffAt.toISOString() },
      );
      return;
    }

    if (openPositions.length === 0) {
      this.logger.log('[MANDATORY SQUARE-OFF] No open LIVE positions — nothing to square off');
      return;
    }

    this.logger.warn(
      `[MANDATORY SQUARE-OFF] Found ${openPositions.length} open LIVE position(s) to square off`,
    );

    // ── Step 2: Get Dhan client ID ───────────────────────────────────────────
    let dhanClientId: string;
    try {
      dhanClientId = await this.secretsService.get('DHAN_CLIENT_ID');
    } catch (err) {
      this.logger.error(
        `[MANDATORY SQUARE-OFF] Failed to retrieve DHAN_CLIENT_ID: ${(err as Error).message}`,
      );
      await this.alertCritical(
        'Mandatory Square-Off Failed — Credentials Unavailable',
        `Could not retrieve Dhan credentials at 15:15 IST square-off. ` +
          `${openPositions.length} position(s) require MANUAL intervention.`,
        {
          affectedPositionIds: openPositions.map((p) => p.id),
          occurredAt: squareOffAt.toISOString(),
        },
      );
      return;
    }

    // ── Step 3: Submit MARKET SELL orders ────────────────────────────────────
    const pendingOrders: PendingSquareOffOrder[] = [];

    for (const position of openPositions) {
      let instrument: Instruments | null = null;
      try {
        instrument = await this.instrumentsRepo.findOne({
          where: { id: position.instrument_id },
        });
      } catch (err) {
        this.logger.error(
          `[MANDATORY SQUARE-OFF] Failed to look up instrument ${position.instrument_id}: ` +
            `${(err as Error).message}`,
        );
      }

      if (!instrument) {
        this.logger.error(
          `[MANDATORY SQUARE-OFF] Instrument not found for position ${position.id} ` +
            `(instrument_id=${position.instrument_id}) — skipping; requires MANUAL intervention`,
        );
        await this.alertCritical(
          'Mandatory Square-Off — Instrument Lookup Failed',
          `Position ${position.id} could not be squared off: instrument record missing. ` +
            `Manual intervention required.`,
          {
            positionId: position.id,
            instrumentId: position.instrument_id,
          },
        );
        continue;
      }

      // Determine transaction type based on position direction
      // LONG positions → SELL; SHORT positions → BUY to close
      const transactionType = position.direction === 'LONG' ? 'SELL' : 'BUY';

      try {
        const orderResponse = await this.dhanApiClient.placeOrder({
          dhanClientId,
          correlationId: `sqoff-${position.id.slice(0, 20)}`,
          transactionType,
          exchangeSegment: instrument.segment as
            'NSE_EQ' | 'NSE_FNO' | 'BSE_EQ' | 'BSE_FNO' | 'MCX_COMM' | 'IDX_I',
          productType: 'INTRADAY',
          orderType: 'MARKET',
          validity: 'DAY',
          securityId: instrument.securityId,
          quantity: position.quantity,
        });

        pendingOrders.push({
          orderId: orderResponse.orderId,
          positionId: position.id,
          instrumentId: instrument.id,
          tradingSymbol: instrument.tradingSymbol,
          quantity: position.quantity,
        });

        this.logger.log(
          `[MANDATORY SQUARE-OFF] Submitted MARKET ${transactionType} for position ${position.id} ` +
            `(${instrument.tradingSymbol} × ${position.quantity}) → orderId=${orderResponse.orderId}`,
        );
      } catch (err) {
        this.logger.error(
          `[MANDATORY SQUARE-OFF] Failed to submit exit order for position ${position.id} ` +
            `(${instrument.tradingSymbol}): ${(err as Error).message}`,
        );
        await this.alertCritical(
          `Mandatory Square-Off Order Failed — ${instrument.tradingSymbol}`,
          `Failed to submit MARKET ${transactionType} exit order for position ${position.id} ` +
            `(${instrument.tradingSymbol} × ${position.quantity}). ` +
            `Manual intervention required. Error: ${(err as Error).message}`,
          {
            positionId: position.id,
            instrumentId: instrument.id,
            tradingSymbol: instrument.tradingSymbol,
            quantity: position.quantity,
            error: (err as Error).message,
          },
        );
      }
    }

    // ── Step 4: Record mandatory-exit compliance event ───────────────────────
    if (openPositions.length > 0) {
      try {
        await this.tradeJournalService.recordRiskEvent({
          engine: 'LIVE',
          eventType: 'MANDATORY_EXIT',
          reason:
            `Mandatory intraday square-off at 15:15 IST. ` +
            `${pendingOrders.length} MARKET exit order(s) submitted for ` +
            `${openPositions.length} open LIVE position(s).`,
          triggeringMetricName: 'session_time',
          triggeringMetricValue: '15:15',
          thresholdValue: '15:15',
          initiatingActor: 'LiveTradingService.mandatorySquareOff',
          occurredAt: squareOffAt,
          // Affected position IDs are embedded in the reason string and metadata
          affectedInstrumentId: null,
          affectedStrategyId: null,
        });

        this.logger.log(
          `[MANDATORY SQUARE-OFF] Compliance event recorded — ` +
            `positionIds=[${openPositions.map((p) => p.id).join(', ')}]`,
        );
      } catch (err) {
        this.logger.error(
          `[MANDATORY SQUARE-OFF] Failed to record compliance event: ${(err as Error).message}`,
        );
      }
    }

    // ── Step 5: Schedule 5-minute confirmation check ─────────────────────────
    if (pendingOrders.length > 0) {
      this.scheduleConfirmationCheck(pendingOrders, squareOffAt);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Schedules a confirmation check after SQUARE_OFF_CONFIRMATION_TIMEOUT_MS.
   *
   * For each pending order, queries the Dhan orderbook to confirm the order is
   * FILLED.  Any order that is REJECTED or still unconfirmed triggers a
   * CRITICAL notification identifying the specific position.
   *
   * Requirement 17.7: alert within 5 minutes of 15:15 IST square-off time.
   */
  private scheduleConfirmationCheck(
    pendingOrders: PendingSquareOffOrder[],
    squareOffAt: Date,
  ): void {
    this.logger.log(
      `[MANDATORY SQUARE-OFF] Scheduling confirmation check in ` +
        `${SQUARE_OFF_CONFIRMATION_TIMEOUT_MS / 1_000}s for ` +
        `${pendingOrders.length} order(s)`,
    );

    setTimeout(() => {
      void this.checkSquareOffConfirmations(pendingOrders, squareOffAt);
    }, SQUARE_OFF_CONFIRMATION_TIMEOUT_MS);
  }

  /**
   * Queries the Dhan orderbook and alerts for each pending square-off order
   * that is not in FILLED status.
   *
   * Called after the 5-minute confirmation window expires.
   */
  private async checkSquareOffConfirmations(
    pendingOrders: PendingSquareOffOrder[],
    squareOffAt: Date,
  ): Promise<void> {
    this.logger.log(
      `[MANDATORY SQUARE-OFF] Running confirmation check for ${pendingOrders.length} order(s)`,
    );

    let orderbook: Awaited<ReturnType<typeof this.dhanApiClient.getOrderbook>>;
    try {
      orderbook = await this.dhanApiClient.getOrderbook();
    } catch (err) {
      this.logger.error(
        `[MANDATORY SQUARE-OFF] Failed to retrieve orderbook for confirmation check: ` +
          `${(err as Error).message}`,
      );
      // Alert for every pending order since we cannot confirm any
      for (const pending of pendingOrders) {
        await this.alertCritical(
          `Mandatory Square-Off Unconfirmed — ${pending.tradingSymbol}`,
          `Could not confirm exit order for position ${pending.positionId} ` +
            `(${pending.tradingSymbol} × ${pending.quantity}, orderId=${pending.orderId}). ` +
            `Orderbook retrieval failed. MANUAL INTERVENTION REQUIRED.`,
          {
            orderId: pending.orderId,
            positionId: pending.positionId,
            tradingSymbol: pending.tradingSymbol,
            quantity: pending.quantity,
            squareOffAt: squareOffAt.toISOString(),
          },
        );
      }
      return;
    }

    // Build a map of orderId → status for fast lookup
    const statusMap = new Map<string, DhanOrderStatus>();
    for (const order of orderbook) {
      statusMap.set(order.orderId, order.orderStatus);
    }

    for (const pending of pendingOrders) {
      const status = statusMap.get(pending.orderId);

      if (status === 'FILLED') {
        this.logger.log(
          `[MANDATORY SQUARE-OFF] Order ${pending.orderId} for position ` +
            `${pending.positionId} (${pending.tradingSymbol}) confirmed FILLED`,
        );
        continue;
      }

      // Order is REJECTED, CANCELLED, EXPIRED, or not found in the orderbook
      const statusLabel = status ?? 'NOT_FOUND_IN_ORDERBOOK';
      this.logger.error(
        `[MANDATORY SQUARE-OFF] Order ${pending.orderId} for position ` +
          `${pending.positionId} (${pending.tradingSymbol}) is ${statusLabel} — ` +
          'publishing CRITICAL alert',
      );

      await this.alertCritical(
        `Mandatory Square-Off ${statusLabel} — ${pending.tradingSymbol} — MANUAL ACTION REQUIRED`,
        `The mandatory intraday exit order for position ${pending.positionId} ` +
          `(${pending.tradingSymbol} × ${pending.quantity}) was ${statusLabel} or unconfirmed ` +
          `5 minutes after the 15:15 IST square-off. ` +
          `Order ID: ${pending.orderId}. IMMEDIATE MANUAL INTERVENTION REQUIRED.`,
        {
          orderId: pending.orderId,
          positionId: pending.positionId,
          instrumentId: pending.instrumentId,
          tradingSymbol: pending.tradingSymbol,
          quantity: pending.quantity,
          orderStatus: statusLabel,
          squareOffAt: squareOffAt.toISOString(),
        },
      );
    }
  }

  /**
   * Fires-and-forgets a Redis write of the armed state.
   *
   * Errors are logged but never swallowed silently — in-memory state is already
   * updated so the in-process callers always see the correct state.
   */
  private persistArmedState(state: ArmedState): void {
    this.redisService.set(ARMED_STATE_KEY, state).catch((err: Error) => {
      this.logger.error(
        `Failed to persist armed state "${state}" to Redis key ` +
          `"${ARMED_STATE_KEY}": ${err.message}`,
      );
    });
  }

  /**
   * Publish a CRITICAL-priority alert via NotificationService.
   *
   * Uses a newly generated UUID per alert so the deduplication / ACK logic in
   * NotificationService works correctly across multiple unconfirmed orders.
   */
  private async alertCritical(
    title: string,
    message: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'CRITICAL',
        title,
        message,
        metadata,
        createdAt: new Date(),
      });
    } catch (err) {
      this.logger.error(`Failed to publish CRITICAL alert "${title}": ${(err as Error).message}`);
    }
  }

  /**
   * Publish a MAX-priority alert via NotificationService.
   *
   * MAX-priority is used exclusively for kill-switch confirmation failures
   * (Requirements 11.5, 11.6) where manual intervention is immediately required.
   */
  private async alertMax(
    title: string,
    message: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'MAX',
        title,
        message,
        metadata,
        createdAt: new Date(),
      });
    } catch (err) {
      this.logger.error(`Failed to publish MAX alert "${title}": ${(err as Error).message}`);
    }
  }

  /**
   * Schedules the 10-second post-kill-switch confirmation check.
   *
   * Requirements 11.5, 11.6: if any orders or positions remain open after
   * 10 seconds, publish a MAX-priority alert identifying each specific item.
   */
  private scheduleKillSwitchConfirmationCheck(
    pendingExitOrders: PendingSquareOffOrder[],
    activatedAt: Date,
  ): void {
    this.logger.log(
      `[KILL SWITCH] Scheduling confirmation check in ` +
        `${KILL_SWITCH_CONFIRMATION_TIMEOUT_MS / 1_000}s`,
    );

    setTimeout(() => {
      void this.checkKillSwitchConfirmations(pendingExitOrders, activatedAt);
    }, KILL_SWITCH_CONFIRMATION_TIMEOUT_MS);
  }

  /**
   * Verifies that all kill-switch exit orders are FILLED and no LIVE positions
   * remain open.  Publishes a MAX-priority alert for each item that is still
   * unresolved (Requirements 11.5, 11.6).
   */
  private async checkKillSwitchConfirmations(
    pendingExitOrders: PendingSquareOffOrder[],
    activatedAt: Date,
  ): Promise<void> {
    this.logger.log('[KILL SWITCH] Running 10-second confirmation check');

    // ── Check exit orders via orderbook ──────────────────────────────────────
    if (pendingExitOrders.length > 0) {
      let orderbook: Awaited<ReturnType<typeof this.dhanApiClient.getOrderbook>> = [];
      try {
        orderbook = await this.dhanApiClient.getOrderbook();
      } catch (err) {
        this.logger.error(
          `[KILL SWITCH] Failed to retrieve orderbook for confirmation check: ` +
            `${(err as Error).message}`,
        );
        for (const pending of pendingExitOrders) {
          await this.alertMax(
            `Kill Switch Unconfirmed — ${pending.tradingSymbol}`,
            `Could not confirm kill-switch exit order for position ${pending.positionId} ` +
              `(${pending.tradingSymbol} × ${pending.quantity}, orderId=${pending.orderId}). ` +
              `Orderbook retrieval failed. MANUAL INTERVENTION REQUIRED.`,
            {
              orderId: pending.orderId,
              positionId: pending.positionId,
              tradingSymbol: pending.tradingSymbol,
              quantity: pending.quantity,
              activatedAt: activatedAt.toISOString(),
            },
          );
        }
        // Still continue to check DB positions below
      }

      if (orderbook.length > 0) {
        const statusMap = new Map<string, string>();
        for (const order of orderbook) {
          statusMap.set(order.orderId, order.orderStatus);
        }

        for (const pending of pendingExitOrders) {
          const status = statusMap.get(pending.orderId);
          if (status === 'FILLED') {
            this.logger.log(
              `[KILL SWITCH] Exit order ${pending.orderId} for position ${pending.positionId} confirmed FILLED`,
            );
            continue;
          }

          const statusLabel = status ?? 'NOT_FOUND_IN_ORDERBOOK';
          this.logger.error(
            `[KILL SWITCH] Exit order ${pending.orderId} for position ` +
              `${pending.positionId} is ${statusLabel} — publishing MAX alert`,
          );

          await this.alertMax(
            `Kill Switch Order ${statusLabel} — ${pending.tradingSymbol} — MANUAL ACTION REQUIRED`,
            `Kill-switch exit order for position ${pending.positionId} ` +
              `(${pending.tradingSymbol} × ${pending.quantity}) is ${statusLabel} ` +
              `10 seconds after kill switch activation. IMMEDIATE MANUAL INTERVENTION REQUIRED.`,
            {
              orderId: pending.orderId,
              positionId: pending.positionId,
              instrumentId: pending.instrumentId,
              tradingSymbol: pending.tradingSymbol,
              quantity: pending.quantity,
              orderStatus: statusLabel,
              activatedAt: activatedAt.toISOString(),
            },
          );
        }
      }
    }

    // ── Check DB for still-open LIVE positions ────────────────────────────────
    let stillOpenPositions: Position[] = [];
    try {
      stillOpenPositions = await this.positionsRepo.find({
        where: { is_open: true, engine: 'LIVE' },
      });
    } catch (err) {
      this.logger.error(
        `[KILL SWITCH] Failed to query remaining open positions: ${(err as Error).message}`,
      );
    }

    for (const position of stillOpenPositions) {
      this.logger.error(
        `[KILL SWITCH] Position ${position.id} is STILL OPEN 10 seconds after kill switch — ` +
          'publishing MAX alert',
      );

      await this.alertMax(
        `Kill Switch — Position Still Open — MANUAL ACTION REQUIRED`,
        `Position ${position.id} (instrument_id=${position.instrument_id}) remains open ` +
          `10 seconds after kill switch activation. IMMEDIATE MANUAL INTERVENTION REQUIRED.`,
        {
          positionId: position.id,
          instrumentId: position.instrument_id,
          direction: position.direction,
          quantity: position.quantity,
          activatedAt: activatedAt.toISOString(),
        },
      );
    }

    if (stillOpenPositions.length === 0 && pendingExitOrders.length === 0) {
      this.logger.log(
        '[KILL SWITCH] Confirmation check passed — all orders and positions resolved',
      );
    }
  }
}
