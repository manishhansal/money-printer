/**
 * RiskManagementService — authoritative risk gatekeeper.
 *
 * Responsibilities (Requirements 9.2, 9.5):
 *
 *  1. Position sizing (Req 9.2):
 *       computePositionSize() — formula:
 *         risk_amount = Dynamic_Capital × risk_percentage / 100
 *         quantity    = FLOOR(risk_amount / (|entry_price − stop_loss_price| × lot_size))
 *
 *       Uses BigInt arithmetic throughout to avoid IEEE-754 accumulation errors.
 *       Returns 0 for zero per-unit risk or invalid lot_size.
 *
 *  2. Pre-entry gate evaluation (Req 9.5):
 *       evaluatePreEntryGates() — enforces all 8 gates in the specified order.
 *       Returns the first failing gate name and a human-readable reason.
 *
 * Configuration (via ConfigService, env-overridable):
 *   RISK_PERCENTAGE_DEFAULT   = 1.00  (%)
 *   MAX_PER_TRADE_LOSS_RUPEES = 5000  (INR)
 *   MAX_EXPOSURE_PCT          = 20    (%)
 *   MAX_CORRELATED_PCT        = 10    (%)
 *   MAX_CONCURRENT_TRADES     = 5
 *   MAX_CONCENTRATION_PCT     = 15    (%)
 *
 * Design notes:
 *   - This service is a pure computation unit: it receives all inputs as
 *     parameters and has no DB dependencies.  Persistence of RiskEvents is
 *     delegated to the calling layer (Tasks 16.2, 16.4).
 *   - All arithmetic uses BigInt in units of 10,000ths (SCALE = 10_000n) to
 *     match the 4 dp precision of NUMERIC(x,4) DB columns and avoid rounding
 *     drift across many accumulation steps.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GateResult, PreEntryGateInput, RiskGateName } from './risk-management.types';
import { RiskEventRecorderService } from './risk-event-recorder.service';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** BigInt scale factor — 4 decimal places of precision. */
const SCALE = 10_000n;

/** 100n used for percentage divisions. */
const HUNDRED = 100n;

// ─────────────────────────────────────────────────────────────────────────────
// Default configuration values (overridable via ConfigService / env vars)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_PER_TRADE_LOSS_RUPEES = 5000; // ₹5,000
const DEFAULT_MAX_EXPOSURE_PCT = 20; // 20 %
const DEFAULT_MAX_CORRELATED_PCT = 10; // 10 %
const DEFAULT_MAX_CONCURRENT_TRADES = 5;
const DEFAULT_MAX_CONCENTRATION_PCT = 15; // 15 %

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class RiskManagementService {
  private readonly logger = new Logger(RiskManagementService.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly riskEventRecorderService?: RiskEventRecorderService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes the position size (number of lots) for a signal using BigInt
   * arithmetic to ensure precision (Requirement 9.2).
   *
   * Formula:
   *   risk_amount = Dynamic_Capital × risk_percentage / 100
   *   quantity    = FLOOR(risk_amount / (|entry_price − stop_loss_price| × lot_size))
   *
   * Returns 0 when:
   *   - lot_size ≤ 0           (Req 9.11 — "invalid lot_size configuration")
   *   - |entry − stop| = 0     (Req 9.9  — "zero per-unit risk")
   *
   * @param dynamicCapital  Current Dynamic_Capital (INR, e.g. "100000.00").
   * @param riskPercentage  Risk percentage to apply (e.g. "1.00" for 1%).
   * @param entryPrice      Proposed entry price (INR, e.g. "100.00").
   * @param stopLossPrice   Proposed stop-loss price (INR, e.g. "95.00").
   * @param lotSize         Exchange-defined lot size (positive integer).
   * @returns               Whole-lot quantity, or 0 for invalid inputs.
   */
  computePositionSize(
    dynamicCapital: string,
    riskPercentage: string,
    entryPrice: string,
    stopLossPrice: string,
    lotSize: number,
  ): number {
    // ── Reject invalid lot_size before any arithmetic ──────────────────────
    if (lotSize <= 0) {
      this.logger.debug(
        '[RiskEngine] computePositionSize: invalid lot_size configuration (lot_size ≤ 0)',
      );
      return 0;
    }

    const capitalInt = decimalToInt(dynamicCapital);
    const riskPctInt = decimalToInt(riskPercentage);
    const entryInt = decimalToInt(entryPrice);
    const slInt = decimalToInt(stopLossPrice);

    // ── Reject zero per-unit risk ──────────────────────────────────────────
    // per_unit_risk = |entry − stop| × lot_size
    // Both are in 10,000ths units; the difference is also in 10,000ths.
    const diffInt = entryInt > slInt ? entryInt - slInt : slInt - entryInt;
    if (diffInt === 0n) {
      this.logger.debug('[RiskEngine] computePositionSize: zero per-unit risk (entry equals stop)');
      return 0;
    }

    // ── Compute risk_amount (in 10,000ths units) ───────────────────────────
    // risk_amount_int = capitalInt × riskPctInt / (100 × SCALE)
    //
    // Why divide by (100 × SCALE)?
    //   capitalInt  = capital  × SCALE  (e.g. 100000.00 → 1_000_000_000n)
    //   riskPctInt  = riskPct  × SCALE  (e.g. 1.00 → 10_000n)
    //   product is in units of SCALE^2
    //   divide by SCALE recovers SCALE units: product/SCALE = risk_amount * SCALE * riskPct/100_in_raw
    //   wait, let's be explicit:
    //   risk_amount = capital × riskPct / 100
    //   risk_amount × SCALE = capitalInt × riskPctInt / (100 × SCALE)
    //
    // BigInt division truncates towards zero; all values are non-negative here.
    const riskAmountInt = (capitalInt * riskPctInt) / (HUNDRED * SCALE);

    // ── Compute per_unit_risk (in 10,000ths units) ─────────────────────────
    // perUnitRiskInt = diffInt × lotSize
    //   diffInt is |entry − stop| × SCALE  (in 10,000ths)
    //   lotSize is a plain integer (dimensionless)
    //   product is |entry − stop| × lotSize × SCALE  (in 10,000ths)
    const perUnitRiskInt = diffInt * BigInt(lotSize);

    // ── quantity = FLOOR(risk_amount / per_unit_risk) ──────────────────────
    // Both riskAmountInt and perUnitRiskInt carry the same SCALE factor, so
    // their quotient is dimensionless (= quantity of lots).
    // BigInt integer division implements floor for positive numerator/divisor.
    const quantity = riskAmountInt / perUnitRiskInt;

    const result = Number(quantity);
    this.logger.debug(
      `[RiskEngine] computePositionSize: capital=${dynamicCapital}, ` +
        `riskPct=${riskPercentage}%, entry=${entryPrice}, stop=${stopLossPrice}, ` +
        `lot=${lotSize} → quantity=${result}`,
    );
    return result;
  }

  /**
   * Evaluates all 8 pre-entry risk gates in the mandated order (Req 9.5).
   *
   * Returns on the FIRST failing gate with the specific gate name and reason:
   *   { approved: false, failingGate: 'GATE_NAME', reason: '...' }
   *
   * Returns when all gates pass:
   *   { approved: true, suggestedQuantity: <computed lots> }
   *
   * Gate evaluation order:
   *   1. SIGNAL_SCORE
   *   2. ZERO_PER_UNIT_RISK
   *   3. INVALID_LOT_SIZE
   *   4. PER_TRADE_LOSS
   *   5. TOTAL_EXPOSURE
   *   6. CORRELATED_EXPOSURE
   *   7. CONCURRENT_TRADES
   *   8. CONCENTRATION
   *
   * @param input  All gate evaluation inputs (see PreEntryGateInput).
   */
  evaluatePreEntryGates(input: PreEntryGateInput): GateResult {
    const {
      compositeScore,
      entryPrice,
      stopLossPrice,
      lotSize,
      dynamicCapital,
      riskPercentage,
      currentTotalExposure,
      currentCorrelatedExposure,
      currentInstrumentExposure,
      openPositionsCount,
    } = input;

    // ── Gate 1: SIGNAL_SCORE ──────────────────────────────────────────────
    // compositeScore must be ≥ 80 (Req 8.3, 9.5)
    if (compositeScore < 80) {
      return this.reject(
        'SIGNAL_SCORE',
        `Composite score ${compositeScore} is below the required minimum of 80`,
      );
    }

    // Pre-compute BigInt representations needed by subsequent gates
    const entryInt = decimalToInt(entryPrice);
    const slInt = decimalToInt(stopLossPrice);
    const diffInt = entryInt > slInt ? entryInt - slInt : slInt - entryInt;

    // ── Gate 2: ZERO_PER_UNIT_RISK ────────────────────────────────────────
    // |entry − stop| must be > 0 (Req 9.9)
    if (diffInt === 0n) {
      // Fire-and-forget: persist RiskEvent without blocking the gate decision.
      if (this.riskEventRecorderService && input.engine) {
        void this.riskEventRecorderService
          .recordZeroPerUnitRisk(input.engine, entryPrice, stopLossPrice)
          .catch(() => {
            /* handled inside recordZeroPerUnitRisk */
          });
      }
      return this.reject('ZERO_PER_UNIT_RISK', 'zero per-unit risk');
    }

    // ── Gate 3: INVALID_LOT_SIZE ──────────────────────────────────────────
    // lot_size must be a positive integer (Req 9.11)
    if (lotSize <= 0) {
      // Fire-and-forget: persist RiskEvent without blocking the gate decision.
      if (this.riskEventRecorderService && input.engine) {
        void this.riskEventRecorderService.recordInvalidLotSize(input.engine, lotSize).catch(() => {
          /* handled inside recordInvalidLotSize */
        });
      }
      return this.reject('INVALID_LOT_SIZE', 'invalid lot_size configuration');
    }

    // ── Compute risk_amount and suggested quantity ─────────────────────────
    // These are needed by gates 4–8.
    const capitalInt = decimalToInt(dynamicCapital);
    const riskPctInt = decimalToInt(riskPercentage);
    const riskAmountInt = (capitalInt * riskPctInt) / (HUNDRED * SCALE);
    const perUnitRiskInt = diffInt * BigInt(lotSize);
    const suggestedQuantity = Number(riskAmountInt / perUnitRiskInt);

    // ── Gate 4: PER_TRADE_LOSS ────────────────────────────────────────────
    // risk_amount ≤ MAX_PER_TRADE_LOSS_RUPEES (Req 9.5)
    const maxPerTradeLossRupees =
      this.configService.get<number>('MAX_PER_TRADE_LOSS_RUPEES') ??
      DEFAULT_MAX_PER_TRADE_LOSS_RUPEES;
    // Convert integer rupees → 10,000ths units for comparison
    const maxPerTradeLossInt = BigInt(Math.round(maxPerTradeLossRupees)) * SCALE;
    if (riskAmountInt > maxPerTradeLossInt) {
      return this.reject(
        'PER_TRADE_LOSS',
        `Risk amount exceeds maximum per-trade loss limit of ₹${maxPerTradeLossRupees}`,
      );
    }

    // ── Compute order_exposure (in 10,000ths units) ───────────────────────
    // order_exposure = entry_price × suggestedQuantity × lotSize
    //   entryInt is in SCALE units, quantity and lotSize are plain integers.
    const orderExposureInt = entryInt * BigInt(suggestedQuantity) * BigInt(lotSize);

    // ── Gate 5: TOTAL_EXPOSURE ────────────────────────────────────────────
    // (current_total_exposure + order_exposure) ≤ Dynamic_Capital × MAX_EXPOSURE_PCT / 100
    const maxExposurePct =
      this.configService.get<number>('MAX_EXPOSURE_PCT') ?? DEFAULT_MAX_EXPOSURE_PCT;
    const currentTotalInt = decimalToInt(currentTotalExposure);
    const totalExposureThresholdInt = (capitalInt * BigInt(Math.round(maxExposurePct))) / HUNDRED;
    if (currentTotalInt + orderExposureInt > totalExposureThresholdInt) {
      return this.reject(
        'TOTAL_EXPOSURE',
        `Total exposure would exceed ${maxExposurePct}% of Dynamic Capital`,
      );
    }

    // ── Gate 6: CORRELATED_EXPOSURE ───────────────────────────────────────
    // (same-underlying current exposure + order_exposure) ≤ Dynamic_Capital × MAX_CORRELATED_PCT / 100
    const maxCorrelatedPct =
      this.configService.get<number>('MAX_CORRELATED_PCT') ?? DEFAULT_MAX_CORRELATED_PCT;
    const currentCorrelatedInt = decimalToInt(currentCorrelatedExposure);
    const correlatedThresholdInt = (capitalInt * BigInt(Math.round(maxCorrelatedPct))) / HUNDRED;
    if (currentCorrelatedInt + orderExposureInt > correlatedThresholdInt) {
      return this.reject(
        'CORRELATED_EXPOSURE',
        `Same-underlying exposure would exceed ${maxCorrelatedPct}% of Dynamic Capital`,
      );
    }

    // ── Gate 7: CONCURRENT_TRADES ─────────────────────────────────────────
    // open_positions_count < MAX_CONCURRENT_TRADES (strict less-than)
    const maxConcurrentTrades =
      this.configService.get<number>('MAX_CONCURRENT_TRADES') ?? DEFAULT_MAX_CONCURRENT_TRADES;
    if (openPositionsCount >= maxConcurrentTrades) {
      return this.reject(
        'CONCURRENT_TRADES',
        `Open positions count (${openPositionsCount}) has reached the maximum of ${maxConcurrentTrades}`,
      );
    }

    // ── Gate 8: CONCENTRATION ─────────────────────────────────────────────
    // (single-instrument current exposure + order_exposure) ≤ Dynamic_Capital × MAX_CONCENTRATION_PCT / 100
    const maxConcentrationPct =
      this.configService.get<number>('MAX_CONCENTRATION_PCT') ?? DEFAULT_MAX_CONCENTRATION_PCT;
    const currentInstrumentInt = decimalToInt(currentInstrumentExposure);
    const concentrationThresholdInt =
      (capitalInt * BigInt(Math.round(maxConcentrationPct))) / HUNDRED;
    if (currentInstrumentInt + orderExposureInt > concentrationThresholdInt) {
      return this.reject(
        'CONCENTRATION',
        `Single-instrument exposure would exceed ${maxConcentrationPct}% of Dynamic Capital`,
      );
    }

    // ── All gates passed ──────────────────────────────────────────────────
    this.logger.debug(
      `[RiskEngine] evaluatePreEntryGates: all 8 gates passed — suggestedQuantity=${suggestedQuantity}`,
    );
    return { approved: true, suggestedQuantity };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Constructs a rejection result and logs it at debug level. */
  private reject(failingGate: RiskGateName, reason: string): GateResult {
    this.logger.debug(`[RiskEngine] Gate FAILED — ${failingGate}: ${reason}`);
    return { approved: false, failingGate, reason };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level BigInt arithmetic helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a decimal string to a BigInt in units of 10^-4 (10,000ths).
 *
 * Handles negative values and up to 4 decimal places; digits beyond 4 dp
 * are truncated (consistent with NUMERIC(x,4) DB storage).
 *
 * Examples:
 *   '100000.00' → 1_000_000_000n
 *   '95.00'     → 950_000n
 *   '1.00'      → 10_000n
 *   '0.50'      → 5_000n
 *   '-50.25'    → -502_500n
 *   '0'         → 0n
 */
function decimalToInt(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '0' || trimmed === '0.0' || trimmed === '0.00') return 0n;

  const isNegative = trimmed.startsWith('-');
  const abs = isNegative ? trimmed.slice(1) : trimmed;

  const dotIndex = abs.indexOf('.');
  const intStr = dotIndex === -1 ? abs : abs.slice(0, dotIndex);
  const fracStr = dotIndex === -1 ? '' : abs.slice(dotIndex + 1);

  // Normalise to exactly 4 decimal digits (pad right, truncate beyond 4 dp)
  const frac4 = fracStr.padEnd(4, '0').slice(0, 4);

  const result = BigInt(intStr || '0') * SCALE + BigInt(frac4);
  return isNegative ? -result : result;
}
