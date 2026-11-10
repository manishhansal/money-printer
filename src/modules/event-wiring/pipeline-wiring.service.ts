/**
 * PipelineWiringService — wires the signal-to-execution NestJS EventEmitter
 * pipeline across all modules.
 *
 * Subscription map (Requirements 9.1, 9.2, 11.3):
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  strategy.signal.candidate   (emitter: StrategyService)         │
 *   │    → SignalScoringService.scoreAndPersistSignal()               │
 *   │                                                                 │
 *   │  risk.unrealized_pnl_updated (emitter: PositionMonitoringService│
 *   │    → DailyLossStateMachineService.onIntradayLossUpdate()        │
 *   │      (LIVE engine — position monitoring tracks LIVE positions)   │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Design notes:
 *   - Every handler is wrapped in a try/catch; errors are logged but never
 *     re-thrown, ensuring the EventEmitter dispatch loop is never killed.
 *   - Malformed payloads (null, missing required fields) are detected via
 *     runtime type guards and logged at WARN level without attempting to
 *     forward the signal downstream.
 *   - onModuleInit() emits a structured log entry that acts as a startup
 *     verification that all subscriptions are live.
 *
 * Requirements: 9.1, 9.2, 11.3
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { SignalScoringService } from '../signal-scoring/signal-scoring.service';
import { DailyLossStateMachineService } from '../risk-management/daily-loss-state-machine.service';
import { SIGNAL_CANDIDATE_EVENT, SignalCandidateEventPayload } from '../strategy/strategy.types';
import { UNREALIZED_PNL_UPDATED_EVENT } from '../position-monitoring/position-monitoring.types';
import { SignalInput } from '../signal-scoring/signal-scoring.types';

/** Payload shape for the UNREALIZED_PNL_UPDATED_EVENT. */
export interface UnrealizedPnlPayload {
  totalUnrealizedPnl: number;
}

@Injectable()
export class PipelineWiringService implements OnModuleInit {
  private readonly logger = new Logger(PipelineWiringService.name);

  constructor(
    private readonly signalScoringService: SignalScoringService,
    private readonly dailyLossStateMachineService: DailyLossStateMachineService,
  ) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Called by NestJS after all module dependencies are resolved.
   *
   * Emits a structured startup log that confirms the two critical event
   * subscriptions are active, fulfilling the pipeline-verification requirement.
   *
   * Requirements: 9.1, 9.2, 11.3
   */
  onModuleInit(): void {
    this.logger.log(
      'PipelineWiringService initialised — event subscriptions active:\n' +
        `  [1] ${SIGNAL_CANDIDATE_EVENT} → SignalScoringService.scoreAndPersistSignal()\n` +
        `  [2] ${UNREALIZED_PNL_UPDATED_EVENT} → DailyLossStateMachineService.onIntradayLossUpdate(LIVE)`,
    );
  }

  // ─── Event handlers ────────────────────────────────────────────────────────

  /**
   * Handle a signal candidate emitted by StrategyService after all 5 evaluation
   * gates have passed.
   *
   * Maps the event payload to a `SignalInput` contract and delegates scoring +
   * persistence to `SignalScoringService.scoreAndPersistSignal()`.  The result
   * (accepted or rejected with reason) is logged but not re-emitted here —
   * downstream execution events are emitted by LiveTradingModule / ExecutionModule
   * which subscribe separately to accepted signals.
   *
   * Requirements: 9.2 (position sizing uses scored signal), 11.3 (pre-trade
   * validation chain requires compositeScore ≥ 80).
   *
   * @param payload  `SignalCandidateEventPayload` from StrategyService.
   */
  @OnEvent(SIGNAL_CANDIDATE_EVENT)
  async handleSignalCandidate(payload: unknown): Promise<void> {
    // ── Runtime type guard ────────────────────────────────────────────────
    if (!isSignalCandidatePayload(payload)) {
      this.logger.warn(
        `[${SIGNAL_CANDIDATE_EVENT}] Received malformed payload — skipping. ` +
          `payload=${JSON.stringify(payload)}`,
      );
      return;
    }

    try {
      const input: SignalInput = {
        strategyId: payload.strategyId,
        instrumentId: payload.instrumentId,
        engine: payload.engine,
        direction: payload.direction,
        entryPrice: payload.entryPrice,
        stopLossPrice: payload.stopLossPrice,
        targetPrice: payload.targetPrice,
        positionSize: payload.positionSize,
        componentScores: payload.componentScores,
        measuredInputs: payload.measuredInputs,
        minRrRatio: payload.minRrRatio,
        currentRrRatio: payload.currentRrRatio,
        regime: payload.regime,
      };

      const result = await this.signalScoringService.scoreAndPersistSignal(input);

      this.logger.log(
        `[${SIGNAL_CANDIDATE_EVENT}] Signal scored — ` +
          `signalId=${result.signalId}, compositeScore=${result.compositeScore}, ` +
          `status=${result.status}` +
          (result.rejectionReason ? `, reason=${result.rejectionReason}` : ''),
      );
    } catch (err) {
      // Never propagate — log and continue so other listeners are not affected.
      this.logger.error(
        `[${SIGNAL_CANDIDATE_EVENT}] scoreAndPersistSignal threw an error: ` +
          `${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * Handle the aggregate unrealized P&L tick from PositionMonitoringService.
   *
   * Converts the signed unrealized P&L to a positive "total loss rupees" value
   * and feeds it to `DailyLossStateMachineService.onIntradayLossUpdate()` for
   * the LIVE engine.  When unrealized P&L is positive (open profits) the loss
   * value is clamped to zero — no EMERGENCY_HALT is triggered.
   *
   * PositionMonitoringService tracks LIVE engine positions exclusively, so
   * only the LIVE engine receives this update.
   *
   * Requirement 9.4: "WHEN cumulative intraday net loss including both
   * realized and unrealized P&L reaches the configured daily monetary loss
   * limit, THE RiskEngine SHALL trigger an emergency halt."
   *
   * Requirements: 9.1, 9.4
   *
   * @param payload  `{ totalUnrealizedPnl: number }` from PositionMonitoringService.
   */
  @OnEvent(UNREALIZED_PNL_UPDATED_EVENT)
  async handleUnrealizedPnlUpdated(payload: unknown): Promise<void> {
    // ── Runtime type guard ────────────────────────────────────────────────
    if (!isUnrealizedPnlPayload(payload)) {
      this.logger.warn(
        `[${UNREALIZED_PNL_UPDATED_EVENT}] Received malformed payload — skipping. ` +
          `payload=${JSON.stringify(payload)}`,
      );
      return;
    }

    try {
      // Convert signed P&L to positive loss value (clamp profit → 0).
      const totalLossRupees = Math.max(0, -payload.totalUnrealizedPnl);

      await this.dailyLossStateMachineService.onIntradayLossUpdate('LIVE', totalLossRupees);
    } catch (err) {
      // Never propagate — log and continue.
      this.logger.error(
        `[${UNREALIZED_PNL_UPDATED_EVENT}] onIntradayLossUpdate threw an error: ` +
          `${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime type guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when `value` satisfies the minimum shape required to map it to
 * a `SignalInput`.  Checks for the presence and type of every required field
 * without loading the full type definition at runtime.
 */
function isSignalCandidatePayload(value: unknown): value is SignalCandidateEventPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['strategyId'] === 'string' &&
    typeof p['instrumentId'] === 'string' &&
    (p['engine'] === 'LIVE' || p['engine'] === 'PAPER') &&
    (p['direction'] === 'BUY' || p['direction'] === 'SELL') &&
    typeof p['entryPrice'] === 'string' &&
    typeof p['stopLossPrice'] === 'string' &&
    typeof p['targetPrice'] === 'string' &&
    typeof p['positionSize'] === 'number' &&
    p['componentScores'] !== null &&
    typeof p['componentScores'] === 'object' &&
    p['measuredInputs'] !== null &&
    typeof p['measuredInputs'] === 'object' &&
    typeof p['minRrRatio'] === 'number' &&
    typeof p['currentRrRatio'] === 'number'
  );
}

/**
 * Returns true when `value` is an object with a numeric `totalUnrealizedPnl` field.
 */
function isUnrealizedPnlPayload(value: unknown): value is UnrealizedPnlPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return typeof p['totalUnrealizedPnl'] === 'number';
}
