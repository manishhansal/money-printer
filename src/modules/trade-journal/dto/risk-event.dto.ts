/**
 * RiskEventDto — payload for journaling a risk control activation.
 *
 * Requirement 13.5 mandates all fields:
 *   event type, event timestamp, triggering metric name and value,
 *   applicable threshold value, affected instrument or strategy identifier,
 *   and initiating actor.
 *
 * Maps to the `RiskEvents` entity.  1-second SLA from risk event occurrence.
 *
 * Requirements: 13.1, 13.5
 */

import { RiskEventType } from '../../../database/entities/risk-events.entity';
import { EngineType } from '../../../database/entities/capital-ledgers.entity';

export class RiskEventDto {
  /** Trading engine context in which the event occurred. */
  engine!: EngineType;

  /** Specific risk control that was activated. */
  eventType!: RiskEventType;

  /** Human-readable explanation of why the risk control was triggered. */
  reason!: string;

  /**
   * Name of the metric that crossed a threshold.
   * Examples: "daily_loss_pct", "intraday_net_loss", "consecutive_sl_rejections".
   */
  triggeringMetricName?: string | null;

  /**
   * Observed value of the triggering metric at the moment of activation.
   * NUMERIC string to preserve precision.
   */
  triggeringMetricValue?: string | null;

  /**
   * Configured threshold value that was breached.
   * NUMERIC string to match triggering_metric_value precision.
   */
  thresholdValue?: string | null;

  /** FK → instruments.id — the instrument affected, if applicable. */
  affectedInstrumentId?: string | null;

  /** FK → strategies.id — the strategy affected, if applicable. */
  affectedStrategyId?: string | null;

  /**
   * Module or process that initiated the risk action.
   * Examples: "RiskEngine", "UserKillSwitch", "SessionManager", "SYSTEM".
   */
  initiatingActor!: string;

  /** UTC timestamp when the risk event occurred. */
  occurredAt!: Date;
}
