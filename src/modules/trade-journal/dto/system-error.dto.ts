/**
 * SystemErrorDto — payload for journaling a system error or module health event.
 *
 * Maps to the `SystemHealthEvents` entity.  1-second SLA from error occurrence.
 * Corresponds to the "system_errors" record set in the TradeJournal.
 *
 * Requirements: 13.1, 2.7, 2.8
 */

import { HealthEventSeverity } from '../../../database/entities/system-health-events.entity';

export class SystemErrorDto {
  /**
   * Category of health event.
   * Examples: "MODULE_RESTART", "UNHANDLED_EXCEPTION", "DB_CONNECTION_FAILURE",
   *           "CAPITAL_LEDGER_FAILURE".
   */
  eventType!: string;

  /**
   * Name of the CloudEngine module that emitted the event.
   * Examples: "TradeJournal", "RiskManagement", "ExecutionService".
   */
  moduleName!: string;

  /** Severity classification of the event. */
  severity!: HealthEventSeverity;

  /** Human-readable description of the error or health state change. */
  message!: string;

  /**
   * Arbitrary structured context: stack traces, error codes, relevant state.
   * NULL when no additional metadata is available.
   */
  metadata?: Record<string, unknown> | null;

  /** UTC timestamp when the error occurred. */
  timestamp!: Date;
}
