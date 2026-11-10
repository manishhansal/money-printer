/**
 * RiskManagement module shared types.
 *
 * Exports:
 *   - RiskGateName:    string-literal union for every pre-entry gate.
 *   - GateResult:      discriminated union returned by evaluatePreEntryGates.
 *   - PreEntryGateInput: all inputs required to evaluate all 8 gates.
 *
 * Requirements: 9.2, 9.5, 9.9, 9.11
 */

import { EngineType } from '../../database/entities/capital-ledgers.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Gate names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Names of all 8 pre-entry risk gates, enforced in this exact order
 * (Requirement 9.5).
 *
 * Gate order:
 *   1. SIGNAL_SCORE          — composite score ≥ 80
 *   2. ZERO_PER_UNIT_RISK    — |entry − stop| > 0
 *   3. INVALID_LOT_SIZE      — lot_size > 0 and configured
 *   4. PER_TRADE_LOSS        — risk_amount ≤ MAX_PER_TRADE_LOSS_RUPEES
 *   5. TOTAL_EXPOSURE        — (current + order) ≤ Dynamic_Capital × MAX_EXPOSURE_PCT / 100
 *   6. CORRELATED_EXPOSURE   — same-underlying total ≤ Dynamic_Capital × MAX_CORRELATED_PCT / 100
 *   7. CONCURRENT_TRADES     — open_positions_count < MAX_CONCURRENT_TRADES
 *   8. CONCENTRATION         — single-instrument total ≤ Dynamic_Capital × MAX_CONCENTRATION_PCT / 100
 */
export type RiskGateName =
  | 'SIGNAL_SCORE'
  | 'ZERO_PER_UNIT_RISK'
  | 'INVALID_LOT_SIZE'
  | 'PER_TRADE_LOSS'
  | 'TOTAL_EXPOSURE'
  | 'CORRELATED_EXPOSURE'
  | 'CONCURRENT_TRADES'
  | 'CONCENTRATION';

// ─────────────────────────────────────────────────────────────────────────────
// Gate result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated union returned by RiskManagementService.evaluatePreEntryGates.
 *
 * On approval:  { approved: true,  suggestedQuantity: number }
 * On rejection: { approved: false, failingGate: RiskGateName, reason: string }
 *
 * The first gate to fail is returned immediately; subsequent gates are not
 * evaluated (Requirement 9.5).
 */
export type GateResult =
  | { approved: true; suggestedQuantity: number }
  | { approved: false; failingGate: RiskGateName; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Gate input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All inputs required to evaluate all 8 pre-entry risk gates.
 *
 * Monetary string fields use PostgreSQL NUMERIC decimal notation
 * (e.g. "100000.00").  The caller is responsible for supplying
 * authoritative values; the RiskEngine performs no DB reads itself.
 */
export interface PreEntryGateInput {
  /**
   * Composite signal score on a 0–100 scale.
   * Gate 1 (SIGNAL_SCORE) requires this to be ≥ 80.
   */
  compositeScore: number;

  /**
   * Proposed entry price (INR, NUMERIC string, e.g. "100.00").
   * Gates 2 and 5–8 use this.
   */
  entryPrice: string;

  /**
   * Proposed stop-loss price (INR, NUMERIC string, e.g. "95.00").
   * Gate 2 requires |entryPrice − stopLossPrice| > 0.
   */
  stopLossPrice: string;

  /**
   * Exchange-defined lot size for this instrument (positive integer).
   * Gate 3 requires this to be > 0.
   */
  lotSize: number;

  /**
   * Current Dynamic_Capital (INR, NUMERIC string, e.g. "100000.00").
   * Source of truth for risk_amount computation and all percentage-based
   * exposure limits (gates 4–6, 8).
   */
  dynamicCapital: string;

  /**
   * Effective risk percentage for this signal (e.g. "1.00" for 1%).
   * Callers should pass the applicable rate; if omitted in the config
   * fallback path the service uses RISK_PERCENTAGE_DEFAULT.
   */
  riskPercentage: string;

  /**
   * Sum of notional values of all currently open positions for this engine
   * (INR, NUMERIC string, e.g. "15000.00").
   * Gate 5 (TOTAL_EXPOSURE) adds the new order's exposure to this.
   */
  currentTotalExposure: string;

  /**
   * Sum of notional values of all open positions sharing the same underlying
   * (INR, NUMERIC string, e.g. "5000.00").
   * Gate 6 (CORRELATED_EXPOSURE) adds the new order's exposure to this.
   */
  currentCorrelatedExposure: string;

  /**
   * Existing notional value already held in this specific instrument
   * (INR, NUMERIC string, e.g. "0.00").
   * Gate 8 (CONCENTRATION) adds the new order's exposure to this.
   */
  currentInstrumentExposure: string;

  /**
   * Count of currently open positions across the engine.
   * Gate 7 (CONCURRENT_TRADES) requires this to be < MAX_CONCURRENT_TRADES.
   */
  openPositionsCount: number;

  /**
   * Trading engine context ('LIVE' | 'PAPER').
   * When provided, gate 2 (ZERO_PER_UNIT_RISK) and gate 3 (INVALID_LOT_SIZE)
   * rejections are persisted to the RiskEvents table via RiskEventRecorderService.
   * Optional for backward compatibility with callers that do not need persistence.
   */
  engine?: EngineType;
}
