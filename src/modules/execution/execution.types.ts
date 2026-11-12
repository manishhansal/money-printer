/**
 * execution.types.ts
 *
 * Shared type definitions for the ExecutionModule.
 *
 * Requirements: 11.3, 11.4
 */

import { DhanExchangeSegment, DhanProductType } from '../dhan/dhan-api.types';

// ---------------------------------------------------------------------------
// Pre-trade check names
// ---------------------------------------------------------------------------

/**
 * Identifier for each pre-trade validation check in the 5-step chain.
 * Returned in OrderResponse.rejectedBy when a check fails.
 */
export type PreTradeCheck =
  | 'duplicate-order-rejected' // Check 0: Redis idempotency key already exists (Req 16.6, 16.7)
  | 'engine-not-armed' //        Check 0a: LIVE engine is not in ARMED state (Req 11.1, 11.3)
  | 'entry-blocked' //           Check 0b: isNewEntryBlocked() — CLOSING/LOCKOUT/HALT (Req 17.3, 11.3)
  | 'score-below-threshold' // Check 1: compositeScore < 80
  | 'risk-engine-rejected' // Check 2: RiskManagementService.evaluatePreEntryGates rejected
  | 'insufficient-margin' // Check 3: available margin < required margin
  | 'duplicate-order' // Check 4: open order exists for same instrument + direction
  | 'session-time-violation'; // Check 5: current phase is not an active trading phase

// ---------------------------------------------------------------------------
// OrderRequest
// ---------------------------------------------------------------------------

/**
 * All inputs required to validate and place an order through the
 * 5-check pre-trade chain, then submit to the Dhan broker.
 *
 * Requirements 11.3, 11.4.
 */
export interface OrderRequest {
  // --- Idempotency ---
  /** Client-assigned idempotency key (UUID).  Stored on the Orders row to
   *  prevent duplicate broker submissions (Requirement 16.6). */
  idempotencyKey: string;

  // --- Engine context ---
  /** Execution engine — 'LIVE' or 'PAPER'. */
  engine: 'LIVE' | 'PAPER';

  // --- Signal context ---
  /** DB UUID of the signal that generated this order.  Nullable for system orders. */
  signalId?: string;
  /** Composite signal score (0–100).  Check 1 requires ≥ 80. */
  compositeScore: number;

  // --- Instrument ---
  /** DB UUID from the instruments table. */
  instrumentId: string;
  /** Dhan platform security ID string. */
  securityId: string;
  /** Dhan exchange segment (e.g. 'NSE_FNO'). */
  exchangeSegment: DhanExchangeSegment;
  /** Dhan product type (e.g. 'INTRADAY'). */
  productType: DhanProductType;

  // --- Order details ---
  /** Order variety — mapped to DhanOrderType on submission. */
  orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  /** BUY or SELL. */
  transactionType: 'BUY' | 'SELL';
  /**
   * Quantity in UNITS (i.e. selectedLots × lotSize).
   *
   * This is the actual number of contract units to submit to the Dhan API.
   * It is NOT the number of lots.  The caller MUST multiply selected lots by
   * the instrument's exchange-defined lot size before constructing this field.
   *
   * Example: 2 lots of NIFTY (lot_size=75) → quantity = 150.
   *
   * Validation: quantityUnits % lotSize === 0 is enforced by ExecutionService.
   */
  quantity: number;
  /**
   * Number of lots selected for this order (informational; used for display
   * and analytics).  The authoritative execution quantity is `quantity` above.
   * Optional for backward-compatibility with callers that only provide units.
   */
  selectedLots?: number;
  /** Limit price — required for LIMIT orders. */
  price?: number;
  /** Trigger price — required for SL / SL-M orders. */
  triggerPrice?: number;

  // --- Risk gate inputs (passed verbatim to RiskManagementService.evaluatePreEntryGates) ---
  /** Proposed entry price (INR, NUMERIC string, e.g. "100.00"). */
  entryPrice: string;
  /** Proposed stop-loss price (INR, NUMERIC string, e.g. "95.00"). */
  stopLossPrice: string;
  /** Exchange-defined lot size (positive integer). */
  lotSize: number;
  /** Current Dynamic_Capital (INR, NUMERIC string, e.g. "100000.00"). */
  dynamicCapital: string;
  /** Effective risk percentage (e.g. "1.00" for 1 %). */
  riskPercentage: string;
  /** Sum of open position notional values for this engine (INR, NUMERIC string). */
  currentTotalExposure: string;
  /** Sum of open position notional values sharing the same underlying (INR, NUMERIC string). */
  currentCorrelatedExposure: string;
  /** Existing notional already held in this specific instrument (INR, NUMERIC string). */
  currentInstrumentExposure: string;
  /** Count of currently open positions across the engine. */
  openPositionsCount: number;

  // --- Margin check ---
  /** Minimum available margin required to place this order (INR). */
  requiredMargin: number;
}

// ---------------------------------------------------------------------------
// OrderResponse
// ---------------------------------------------------------------------------

/**
 * Returned by ExecutionService.placeOrder().
 *
 * On rejection by a pre-trade check, `status` is 'rejected' and `rejectedBy`
 * names the failing check.  No broker submission is made.
 *
 * On success, `orderId` is the DB UUID, `dhanOrderId` is the broker order ID,
 * and `status` is 'submitted'.
 */
export interface OrderResponse {
  /** DB UUID (from Orders table).  NULL when rejected before DB persistence. */
  orderId: string | null;
  /** Dhan broker order ID.  NULL until submitted. */
  dhanOrderId: string | null;
  /** Current lifecycle status. */
  status: 'submitted' | 'rejected' | 'cancelled' | 'open' | 'pending';
  /** Name of the pre-trade check that rejected this order, if applicable. */
  rejectedBy?: PreTradeCheck;
  /** Human-readable reason accompanying a rejection. */
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// PreTradeCheckResult
// ---------------------------------------------------------------------------

/**
 * Intermediate result returned by each step in the pre-trade validation chain.
 */
export interface PreTradeCheckResult {
  /** True when the check passed; false when it failed. */
  passed: boolean;
  /** Name of the failing check — set only when `passed` is false. */
  failingCheck?: PreTradeCheck;
  /** Human-readable explanation of the failure. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// OrderModification
// ---------------------------------------------------------------------------

/**
 * Fields that can be changed on an existing pending/open order.
 * Corresponds to DhanModifyOrderRequest fields.
 */
export interface OrderModification {
  /** New order variety.  Required if changing between LIMIT / SL / SL-M. */
  orderType?: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  /** New quantity. */
  quantity?: number;
  /** New limit price. */
  price?: number;
  /** New trigger price (for SL / SL-M). */
  triggerPrice?: number;
  /** Disclosed quantity for iceberg orders. */
  disclosedQuantity?: number;
}

// ---------------------------------------------------------------------------
// FillData
// ---------------------------------------------------------------------------

/**
 * Payload delivered to ExecutionService.handleFill() when a fill event
 * arrives (e.g. via DhanWebSocketClient or the order-status poller).
 */
export interface FillData {
  /** DB UUID of the Order being filled. */
  orderId: string;
  /** Dhan broker trade ID for this specific fill. */
  dhanTradeId?: string;
  /** Actual fill price (INR, NUMERIC string, e.g. "102.50"). */
  fillPrice: string;
  /** Number of units/lots filled in this event. */
  fillQuantity: number;
  /** UTC timestamp of the fill confirmation. */
  fillTimestamp: Date;
  /** Observed slippage: |fill_price − expected_price| (NUMERIC string). */
  slippage?: string;
  /** Engine context for the Executions row. */
  engine: 'LIVE' | 'PAPER';
}
