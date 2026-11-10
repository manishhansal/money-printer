/**
 * Compliance module shared types.
 *
 * Exports:
 *   - ComplianceGate:        enum of the 4 live-deployment profitability gates.
 *   - TradeRecord:           single trade record (pnl + regime label).
 *   - BacktestStats:         aggregated backtest statistics passed to gate evaluation.
 *   - ComplianceCheckResult: discriminated result returned by checkLiveDeploymentGates.
 *
 * Requirements: 15.3, 15.5
 */

// ─────────────────────────────────────────────────────────────────────────────
// Gate enum
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Names of the 4 live-deployment profitability gates, evaluated in this order:
 *
 *   1. POSITIVE_EXPECTANCY      — out-of-sample expectancy must be > 0
 *   2. MAX_DRAWDOWN             — maximum drawdown ≤ configured threshold
 *   3. MIN_TRADES_PER_REGIME    — ≥ 30 closed trades for every regime tested
 *   4. MONTE_CARLO_ROBUSTNESS   — ≥ 95% of 1,000 bootstrap iterations yield
 *                                  positive out-of-sample expectancy
 */
export enum ComplianceGate {
  POSITIVE_EXPECTANCY = 'POSITIVE_EXPECTANCY',
  MAX_DRAWDOWN = 'MAX_DRAWDOWN',
  MIN_TRADES_PER_REGIME = 'MIN_TRADES_PER_REGIME',
  MONTE_CARLO_ROBUSTNESS = 'MONTE_CARLO_ROBUSTNESS',
}

// ─────────────────────────────────────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single closed trade record used as input to the Monte Carlo engine.
 */
export interface TradeRecord {
  /** Net P&L for this trade (can be negative). */
  pnl: number;
  /** Market regime label active when this trade was taken. */
  regime: string;
}

/**
 * Aggregated backtest statistics required to evaluate all 4 profitability gates.
 */
export interface BacktestStats {
  /** Mean out-of-sample P&L per trade (Gate 1). */
  expectancy: number;
  /** Peak-to-trough maximum drawdown as a decimal fraction (Gate 2). */
  maxDrawdown: number;
  /**
   * Closed-trade count keyed by regime label (Gate 3).
   * Every regime listed here must have ≥ 30 trades.
   */
  tradesByRegime: Record<string, number>;
  /** Full list of individual trade records used by the Monte Carlo engine (Gate 4). */
  trades: TradeRecord[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Result type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result returned by ComplianceService.checkLiveDeploymentGates.
 *
 * On pass:    { passed: true }
 * On failure: { passed: false, failingGate, failingCriterion, computedValue, thresholdValue }
 *
 * The first gate to fail is returned; subsequent gates are not evaluated.
 */
export interface ComplianceCheckResult {
  /** true when all 4 gates passed; false otherwise. */
  passed: boolean;
  /** Which of the 4 gates caused the failure (undefined on pass). */
  failingGate?: ComplianceGate;
  /** Human-readable description of the failing criterion (undefined on pass). */
  failingCriterion?: string;
  /** The computed metric value that caused the failure (undefined on pass). */
  computedValue?: number;
  /** The threshold value the computed metric failed to meet (undefined on pass). */
  thresholdValue?: number;
}
