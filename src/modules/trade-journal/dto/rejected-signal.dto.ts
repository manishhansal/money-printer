/**
 * RejectedSignalDto — payload for journaling a rejected signal.
 *
 * Per Requirement 13.6: when a signal is rejected, the TradeJournal records
 * the instrument, strategy, entry timestamp, rejection timestamp, composite
 * score, per-component score breakdown, and rejection reason in the Signals
 * table.
 *
 * Mapped to the `Signals` entity with `status = 'rejected'`.  The
 * `rejectionTimestamp` is stored implicitly via the entity's `created_at`
 * column (which captures the moment the row is INSERTed).
 *
 * Requirements: 13.1, 13.6
 */

import { SignalEngine, SignalDirection } from '../../../database/entities/signals.entity';

export class RejectedSignalDto {
  /** FK → strategies.id */
  strategyId!: string;

  /** FK → instruments.id */
  instrumentId!: string;

  /** Trading engine context. */
  engine!: SignalEngine;

  /** Trade direction. */
  direction!: SignalDirection;

  /** Proposed entry price (INR). */
  entryPrice!: string;

  /** Stop-loss price (INR). */
  stopLossPrice!: string;

  /** Target price (INR). */
  targetPrice!: string;

  /** Position size in lots. */
  positionSize!: number;

  /** Composite score (0.00 – 100.00). */
  compositeScore!: string;

  /** Component score: regime alignment (max 15). */
  scoreRegimeAlignment!: string;

  /** Component score: price structure quality (max 15). */
  scorePriceStructure!: string;

  /** Component score: volume confirmation (max 15). */
  scoreVolumeConfirmation!: string;

  /** Component score: momentum indicator alignment (max 10). */
  scoreMomentum!: string;

  /** Component score: VWAP trend alignment (max 10). */
  scoreVwapTrend!: string;

  /** Component score: options/futures market confirmation (max 15). */
  scoreOptionsFutures!: string;

  /** Component score: liquidity and execution feasibility (max 10). */
  scoreLiquidityExecution!: string;

  /** Component score: risk:reward quality (max 10). */
  scoreRrQuality!: string;

  /** Raw measured input values for the 8 scoring components. */
  measuredInputs!: Record<string, unknown>;

  /**
   * Reason the signal was rejected.
   * Examples: "score below threshold", "zero per-unit risk", "RiskEngine rejection".
   */
  rejectionReason!: string;

  /** UTC timestamp when the signal was originally generated (entry timestamp). */
  signalTimestamp!: Date;

  /**
   * UTC timestamp when the rejection decision was made.
   * Stored in `expiryTimestamp` column for audit purposes since the entity
   * does not have a dedicated rejection_timestamp column; the semantic
   * is "the signal lifecycle ended at this point".
   */
  rejectionTimestamp!: Date;

  /** Market regime code active at signal-generation time. */
  regime?: string | null;
}
