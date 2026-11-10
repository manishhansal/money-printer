/**
 * journal-wiring.service.ts
 *
 * JournalWiringService — event bridge that routes intra-process domain events
 * to the TradeJournal's append-only write paths.
 *
 * Wired events:
 *
 *   position.exit
 *     Emitted by PositionMonitoringService whenever an exit condition is
 *     triggered (stop-loss hit, target reached, trailing stop, theta decay,
 *     or expiry square-off). Journals the exit signal as a MANDATORY_EXIT
 *     risk event so every position closure is permanently auditable.
 *
 *   risk.daily_loss_state_changed
 *     Emitted by DailyLossStateMachineService when the cumulative daily loss
 *     crosses or recovers from a configured threshold. Journals a
 *     DAILY_LOSS_LIMIT risk event capturing the new state, the observed loss
 *     percentage, and the breach threshold.
 *
 * Requirements: 13.1, 10.1
 */

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { TradeJournalService } from '../trade-journal/trade-journal.service';
import { RiskEventDto } from '../trade-journal/dto/risk-event.dto';

import {
  POSITION_EXIT_EVENT,
  PositionExitSignal,
} from '../position-monitoring/position-monitoring.types';

// ─────────────────────────────────────────────────────────────────────────────
// Event name constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emitted by DailyLossStateMachineService when the daily loss state changes.
 * Payload: DailyLossStateChangedPayload.
 *
 * Requirements: 13.1, 9.4
 */
export const DAILY_LOSS_STATE_CHANGED_EVENT = 'risk.daily_loss_state_changed';

// ─────────────────────────────────────────────────────────────────────────────
// Event payload types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload emitted with DAILY_LOSS_STATE_CHANGED_EVENT.
 *
 * Fields:
 *   engine          — trading engine context ('LIVE' | 'PAPER').
 *   newState        — the state the machine transitioned into
 *                     (e.g. 'TWO_LOSS_LOCKOUT', 'EMERGENCY_HALT').
 *   dailyLossPct    — observed daily loss percentage at the time of transition.
 *   thresholdPct    — the configured threshold percentage that was breached.
 *   occurredAt      — UTC timestamp of the state transition.
 */
export interface DailyLossStateChangedPayload {
  engine: 'LIVE' | 'PAPER';
  newState: string;
  dailyLossPct: number;
  thresholdPct: number;
  occurredAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class JournalWiringService {
  private readonly logger = new Logger(JournalWiringService.name);

  constructor(private readonly tradeJournalService: TradeJournalService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Event handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Journals a position exit as a MANDATORY_EXIT risk event.
   *
   * Called whenever PositionMonitoringService detects that an open position
   * has met its exit condition.  The exit signal data is preserved verbatim
   * so post-session audits can reconstruct exactly what triggered the exit.
   *
   * Requirements: 13.1, 13.5
   */
  @OnEvent(POSITION_EXIT_EVENT)
  async handlePositionExit(payload: PositionExitSignal): Promise<void> {
    const dto = new RiskEventDto();
    dto.engine = 'LIVE';
    dto.eventType = 'MANDATORY_EXIT';
    dto.reason = `Position exit triggered: reason=${payload.reason}, positionId=${payload.positionId}`;
    dto.triggeringMetricName = 'position_exit_condition';
    dto.triggeringMetricValue = String(payload.currentPrice);
    dto.thresholdValue = null;
    dto.affectedInstrumentId = null;
    dto.affectedStrategyId = null;
    dto.initiatingActor = 'PositionMonitoringService';
    dto.occurredAt = payload.timestamp;

    try {
      await this.tradeJournalService.recordRiskEvent(dto);
      this.logger.debug(
        `[JournalWiring] Journaled position.exit for positionId=${payload.positionId}`,
      );
    } catch (err) {
      this.logger.error(
        `[JournalWiring] Failed to journal position.exit event: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Journals a daily loss state transition as a DAILY_LOSS_LIMIT risk event.
   *
   * Captures the observed daily loss percentage, the configured threshold,
   * and the new state the machine entered.  Used to build a complete audit
   * trail of every daily-loss-driven halt or lockout in a session.
   *
   * Requirements: 13.1, 13.5, 9.4
   */
  @OnEvent(DAILY_LOSS_STATE_CHANGED_EVENT)
  async handleDailyLossStateChanged(payload: DailyLossStateChangedPayload): Promise<void> {
    const dto = new RiskEventDto();
    dto.engine = payload.engine;
    dto.eventType = 'DAILY_LOSS_LIMIT';
    dto.reason = `Daily loss state changed to: ${payload.newState}`;
    dto.triggeringMetricName = 'daily_loss_pct';
    dto.triggeringMetricValue = String(payload.dailyLossPct);
    dto.thresholdValue = String(payload.thresholdPct);
    dto.affectedInstrumentId = null;
    dto.affectedStrategyId = null;
    dto.initiatingActor = 'DailyLossStateMachineService';
    dto.occurredAt = payload.occurredAt;

    try {
      await this.tradeJournalService.recordRiskEvent(dto);
      this.logger.debug(
        `[JournalWiring] Journaled risk.daily_loss_state_changed: state=${payload.newState}`,
      );
    } catch (err) {
      this.logger.error(
        `[JournalWiring] Failed to journal risk.daily_loss_state_changed event: ${(err as Error).message}`,
      );
    }
  }
}
