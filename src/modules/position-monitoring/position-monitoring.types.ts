/**
 * position-monitoring.types.ts
 *
 * Shared types, enums, and event-name constants for the PositionMonitoringModule.
 *
 * Requirements: 7.4, 9.4, 12.2
 */

// ─────────────────────────────────────────────────────────────────────────────
// Exit reason enum
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reason codes that may cause PositionMonitoringService to emit a
 * POSITION_EXIT_EVENT for an open position.
 *
 *   SL_HIT                — current market price crossed the active stop-loss level.
 *   TARGET_HIT            — current market price reached the configured target price.
 *   TRAILING_STOP_TRIGGERED — TrailingStopEngine requested an exit after the
 *                             trailing SL level was broken.
 *   THETA_DECAY_THRESHOLD — OptionsIntelligenceModule flagged that daily theta
 *                           decay has exceeded the configured maximum.
 *   EXPIRY_SQUAREOFF      — mandatory expiry-day square-off at the configured IST time.
 */
export enum PositionExitReason {
  SL_HIT = 'SL_HIT',
  TARGET_HIT = 'TARGET_HIT',
  TRAILING_STOP_TRIGGERED = 'TRAILING_STOP_TRIGGERED',
  THETA_DECAY_THRESHOLD = 'THETA_DECAY_THRESHOLD',
  EXPIRY_SQUAREOFF = 'EXPIRY_SQUAREOFF',
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit signal payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload emitted with POSITION_EXIT_EVENT.
 *
 * Consumers (e.g. ExecutionService, LiveTradingModule) listen for this event
 * and submit the appropriate market or limit exit order.
 */
export interface PositionExitSignal {
  /** UUID of the position that should be exited. */
  positionId: string;

  /** Reason code that triggered this exit signal. */
  reason: PositionExitReason;

  /** Current market price at the time the exit condition was detected. */
  currentPrice: number;

  /** UTC timestamp when the exit condition was evaluated. */
  timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event name constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emitted by PositionMonitoringService when an exit condition is detected for
 * an open position.  Payload: PositionExitSignal.
 *
 * Listeners: ExecutionService, LiveTradingModule, PaperTradingModule.
 */
export const POSITION_EXIT_EVENT = 'position.exit';

/**
 * Emitted by PositionMonitoringService after every processed tick with the
 * aggregate sum of unrealized P&L across all currently tracked open positions.
 * Payload: { totalUnrealizedPnl: number }.
 *
 * Consumers: DailyLossStateMachineService (Requirement 9.4 — EMERGENCY_HALT
 * threshold monitoring includes unrealized losses).
 */
export const UNREALIZED_PNL_UPDATED_EVENT = 'risk.unrealized_pnl_updated';
