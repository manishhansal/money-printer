/**
 * trading-charges.types.ts
 *
 * Shared types for the NSE F&O trading charges calculation.
 * Used by TradingChargesService, PaperTradingService, BacktestService,
 * and any live-trading close path.
 */

/**
 * Full breakdown of NSE F&O trading charges for a single round-trip trade.
 * All values are in Indian Rupees (INR).
 */
export interface TradingCharges {
  /** Broker brokerage: ₹20 flat per executed order × 2 legs = ₹40 */
  brokerage: number;

  /**
   * Securities Transaction Tax.
   * Rate: 0.1% of sell-side premium turnover (Budget 2024, effective Oct 2024).
   * Applied only on the sell leg.
   */
  stt: number;

  /**
   * NSE exchange transaction charge.
   * Rate: 0.053% of total turnover (buy + sell premium).
   */
  exchangeCharges: number;

  /**
   * Goods & Services Tax.
   * Rate: 18% applied on (brokerage + exchangeCharges).
   */
  gst: number;

  /**
   * SEBI regulatory turnover fee.
   * Rate: ₹10 per crore of total turnover (= 0.000001 × turnover).
   */
  sebiCharges: number;

  /**
   * Stamp duty (state-level).
   * Rate: 0.003% of buy-side turnover only.
   */
  stampDuty: number;

  /** Sum of all charges above. */
  total: number;
}
