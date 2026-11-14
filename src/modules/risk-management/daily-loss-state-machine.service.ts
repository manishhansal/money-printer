/**
 * DailyLossStateMachineService — per-engine daily loss state machine.
 *
 * Enforces the three progressive risk lockout states for each trading engine:
 *
 *   NORMAL
 *     → TWO_LOSS_LOCKOUT  (when the 2nd losing trade of the calendar day is closed)
 *     → EMERGENCY_HALT    (when intraday net loss ≥ DAILY_LOSS_LIMIT_RUPEES)
 *   Any State
 *     → KILL_SWITCH_ACTIVE (on explicit kill-switch activation)
 *
 * Both TWO_LOSS_LOCKOUT and EMERGENCY_HALT are automatically reset to NORMAL
 * at 00:00 IST each calendar day.  KILL_SWITCH_ACTIVE requires manual
 * intervention and is never automatically cleared.
 *
 * Every state transition:
 *   1. Updates the in-memory state map.
 *   2. Persists an immutable RiskEvents row.
 *   3. Publishes a NotificationAlert at the appropriate priority level:
 *       TWO_LOSS_LOCKOUT  → WARNING
 *       EMERGENCY_HALT    → CRITICAL
 *       KILL_SWITCH_ACTIVE → MAX
 *
 * Configuration (env-overridable via ConfigService):
 *   DAILY_LOSS_LIMIT_RUPEES  — default 10 000 INR
 *
 * Requirements: 9.3, 9.4, 9.8
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';

import { RiskEvents, RiskEventType } from '../../database/entities/risk-events.entity';
import { EngineType } from '../../database/entities/capital-ledgers.entity';
import { NotificationService } from '../notification/notification.service';
import { AlertPriority, NotificationAlert } from '../notification/notification.types';
import {
  RISK_STATE_CHANGED_EVENT,
  RiskState,
  RiskStateChangedEvent,
} from './risk-management.types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DailyLossState =
  'NORMAL' | 'TWO_LOSS_LOCKOUT' | 'EMERGENCY_HALT' | 'KILL_SWITCH_ACTIVE';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default daily monetary loss limit in INR (₹10,000). */
const DEFAULT_DAILY_LOSS_LIMIT_RUPEES = 10_000;

/** Number of consecutive losing trades that triggers a day lockout. */
const LOSING_TRADE_LOCKOUT_THRESHOLD = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class DailyLossStateMachineService {
  private readonly logger = new Logger(DailyLossStateMachineService.name);

  /**
   * In-memory state per engine.
   * Both engines start in NORMAL state on each process boot.
   */
  private readonly state = new Map<EngineType, DailyLossState>([
    ['LIVE', 'NORMAL'],
    ['PAPER', 'NORMAL'],
  ]);

  /**
   * Count of losing trades (net_pnl < 0) recorded today per engine.
   * Reset to zero at 00:00 IST together with the daily state reset.
   */
  private readonly losingTradeCount = new Map<EngineType, number>([
    ['LIVE', 0],
    ['PAPER', 0],
  ]);

  /**
   * Most recently reported total intraday loss per engine (in rupees).
   * Updated by onIntradayLossUpdate(); reset to 0 at midnight.
   */
  private readonly currentDailyLossRupees = new Map<EngineType, number>([
    ['LIVE', 0],
    ['PAPER', 0],
  ]);

  constructor(
    @InjectRepository(RiskEvents)
    private readonly riskEventsRepo: Repository<RiskEvents>,
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the current daily-loss state for the given engine.
   *
   * @param engine  'LIVE' | 'PAPER'
   */
  getCurrentState(engine: EngineType): DailyLossState {
    return this.state.get(engine) ?? 'NORMAL';
  }

  /**
   * Returns the number of losing trades recorded today for the given engine.
   * Resets to zero at midnight IST with resetDailyState().
   */
  getLosingTradeCount(engine: EngineType): number {
    return this.losingTradeCount.get(engine) ?? 0;
  }

  /**
   * Returns the most recently reported total intraday loss in rupees for the
   * given engine. Updated by onIntradayLossUpdate(); resets to 0 at midnight.
   */
  getCurrentDailyLoss(engine: EngineType): number {
    return this.currentDailyLossRupees.get(engine) ?? 0;
  }

  /**
   * Called whenever a trade is closed (winning or losing).
   *
   * If the net P&L (after all charges) is negative the losing-trade counter is
   * incremented.  When the counter reaches 2 AND the engine is still in NORMAL
   * state, a TWO_LOSS_LOCKOUT transition is recorded.
   *
   * No action is taken if the engine is already in a blocking state
   * (TWO_LOSS_LOCKOUT, EMERGENCY_HALT, or KILL_SWITCH_ACTIVE); in that state
   * new entries have been blocked and the counter cannot meaningfully advance
   * toward another lockout.
   *
   * @param engine  'LIVE' | 'PAPER'
   * @param netPnl  Signed decimal string of net P&L (e.g. '-1250.50').
   *
   * Requirements: 9.3
   */
  async onTradeClosed(engine: EngineType, netPnl: string): Promise<void> {
    // Winning or break-even trade — nothing to do.
    const pnlValue = parseFloat(netPnl);
    if (isNaN(pnlValue) || pnlValue >= 0) {
      return;
    }

    // If the engine is already in a blocking state, the trade counter is not
    // incremented — the lockout is already active.
    const currentState = this.getCurrentState(engine);
    if (currentState !== 'NORMAL') {
      return;
    }

    const prev = this.losingTradeCount.get(engine) ?? 0;
    const updated = prev + 1;
    this.losingTradeCount.set(engine, updated);

    this.logger.debug(`[${engine}] Losing trade closed (net_pnl=${netPnl}); count=${updated}`);

    if (updated >= LOSING_TRADE_LOCKOUT_THRESHOLD) {
      await this.transitionTo(engine, 'TWO_LOSS_LOCKOUT', {
        reason:
          'Second losing trade of the calendar day closed. New entry signal submissions are blocked for the remainder of the trading day.',
        triggeringMetricName: 'losing_trade_count',
        triggeringMetricValue: updated.toFixed(4),
        thresholdValue: LOSING_TRADE_LOCKOUT_THRESHOLD.toFixed(4),
        initiatingActor: 'DailyLossStateMachineService',
      });
    }
  }

  /**
   * Called with the current intraday net loss (realized + unrealized P&L for
   * the session, expressed as a positive number of rupees lost).
   *
   * If the total loss reaches or exceeds DAILY_LOSS_LIMIT_RUPEES, and the
   * engine is not already halted or kill-switched, an EMERGENCY_HALT transition
   * is recorded.
   *
   * @param engine          'LIVE' | 'PAPER'
   * @param totalLossRupees Total intraday net loss in INR (positive = loss).
   *
   * Requirements: 9.4
   */
  async onIntradayLossUpdate(engine: EngineType, totalLossRupees: number): Promise<void> {
    // Track latest reported value for getCurrentDailyLoss().
    this.currentDailyLossRupees.set(engine, totalLossRupees);
    const currentState = this.getCurrentState(engine);

    // EMERGENCY_HALT and KILL_SWITCH_ACTIVE are already terminal (for the day)
    // — no need to re-trigger.
    if (currentState === 'EMERGENCY_HALT' || currentState === 'KILL_SWITCH_ACTIVE') {
      return;
    }

    const dailyLossLimit =
      this.configService.get<number>('DAILY_LOSS_LIMIT_RUPEES') ?? DEFAULT_DAILY_LOSS_LIMIT_RUPEES;

    if (totalLossRupees >= dailyLossLimit) {
      await this.transitionTo(engine, 'EMERGENCY_HALT', {
        reason:
          `Intraday net loss ₹${totalLossRupees.toFixed(2)} has reached or exceeded ` +
          `the configured daily loss limit of ₹${dailyLossLimit.toFixed(2)}.`,
        triggeringMetricName: 'intraday_net_loss_rupees',
        triggeringMetricValue: totalLossRupees.toFixed(4),
        thresholdValue: dailyLossLimit.toFixed(4),
        initiatingActor: 'DailyLossStateMachineService',
      });
    }
  }

  /**
   * Activates the kill switch for the given engine, transitioning to
   * KILL_SWITCH_ACTIVE from any current state.
   *
   * KILL_SWITCH_ACTIVE is never automatically cleared — it requires manual
   * operator intervention to restore.
   *
   * @param engine          'LIVE' | 'PAPER'
   * @param initiatingActor Human-readable identifier of the actor that
   *                        triggered the kill switch (e.g. 'UserKillSwitch').
   *
   * Requirements: 9.8
   */
  async activateKillSwitch(engine: EngineType, initiatingActor: string): Promise<void> {
    await this.transitionTo(engine, 'KILL_SWITCH_ACTIVE', {
      reason: `Kill switch activated by ${initiatingActor}.`,
      triggeringMetricName: null,
      triggeringMetricValue: null,
      thresholdValue: null,
      initiatingActor,
    });
  }

  /**
   * Scheduled daily reset: reverts TWO_LOSS_LOCKOUT and EMERGENCY_HALT to
   * NORMAL at 00:00 IST each calendar day, clearing the losing trade counter.
   *
   * KILL_SWITCH_ACTIVE is intentionally excluded — it requires explicit manual
   * deactivation by an operator.
   *
   * Emits `risk.state.changed` with state='NORMAL' so LiveTradingService
   * re-opens new entry submissions for the new trading day.
   *
   * Fires: 00:00 IST daily  (cron: '0 0 * * *', Asia/Kolkata)
   */
  @Cron('0 0 * * *', { timeZone: 'Asia/Kolkata' })
  async resetDailyState(): Promise<void> {
    for (const engine of ['LIVE', 'PAPER'] as const) {
      const currentState = this.getCurrentState(engine);

      if (currentState === 'TWO_LOSS_LOCKOUT' || currentState === 'EMERGENCY_HALT') {
        this.state.set(engine, 'NORMAL');
        this.logger.log(`[${engine}] Daily state reset: ${currentState} → NORMAL at 00:00 IST`);

        // Notify LiveTradingService that entries are permitted again for the new day.
        const event: RiskStateChangedEvent = {
          engine,
          state: 'NORMAL',
          previousState: currentState as RiskState,
          reason: 'Daily state reset at 00:00 IST — new trading day begins.',
          occurredAt: new Date(),
        };
        this.eventEmitter.emit(RISK_STATE_CHANGED_EVENT, event);
      }

      // Always reset the losing-trade counter and daily loss at midnight so the new day
      // starts fresh (applicable to both NORMAL and formerly-locked states).
      if (currentState !== 'KILL_SWITCH_ACTIVE') {
        this.losingTradeCount.set(engine, 0);
        this.currentDailyLossRupees.set(engine, 0);
      }
    }
  }

  /**
   * Returns true when the engine is in any state that blocks new entries.
   *
   * Blocking states: TWO_LOSS_LOCKOUT, EMERGENCY_HALT, KILL_SWITCH_ACTIVE.
   * Only NORMAL permits new entry signal submissions.
   *
   * @param engine  'LIVE' | 'PAPER'
   */
  isNewEntryBlocked(engine: EngineType): boolean {
    const currentState = this.getCurrentState(engine);
    return (
      currentState === 'TWO_LOSS_LOCKOUT' ||
      currentState === 'EMERGENCY_HALT' ||
      currentState === 'KILL_SWITCH_ACTIVE'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Core transition helper: updates in-memory state, persists a RiskEvents row,
   * publishes a notification alert, and emits a `risk.state.changed` NestJS event
   * so downstream consumers (LiveTradingService) can gate new entry submissions.
   *
   * Failures in persistence or notification delivery are logged at ERROR
   * level but do not revert the in-memory state — the state machine never rolls
   * back a safety-critical transition due to a persistence failure.
   */
  private async transitionTo(
    engine: EngineType,
    newState: DailyLossState,
    opts: {
      reason: string;
      triggeringMetricName: string | null;
      triggeringMetricValue: string | null;
      thresholdValue: string | null;
      initiatingActor: string;
    },
  ): Promise<void> {
    const previousState = this.getCurrentState(engine);

    // 1. Update in-memory state.
    this.state.set(engine, newState);
    this.logger.log(
      `[${engine}] State transition: ${previousState} → ${newState} | ${opts.reason}`,
    );

    // 2. Persist RiskEvents record.
    await this.persistRiskEvent(engine, newState, opts);

    // 3. Publish notification.
    await this.publishNotification(engine, newState, previousState, opts.reason);

    // 4. Emit NestJS event so LiveTradingService.onRiskStateChanged() blocks new entries.
    //    Cast is safe: DailyLossState is a superset of RiskState; NORMAL is emitted
    //    separately via resetDailyState().
    const event: RiskStateChangedEvent = {
      engine,
      state: newState as RiskState,
      previousState: previousState as RiskState,
      reason: opts.reason,
      occurredAt: new Date(),
    };
    this.eventEmitter.emit(RISK_STATE_CHANGED_EVENT, event);
  }

  /** Converts a DailyLossState to the matching RiskEventType column value. */
  private stateToEventType(state: DailyLossState): RiskEventType {
    switch (state) {
      case 'TWO_LOSS_LOCKOUT':
        return 'TWO_LOSS_LOCKOUT';
      case 'EMERGENCY_HALT':
        return 'EMERGENCY_HALT';
      case 'KILL_SWITCH_ACTIVE':
        return 'KILL_SWITCH';
      default:
        return 'TWO_LOSS_LOCKOUT'; // unreachable for normal resets
    }
  }

  /** Maps a blocking DailyLossState to the appropriate notification priority. */
  private stateToAlertPriority(state: DailyLossState): AlertPriority {
    switch (state) {
      case 'KILL_SWITCH_ACTIVE':
        return 'MAX';
      case 'EMERGENCY_HALT':
        return 'CRITICAL';
      case 'TWO_LOSS_LOCKOUT':
        return 'WARNING';
      default:
        return 'INFO';
    }
  }

  /** Builds the alert title shown in the Extension UI. */
  private getAlertTitle(state: DailyLossState, engine: EngineType): string {
    switch (state) {
      case 'TWO_LOSS_LOCKOUT':
        return `[${engine}] Two-Loss Lockout Activated`;
      case 'EMERGENCY_HALT':
        return `[${engine}] Emergency Halt — Daily Loss Limit Reached`;
      case 'KILL_SWITCH_ACTIVE':
        return `[${engine}] Kill Switch Activated`;
      default:
        return `[${engine}] Risk State Changed`;
    }
  }

  /** Persists an immutable RiskEvents row for the transition. */
  private async persistRiskEvent(
    engine: EngineType,
    newState: DailyLossState,
    opts: {
      reason: string;
      triggeringMetricName: string | null;
      triggeringMetricValue: string | null;
      thresholdValue: string | null;
      initiatingActor: string;
    },
  ): Promise<void> {
    try {
      const event = this.riskEventsRepo.create({
        engine,
        event_type: this.stateToEventType(newState),
        reason: opts.reason,
        triggering_metric_name: opts.triggeringMetricName,
        triggering_metric_value: opts.triggeringMetricValue,
        threshold_value: opts.thresholdValue,
        affected_instrument_id: null,
        affected_strategy_id: null,
        initiating_actor: opts.initiatingActor,
        occurred_at: new Date(),
      });
      await this.riskEventsRepo.save(event);
    } catch (err) {
      this.logger.error(
        `[${engine}] Failed to persist RiskEvent for state ${newState}: ` +
          `${(err as Error).message}`,
      );
    }
  }

  /** Builds and publishes a notification alert for the transition. */
  private async publishNotification(
    engine: EngineType,
    newState: DailyLossState,
    previousState: DailyLossState,
    reason: string,
  ): Promise<void> {
    const alert: NotificationAlert = {
      id: uuidv4(),
      priority: this.stateToAlertPriority(newState),
      title: this.getAlertTitle(newState, engine),
      message: reason,
      metadata: { engine, previousState, newState },
      createdAt: new Date(),
    };

    try {
      await this.notificationService.publish(alert);
    } catch (err) {
      this.logger.error(
        `[${engine}] Failed to publish notification for state ${newState}: ` +
          `${(err as Error).message}`,
      );
    }
  }
}
