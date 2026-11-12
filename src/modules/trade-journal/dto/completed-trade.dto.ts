/**
 * CompletedTradeDto — payload for journaling a completed round-trip trade.
 *
 * Requirement 13.2 mandates all 20+ fields:
 *   trade_id, instrument, strategy, signal_score, entry_price, exit_price,
 *   quantity, entry_time, exit_time, MFE, MAE, gross_pnl, per-component
 *   charges (brokerage, STT, exchange_charges, GST, SEBI_charges, stamp_duty),
 *   net_pnl, exit_reason, execution_slippage, dhan_entry_order_id,
 *   dhan_exit_order_id.
 *
 * Maps to the `Trade` entity.  5-second SLA from trade completion event.
 *
 * Requirements: 13.1, 13.2, 13.8
 */

export class CompletedTradeDto {
  /** FK → positions.id */
  positionId!: string;

  /** FK → instruments.id */
  instrumentId!: string;

  /** FK → strategies.id */
  strategyId!: string;

  /** FK → signals.id — NULL for manual/system-triggered exits. */
  signalId?: string | null;

  /** Trading engine context. */
  engine!: string; // 'LIVE' | 'PAPER'

  /** Trade direction. */
  direction!: string; // 'LONG' | 'SHORT'

  /** Total quantity traded (in units, not lots). */
  quantity!: number;

  /** Lot size at the time of the trade. */
  lotSize!: number;

  /** Volume-weighted average entry price (INR). */
  entryPrice!: string;

  /** Volume-weighted average exit price (INR). */
  exitPrice!: string;

  /** UTC timestamp of the first entry execution. */
  entryTime!: Date;

  /** UTC timestamp of the final exit execution. */
  exitTime!: Date;

  /**
   * Maximum Favorable Excursion — highest unrealized P&L reached since entry
   * (INR, NUMERIC 15,2).
   */
  mfe!: string;

  /**
   * Maximum Adverse Excursion — most negative unrealized P&L since entry
   * (INR, NUMERIC 15,2).
   */
  mae!: string;

  /**
   * Gross P&L before charges:
   *   (exit_price − entry_price) × quantity for LONG;
   *   (entry_price − exit_price) × quantity for SHORT.
   */
  grossPnl!: string;

  /** Broker brokerage charge (INR). */
  brokerage!: string;

  /** Securities Transaction Tax (INR). */
  stt!: string;

  /** NSE/BSE exchange transaction charge (INR). */
  exchangeCharges!: string;

  /** Goods and Services Tax on brokerage + exchange charges (INR). */
  gst!: string;

  /** SEBI regulatory fee (INR). */
  sebiCharges!: string;

  /** State-level stamp duty (INR). */
  stampDuty!: string;

  /**
   * Net P&L after all costs:
   *   gross_pnl − (brokerage + stt + exchange_charges + gst + sebi_charges + stamp_duty).
   */
  netPnl!: string;

  /**
   * Human-readable exit reason.
   * Examples: 'SL_HIT', 'TARGET_HIT', 'MANDATORY_EXIT', 'KILL_SWITCH',
   *           'PARTIAL_PROFIT_EXIT', 'USER_INITIATED'.
   */
  exitReason!: string;

  /** Observed total execution slippage for the round trip (INR). */
  executionSlippage!: string;

  /**
   * Composite signal score at entry time (0.00 – 100.00).
   * NULL for trades entered without a scored signal.
   */
  signalScore?: string | null;

  /** Dhan order ID for the entry leg. */
  dhanEntryOrderId?: string | null;

  /** Dhan order ID for the exit leg. */
  dhanExitOrderId?: string | null;

  /**
   * Optional: workflow ID of the AgentOrchestratorService research decision
   * that preceded this trade. When provided, DecisionMemoryService.settle()
   * is called after the trade is journaled to close the research feedback loop.
   *
   * NULL for trades that were not preceded by an agent workflow (e.g. manual
   * exits, paper trades without an agent session).
   */
  workflowId?: string | null;
}
