/**
 * TradeQualityForensicsService
 *
 * Implements Trade Quality Forensics for completed trades.
 *
 * Key concepts
 * ────────────
 * • QCR (Quality Capture Ratio) = actual_net_pnl / MFE.
 *   It measures what fraction of the best available unrealised profit
 *   was actually captured at exit.
 * • When MFE = 0 there is no favourable excursion to divide by — QCR is
 *   recorded as null and the execution quality is set to
 *   'No Favorable Excursion' without performing any division.
 *
 * Requirements: 20.3, 20.4
 */

import { Injectable } from '@nestjs/common';
import { ExitClassification, ExecutionQuality } from './analytics.types';

@Injectable()
export class TradeQualityForensicsService {
  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Compute the Quality Capture Ratio (QCR).
   *
   * QCR = netPnl / mfe
   *
   * Returns `null` when `mfe === 0` to prevent division by zero.
   * Any non-zero MFE (including negative values that represent data anomalies)
   * will produce a numeric ratio; callers should validate MFE ≥ 0 before
   * calling this method.
   *
   * Requirements: 20.3, 20.4
   */
  computeQcr(netPnl: number, mfe: number): number | null {
    if (mfe === 0) return null;
    return netPnl / mfe;
  }

  /**
   * Classify the trade exit based on QCR and the timing of the MFE relative
   * to the actual exit time.
   *
   * | Condition                                      | Result                   |
   * |------------------------------------------------|--------------------------|
   * | qcr === null                                   | 'no-favorable-excursion' |
   * | qcr < 0.70                                     | 'premature'              |
   * | qcr ≥ 0.70 AND exitTime ≤ mfeTime              | 'near-optimal'           |
   * | qcr ≥ 0.70 AND exitTime > mfeTime (or no time) | 'late'                   |
   *
   * When `mfeTime` is `null` and `qcr >= 0.70`, the method cannot confirm that
   * the exit occurred at or before the MFE peak, so it conservatively returns
   * `'late'`.
   *
   * Requirements: 20.3, 20.4
   */
  classifyExit(qcr: number | null, exitTime: Date, mfeTime: Date | null): ExitClassification {
    if (qcr === null) return 'no-favorable-excursion';
    if (qcr < 0.7) return 'premature';

    // qcr >= 0.70: distinguish near-optimal vs late based on timing.
    if (mfeTime !== null && exitTime <= mfeTime) return 'near-optimal';
    return 'late';
  }

  /**
   * Rate the overall execution quality based solely on the QCR value.
   *
   * | QCR range       | Rating                   |
   * |-----------------|--------------------------|
   * | null (MFE = 0)  | 'No Favorable Excursion' |
   * | qcr < 0.40      | 'Poor'                   |
   * | 0.40 ≤ qcr < 0.70 | 'Fair'                 |
   * | 0.70 ≤ qcr < 0.90 | 'Good'                 |
   * | qcr ≥ 0.90      | 'Excellent'              |
   *
   * Requirements: 20.3, 20.4
   */
  rateExecutionQuality(qcr: number | null): ExecutionQuality {
    if (qcr === null) return 'No Favorable Excursion';
    if (qcr < 0.4) return 'Poor';
    if (qcr < 0.7) return 'Fair';
    if (qcr < 0.9) return 'Good';
    return 'Excellent';
  }
}
