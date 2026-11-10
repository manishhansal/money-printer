/**
 * CreateFillDto — payload for journaling a fill (execution) record.
 *
 * Maps to the `Execution` entity.  Each fill represents one broker-confirmed
 * partial or complete execution of an order.
 *
 * Requirements: 13.1
 */

export class CreateFillDto {
  /** FK → orders.id — the parent order this fill belongs to. */
  orderId!: string;

  /** Trading engine context — must match the parent order. */
  engine!: string; // 'LIVE' | 'PAPER'

  /**
   * Dhan platform trade ID for this specific fill.
   * NULL for PaperEngine simulated fills.
   */
  dhanTradeId?: string | null;

  /** Actual fill price for this execution (INR). */
  fillPrice!: string;

  /** Number of units/lots filled. */
  fillQuantity!: number;

  /** UTC timestamp when the broker confirmed this fill. */
  fillTimestamp!: Date;

  /**
   * Observed slippage: |fill_price − expected_price| (INR).
   * NULL when slippage measurement is not available.
   */
  slippage?: string | null;
}
