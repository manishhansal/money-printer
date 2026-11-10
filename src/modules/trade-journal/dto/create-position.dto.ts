/**
 * CreatePositionDto — payload for journaling a new position record.
 *
 * Maps to the `Position` entity.  The TradeJournal only INSERTs the opening
 * snapshot; subsequent updates (MFE, MAE, trailing SL) are managed by the
 * PositionMonitoringModule and TrailingStopEngine directly on the entity.
 *
 * Requirements: 13.1
 */

import { Direction } from '../../../database/entities/positions.entity';

export class CreatePositionDto {
  /** Trading engine context. */
  engine!: string; // 'LIVE' | 'PAPER'

  /** FK → instruments.id */
  instrumentId!: string;

  /** FK → signals.id — NULL for manually initiated positions. */
  signalId?: string | null;

  /** Position direction. */
  direction!: Direction;

  /** Opening quantity (in units, not lots). */
  quantity!: number;

  /** Volume-weighted average price of all entry executions (INR). */
  averageEntryPrice!: string;

  /** Initial stop-loss level (INR). NULL until TrailingStopEngine activates. */
  currentSl?: string | null;

  /** Target price (INR). NULL for trailing-stop-only strategies. */
  targetPrice?: string | null;

  /**
   * Active trailing stop mechanism name.
   * One of: 'ATR', 'SWING_HL', 'CHANDELIER', 'PERCENTAGE', 'VOLATILITY_ADJUSTED',
   *         'STRUCTURE', 'TIME', 'PARTIAL_PROFIT'.
   * NULL until TrailingStopEngine activates.
   */
  trailingStopMechanism?: string | null;

  /** UTC timestamp when the first entry execution was confirmed. */
  openedAt!: Date;
}
