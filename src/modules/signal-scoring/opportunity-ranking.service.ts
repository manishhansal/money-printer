/**
 * OpportunityRankingService — orders all active signals by composite score,
 * estimated expected value, and regime alignment strength, then generates a
 * natural-language explanation for each signal's ranking position.
 *
 * ### Ranking criteria (all descending)
 *   1. `compositeScore`         — raw 0–100 signal quality score
 *   2. `expectedValue`          — compositeScore × rrRatio/(rrRatio+1)
 *   3. `regimeAlignmentStrength` — 0–3 scale (3 = exact match, 0 = mismatch)
 *
 * ### Regime alignment strength
 *   3 — signal's stored `regime` exactly matches `currentRegime`
 *   2 — `currentRegime` was not supplied (alignment unverifiable)
 *   1 — signal has no regime stored
 *   0 — both values are set but they differ (mismatch)
 *
 * Requirements: 20.1
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Signals } from '../../database/entities/signals.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { RankedSignal } from './signal-scoring.types';

@Injectable()
export class OpportunityRankingService {
  constructor(
    @InjectRepository(Signals)
    private readonly signalsRepo: Repository<Signals>,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Retrieve all active signals, rank them, and attach explanations.
   *
   * ### Algorithm
   * 1. Fetch every signal whose `status = 'active'` (with strategy relation).
   * 2. Batch-fetch the instrument trading symbols for all unique instrumentIds.
   * 3. For each signal compute:
   *    - `rrRatio`                — |target−entry| / |entry−stop| (0 if risk=0)
   *    - `expectedValue`          — compositeScore × rrRatio/(rrRatio+1)
   *    - `regimeAlignmentStrength` — 0–3 based on regime matching rules
   * 4. Sort ascending by: compositeScore DESC, expectedValue DESC,
   *    regimeAlignmentStrength DESC.
   * 5. Assign 1-based `rank` and build a natural-language `explanation`.
   *
   * @param currentRegime - The market regime code currently active (optional).
   *                        When supplied, signals whose stored regime matches
   *                        receive the highest alignment strength (3).
   * @returns Array of `RankedSignal` objects, ordered by rank ascending.
   */
  async rankActiveSignals(currentRegime?: string): Promise<RankedSignal[]> {
    // 1. Fetch all active signals with the strategy relation populated.
    const activeSignals = await this.signalsRepo.find({
      where: { status: 'active' },
      relations: ['strategy'],
    });

    if (activeSignals.length === 0) {
      return [];
    }

    // 2. Batch-load instrument trading symbols (single query, avoids N+1).
    const uniqueInstrumentIds = [...new Set(activeSignals.map((s) => s.instrumentId))];
    const instruments = await this.instrumentsRepo.find({
      where: { id: In(uniqueInstrumentIds) },
      select: ['id', 'tradingSymbol'],
    });
    const instrumentMap = new Map(instruments.map((i) => [i.id, i.tradingSymbol]));

    // 3. Compute ranking metrics for each signal.
    const enriched = activeSignals.map((signal) => {
      const compositeScore = parseFloat(signal.compositeScore);
      const rrRatio = computeRrRatio(signal.entryPrice, signal.stopLossPrice, signal.targetPrice);
      const expectedValue = rrRatio === 0 ? 0 : compositeScore * (rrRatio / (rrRatio + 1));
      const regimeAlignmentStrength = computeRegimeAlignmentStrength(signal.regime, currentRegime);
      const tradingSymbol = instrumentMap.get(signal.instrumentId);

      return {
        signal,
        compositeScore,
        rrRatio,
        expectedValue,
        regimeAlignmentStrength,
        tradingSymbol,
      };
    });

    // 4. Sort by: compositeScore DESC → expectedValue DESC →
    //    regimeAlignmentStrength DESC.
    enriched.sort((a, b) => {
      if (b.compositeScore !== a.compositeScore) {
        return b.compositeScore - a.compositeScore;
      }
      if (b.expectedValue !== a.expectedValue) {
        return b.expectedValue - a.expectedValue;
      }
      return b.regimeAlignmentStrength - a.regimeAlignmentStrength;
    });

    // 5. Assign 1-based ranks and generate natural-language explanations.
    return enriched.map((item, index) => {
      const rank = index + 1;
      const explanation = buildExplanation({
        rank,
        compositeScore: item.compositeScore,
        expectedValue: item.expectedValue,
        regimeAlignmentStrength: item.regimeAlignmentStrength,
        rrRatio: item.rrRatio,
        signal: item.signal,
        tradingSymbol: item.tradingSymbol,
        currentRegime,
      });

      return {
        signal: item.signal,
        rank,
        expectedValue: item.expectedValue,
        regimeAlignmentStrength: item.regimeAlignmentStrength,
        explanation,
      };
    });
  }
}

// ─── Pure helper functions (exported for unit testing) ───────────────────────

/**
 * Compute the R:R ratio from stored price strings.
 * Returns 0 when entry equals stop (zero risk — prevents division by zero).
 */
export function computeRrRatio(
  entryPrice: string,
  stopLossPrice: string,
  targetPrice: string,
): number {
  const entry = parseFloat(entryPrice);
  const stop = parseFloat(stopLossPrice);
  const target = parseFloat(targetPrice);

  const reward = Math.abs(target - entry);
  const risk = Math.abs(entry - stop);

  if (risk === 0) {
    return 0;
  }

  return reward / risk;
}

/**
 * Compute the regime alignment strength (0–3).
 *
 *   3 — `signalRegime` equals `currentRegime` (exact match)
 *   2 — `currentRegime` is null / undefined (alignment unverifiable)
 *   1 — `signalRegime` is null (no regime stored on the signal)
 *   0 — both are set but they differ (mismatch)
 */
export function computeRegimeAlignmentStrength(
  signalRegime: string | null | undefined,
  currentRegime: string | undefined,
): number {
  if (currentRegime === null || currentRegime === undefined) {
    return 2;
  }
  if (!signalRegime) {
    return 1;
  }
  if (signalRegime === currentRegime) {
    return 3;
  }
  return 0; // mismatch
}

// ─── Explanation builder ─────────────────────────────────────────────────────

interface ExplanationParams {
  rank: number;
  compositeScore: number;
  expectedValue: number;
  regimeAlignmentStrength: number;
  rrRatio: number;
  signal: Signals;
  tradingSymbol: string | undefined;
  currentRegime: string | undefined;
}

/**
 * Build a human-readable ranking explanation string.
 *
 * Example outputs:
 * - "#1: Score 92/100, EV 61.3, Regime STRONG_BULL (aligned). Strategy A,
 *    BUY NIFTY24JAN21000CE at ₹19500.00, R:R 2.0. High composite score with
 *    strong regime alignment."
 * - "#3: Score 85/100, EV 42.5, Regime BREAKOUT (mismatch — current: SIDEWAYS).
 *    Strategy C, BUY at ₹500.00, R:R 1.5. Lower priority due to regime mismatch."
 */
export function buildExplanation(params: ExplanationParams): string {
  const {
    rank,
    compositeScore,
    expectedValue,
    regimeAlignmentStrength,
    rrRatio,
    signal,
    tradingSymbol,
    currentRegime,
  } = params;

  // ── Regime segment ───────────────────────────────────────────────────────
  let regimeSegment: string;
  if (!signal.regime) {
    regimeSegment = 'Regime none';
  } else if (currentRegime === null || currentRegime === undefined) {
    regimeSegment = `Regime ${signal.regime} (no current regime)`;
  } else if (signal.regime === currentRegime) {
    regimeSegment = `Regime ${signal.regime} (aligned)`;
  } else {
    regimeSegment = `Regime ${signal.regime} (mismatch — current: ${currentRegime})`;
  }

  // ── Instrument + strategy segment ────────────────────────────────────────
  const strategyCode = signal.strategy?.code;
  const strategyPart = strategyCode ? `Strategy ${strategyCode}, ` : '';
  const instrumentPart = tradingSymbol ? ` ${tradingSymbol}` : '';

  // ── Numeric formatting ───────────────────────────────────────────────────
  const scoreRounded = Math.round(compositeScore);
  const evFormatted = expectedValue.toFixed(1);
  const entryFormatted = parseFloat(signal.entryPrice).toFixed(2);
  const rrFormatted = rrRatio.toFixed(1);

  // ── Narrative suffix based on regime alignment strength ──────────────────
  let narrative: string;
  switch (regimeAlignmentStrength) {
    case 3:
      narrative = 'High composite score with strong regime alignment.';
      break;
    case 2:
      narrative = 'Composite score used for ranking; regime alignment unverifiable.';
      break;
    case 1:
      narrative = 'No regime stored on signal; ranked by composite score and expected value.';
      break;
    case 0:
      narrative = 'Lower priority due to regime mismatch.';
      break;
    default:
      narrative = '';
  }

  return (
    `#${rank}: Score ${scoreRounded}/100, EV ${evFormatted}, ${regimeSegment}. ` +
    `${strategyPart}${signal.direction}${instrumentPart} at ₹${entryFormatted}, R:R ${rrFormatted}. ` +
    `${narrative}`
  );
}
