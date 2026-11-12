/**
 * paper-trading.types.ts
 *
 * Type definitions for the PaperTradingModule.
 *
 * All Redis keys defined here carry the `paper:` namespace prefix and all
 * event channel names carry the `events:paper:` prefix to guarantee zero
 * overlap with the LiveEngine key-space (Requirement 10.1).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9
 */

// ─────────────────────────────────────────────────────────────────────────────
// Redis key constants — paper: namespace (Requirement 10.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redis key for the paper portfolio balance (a NUMERIC string).
 * Always prefixed `paper:` — never shared with the live engine.
 *
 * Example value: "1000000.00"
 */
export const PAPER_PORTFOLIO_BALANCE_KEY = 'paper:portfolio:balance';

/**
 * Returns the Redis key for a specific paper order state snapshot.
 * Key format: `paper:orders:{orderId}`
 *
 * Value: JSON-serialised PaperOrderSnapshot.
 */
export const paperOrderKey = (orderId: string): string => `paper:orders:${orderId}`;

/**
 * Returns the Redis idempotency key for a paper order submission.
 * Key format: `paper:orders:idempotency:{idempotencyKey}`
 * TTL: 300 seconds (5 minutes).
 */
export const paperOrderIdempotencyKey = (idempotencyKey: string): string =>
  `paper:orders:idempotency:${idempotencyKey}`;

/**
 * Returns the Redis key for a specific paper position state snapshot.
 * Key format: `paper:positions:{positionId}`
 */
export const paperPositionKey = (positionId: string): string => `paper:positions:${positionId}`;

// ─────────────────────────────────────────────────────────────────────────────
// Event channel constants — events:paper: namespace (Requirement 10.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redis pub/sub channel published when a paper order fill is simulated.
 * Always prefixed `events:paper:` — never shared with live engine channels.
 *
 * Live engine equivalent would be `events:fill` (different channel).
 */
export const PAPER_FILL_EVENT_CHANNEL = 'events:paper:fill';

/**
 * Redis pub/sub channel published when a paper order status changes.
 * Always prefixed `events:paper:`.
 */
export const PAPER_ORDER_EVENT_CHANNEL = 'events:paper:order';

/**
 * Redis pub/sub channel published when a paper position is opened or closed.
 */
export const PAPER_POSITION_EVENT_CHANNEL = 'events:paper:position';

/**
 * Redis pub/sub channel published when a paper trade (round-trip) completes.
 */
export const PAPER_TRADE_EVENT_CHANNEL = 'events:paper:trade';

// ─────────────────────────────────────────────────────────────────────────────
// Slippage configuration (Requirement 10.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Three configurable slippage models supported by the PaperEngine.
 *
 * Requirements 10.5:
 *  - fixed_rupee:    absolute rupee amount added/deducted per fill
 *  - percentage:     percentage of the reference price
 *  - market_impact:  scaled by sqrt(quantity) for large-lot impact
 */
export type PaperSlippageModel = 'fixed_rupee' | 'percentage' | 'market_impact';

/**
 * Slippage configuration passed to PaperTradingService.
 *
 * Validation ranges (Requirement 10.5):
 *  - fixedRupee:   0.00 – 50.00
 *  - percentage:   0.00% – 2.00%
 *  - marketImpact: scale factor applied to sqrt(quantity)
 */
export interface PaperSlippageConfig {
  model: PaperSlippageModel;
  /**
   * Fixed rupee slippage per side (valid: 0.00 – 50.00).
   * Used when model = 'fixed_rupee'.
   * Default: 0.00.
   */
  fixedRupee?: number;
  /**
   * Percentage slippage as a decimal (valid: 0.0000 – 0.0200 for 0%–2%).
   * Used when model = 'percentage'.
   * Default: 0.00.
   */
  percentage?: number;
  /**
   * Market-impact scale factor applied to sqrt(quantity) × unit_price.
   * Used when model = 'market_impact'.
   * Default: 0.001.
   */
  marketImpactFactor?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Latency simulation (Requirement 10.9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported latency distribution types for paper order execution simulation.
 *
 * Requirements 10.9: uniform, normal, or log-normal with configurable mean
 * between 10 ms and 5000 ms. Default: uniform with mean 200 ms.
 */
export type PaperLatencyDistribution = 'uniform' | 'normal' | 'log_normal';

/**
 * Latency simulation configuration.
 */
export interface PaperLatencyConfig {
  distribution: PaperLatencyDistribution;
  /** Mean latency in milliseconds (valid: 10 – 5000). Default: 200. */
  meanMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Order request and result types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request payload passed to `PaperTradingService.submitPaperOrder()`.
 *
 * Callers (typically SignalScoringModule or StrategyModule) supply the signal
 * context plus configuration overrides for slippage, rejection probability,
 * and latency.
 */
export interface PaperOrderRequest {
  /** Client-side idempotency key — prevents duplicate order submissions. */
  idempotencyKey: string;
  /** UUID of the instrument to trade. */
  instrumentId: string;
  /** UUID of the strategy that generated this signal (optional). */
  strategyId?: string;
  /** UUID of the scored signal that triggered this order (optional). */
  signalId?: string;
  /** Direction of the paper order. */
  transactionType: 'BUY' | 'SELL';
  /** Order variety. */
  orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  /**
   * Quantity in UNITS (selectedLots × lotSize).
   *
   * This MUST equal `selectedLots × lotSize`.  For example, 2 lots of NIFTY
   * (lot_size=75) → quantity = 150.  The PaperTrade.quantity column stores units.
   *
   * Callers (SignalDispatcherService) are responsible for the multiplication.
   * PaperTradingService validates `quantity % lotSize === 0` when lotSize is provided.
   */
  quantity: number;
  /**
   * Exchange-defined contract lot size for this instrument.
   * Stored in PaperTrade.lot_size for analytics and correct P&L display.
   * When provided, PaperTradingService validates `quantity % lotSize === 0`.
   * Optional for backward compatibility with callers that only need units.
   */
  lotSize?: number;
  /**
   * Number of lots selected (informational; used for display and analytics).
   * The authoritative execution quantity is `quantity` (units) above.
   */
  selectedLots?: number;
  /**
   * Simulated fill price — either `price` for LIMIT orders or the best
   * available market snapshot LTP ± slippage for MARKET.
   * Optional for MARKET orders where the PaperEngine derives fill from Redis.
   */
  price?: string | null;
  /**
   * Stop-loss price from the originating signal (INR string).
   * Stored in PaperPosition.current_sl to enable SL monitoring.
   */
  stopLossPrice?: string;
  /**
   * Target/take-profit price from the originating signal (INR string).
   * Stored in PaperPosition.target_price to enable target monitoring.
   */
  targetPrice?: string;
  /**
   * Composite signal score at order time (0–100).
   * Used for PaperTrade analytics (signal_score column).
   */
  signalScore?: number;
  /**
   * Optional Redis key suffix for the market snapshot lookup.
   * When provided, `mkt:snapshot:{marketDataKey}` is used instead of
   * `mkt:snapshot:{instrumentId}`, which allows callers to pass the Dhan
   * securityId (the actual Redis key) while `instrumentId` remains the DB UUID.
   * If omitted, `instrumentId` is used as-is (backward compatible).
   */
  marketDataKey?: string;
  /**
   * Slippage configuration override.
   * Defaults to fixed_rupee with fixedRupee = 0.00.
   */
  slippageConfig?: PaperSlippageConfig;
  /**
   * Simulated rejection probability (valid: 0.00 – 1.00).
   * Default: 0.00 (no random rejection).
   * Requirement 10.7.
   */
  rejectionProbability?: number;
  /**
   * Latency simulation configuration.
   * Default: { distribution: 'uniform', meanMs: 200 }.
   * Requirement 10.9.
   */
  latencyConfig?: PaperLatencyConfig;
}

/**
 * Outcome returned by `PaperTradingService.submitPaperOrder()`.
 */
export interface PaperOrderResult {
  /** UUID of the created PaperOrder record. */
  orderId: string;
  /** Final status after simulation. */
  status: 'complete' | 'rejected';
  /**
   * Rejection reason when status = 'rejected'.
   * Values include:
   *   - "market data unavailable" (Requirement 10.4)
   *   - "simulated rejection" (Requirement 10.8)
   *   - "duplicate idempotency key"
   */
  rejectionReason?: string;
  /** UUID of the PaperExecution created on a successful fill. Null when rejected. */
  executionId?: string;
  /** Simulated fill price (INR string). Null when rejected. */
  fillPrice?: string;
  /** UTC timestamp of the simulated fill. Null when rejected. */
  fillTimestamp?: Date;
  /** Simulated latency applied before fill (milliseconds). */
  simulatedLatencyMs?: number;
  /** Slippage amount applied to this fill (INR string). */
  slippageApplied?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event payloads published to Redis pub/sub channels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload published to `events:paper:fill` on every successful simulated fill.
 * Requirement 10.1: channel name must start with `events:paper:`.
 */
export interface PaperFillEventPayload {
  orderId: string;
  executionId: string;
  instrumentId: string;
  transactionType: 'BUY' | 'SELL';
  fillPrice: string;
  fillQuantity: number;
  slippage: string;
  fillTimestamp: string; // ISO 8601
  positionId: string;
  portfolioBalance: string;
}

/**
 * Payload published to `events:paper:order` on order status transitions.
 */
export interface PaperOrderEventPayload {
  orderId: string;
  instrumentId: string;
  status: 'submitted' | 'complete' | 'rejected';
  rejectionReason?: string;
  timestamp: string; // ISO 8601
}

/**
 * Payload published to `events:paper:trade` when a paper trade (round-trip)
 * is fully closed.
 */
export interface PaperTradeEventPayload {
  tradeId: string;
  positionId: string;
  instrumentId: string;
  direction: string;
  entryPrice: string;
  exitPrice: string;
  quantity: number;
  grossPnl: string;
  netPnl: string;
  exitReason: string;
  entryTime: string; // ISO 8601
  exitTime: string; // ISO 8601
  portfolioBalance: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trading cost breakdown (Requirement 10.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fully broken-down trading costs for a paper trade (Requirement 10.6).
 * Uses the identical formulas applied by the LiveEngine.
 */
export interface PaperTradingCosts {
  /** ₹20 flat per executed order (Dhan F&O intraday brokerage). */
  brokerage: number;
  /**
   * STT: 0.05% of sell-side turnover (equity F&O options premium).
   * Applied only to the sell side of the trade.
   */
  stt: number;
  /** NSE exchange transaction charges: 0.05% of turnover. */
  exchangeCharges: number;
  /** GST: 18% of (brokerage + exchange charges). */
  gst: number;
  /** SEBI charges: ₹10 per crore of turnover. */
  sebiCharges: number;
  /** Stamp duty: 0.003% of buy-side turnover. */
  stampDuty: number;
  /** Sum of all individual charges. */
  total: number;
}
