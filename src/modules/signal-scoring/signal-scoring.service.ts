/**
 * SignalScoringService — computes composite scores for trading signals and
 * persists every signal to the `Signals` database table.
 *
 * Responsibilities:
 *  1. Enforce R:R Quality = 0 when signal R:R < strategy's min_rr_ratio (Req 8.5)
 *  2. Compute composite score as arithmetic sum of all 8 weighted components (Req 8.1)
 *  3. Reject signals with composite score < 80 as "score below threshold" (Req 8.3)
 *  4. Persist every generated signal to the `Signals` table (Req 8.2, 8.4)
 *  5. Mark signals as "expired" when max_validity_duration is exceeded (Req 8.7)
 *  6. Revalidate entry-price-deviated signals against the 80-point threshold (Req 8.6)
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import {
  SignalComponentScores,
  SignalInput,
  ScoredSignal,
  PersistedScoredSignal,
  SCORE_ACCEPTANCE_THRESHOLD,
} from './signal-scoring.types';
import { Signals } from '../../database/entities/signals.entity';
import { Strategies } from '../../database/entities/strategies.entity';

/** Default validity window in seconds if the caller does not specify one. */
const DEFAULT_MAX_VALIDITY_SECONDS = 300; // 5 minutes

/** Default price deviation threshold (0.5%) if not configured on the strategy. */
const DEFAULT_PRICE_DEVIATION_THRESHOLD = 0.005;

/** Interval at which expired signals are checked (10 seconds). */
const EXPIRY_CHECK_INTERVAL_MS = 10_000;

@Injectable()
export class SignalScoringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SignalScoringService.name);
  private expiryInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectRepository(Signals)
    private readonly signalsRepo: Repository<Signals>,
  ) {}

  // ─── Lifecycle hooks ────────────────────────────────────────────────────────

  /**
   * Start the background expiry-check interval when the module is initialised.
   */
  onModuleInit(): void {
    this.expiryInterval = setInterval(() => {
      this.expireStaleSignals().catch((err) =>
        this.logger.error('Signal expiry check failed', err),
      );
    }, EXPIRY_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the background expiry-check interval when the module is destroyed.
   */
  onModuleDestroy(): void {
    if (this.expiryInterval !== null) {
      clearInterval(this.expiryInterval);
      this.expiryInterval = null;
    }
  }

  // ─── Pure scoring (stateless, no I/O) ───────────────────────────────────────

  /**
   * Score a signal by summing all 8 weighted components and applying
   * the R:R Quality enforcement and acceptance threshold rules.
   *
   * ### Enforcement rules (applied in order)
   * 1. **R:R Quality override** (Req 8.5):
   *    If `input.currentRrRatio` is strictly less than `input.minRrRatio`,
   *    the `rrQuality` component is overridden to 0 regardless of the
   *    caller-supplied value.
   *
   * 2. **Composite score computation** (Req 8.1):
   *    `compositeScore = sum of all 8 component scores` (after any override).
   *
   * 3. **Acceptance threshold** (Req 8.3):
   *    If `compositeScore < 80`, the signal is rejected with status
   *    `"rejected"` and reason `"score below threshold"`.
   *    If `compositeScore >= 80`, the signal is active and approved.
   *
   * @param input - Full signal input including pre-computed component scores
   *                and R:R figures from the originating strategy.
   * @returns ScoredSignal with compositeScore, final component breakdown, and decision.
   */
  scoreSignal(input: SignalInput): ScoredSignal {
    // Step 1: Apply R:R Quality enforcement (Req 8.5)
    // A shallow copy ensures we do not mutate the caller's object.
    const componentScores: SignalComponentScores = { ...input.componentScores };
    if (input.currentRrRatio < input.minRrRatio) {
      componentScores.rrQuality = 0;
    }

    // Step 2: Compute composite score as arithmetic sum of all 8 components (Req 8.1)
    const compositeScore =
      componentScores.regimeAlignment +
      componentScores.priceStructure +
      componentScores.volumeConfirmation +
      componentScores.momentum +
      componentScores.vwapTrendAlignment +
      componentScores.optionsFuturesConfirmation +
      componentScores.liquidityExecution +
      componentScores.rrQuality;

    // Step 3: Apply acceptance threshold (Req 8.3)
    if (compositeScore < SCORE_ACCEPTANCE_THRESHOLD) {
      return {
        compositeScore,
        componentScores,
        status: 'rejected',
        rejectionReason: 'score below threshold',
        approved: false,
      };
    }

    return {
      compositeScore,
      componentScores,
      status: 'active',
      approved: true,
    };
  }

  /**
   * Compute the Risk:Reward ratio for a proposed trade from raw price strings.
   *
   * The formula is direction-agnostic:
   * ```
   *   R:R = |target - entry| / |entry - stop|
   * ```
   * This matches both the BUY and SELL conventions from the strategy spec:
   * - **BUY** : `(target − entry) / (entry − stop)`  (target > entry > stop)
   * - **SELL**: `(entry − target) / (stop − entry)`  (entry > target, stop > entry)
   *
   * Returns `0` when `entry` equals `stop` to prevent division by zero.
   * The caller should treat a 0 R:R as an invalid signal (see Req 9.9).
   *
   * @param entryPrice     - Proposed entry price as a numeric string (INR).
   * @param stopLossPrice  - Stop-loss price as a numeric string (INR).
   * @param targetPrice    - Target price as a numeric string (INR).
   * @returns R:R ratio as a positive number, or 0 if risk is zero.
   */
  computeRrRatio(entryPrice: string, stopLossPrice: string, targetPrice: string): number {
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

  // ─── Persistence ─────────────────────────────────────────────────────────────

  /**
   * Score the signal AND persist it to the `Signals` table (Req 8.2, 8.4).
   *
   * The `signal_timestamp` is set to `now`; the `expiry_timestamp` is computed
   * as `now + maxValidityDurationSeconds` (default 300 s when not supplied by
   * the caller).
   *
   * Every signal is persisted regardless of whether it is accepted or rejected
   * so that the full history is available for audit and back-testing.
   *
   * @param input - Full signal input (same contract as `scoreSignal`).
   * @returns The in-memory `ScoredSignal` result extended with the DB-assigned `signalId`.
   */
  async scoreAndPersistSignal(input: SignalInput): Promise<PersistedScoredSignal> {
    const scored = this.scoreSignal(input);

    const now = new Date();
    const validitySeconds = input.maxValidityDurationSeconds ?? DEFAULT_MAX_VALIDITY_SECONDS;
    const expiryTimestamp = new Date(now.getTime() + validitySeconds * 1_000);

    const entity = this.signalsRepo.create({
      // Relation FK — TypeORM resolves the UUID without loading the full entity.
      strategy: { id: input.strategyId } as Strategies,
      instrumentId: input.instrumentId,
      engine: input.engine,
      direction: input.direction,
      entryPrice: input.entryPrice,
      stopLossPrice: input.stopLossPrice,
      targetPrice: input.targetPrice,
      positionSize: input.positionSize,
      // Composite and component scores (NUMERIC stored as string in pg)
      compositeScore: scored.compositeScore.toString(),
      scoreRegimeAlignment: scored.componentScores.regimeAlignment.toString(),
      scorePriceStructure: scored.componentScores.priceStructure.toString(),
      scoreVolumeConfirmation: scored.componentScores.volumeConfirmation.toString(),
      scoreMomentum: scored.componentScores.momentum.toString(),
      scoreVwapTrend: scored.componentScores.vwapTrendAlignment.toString(),
      scoreOptionsFutures: scored.componentScores.optionsFuturesConfirmation.toString(),
      scoreLiquidityExecution: scored.componentScores.liquidityExecution.toString(),
      scoreRrQuality: scored.componentScores.rrQuality.toString(),
      measuredInputs: input.measuredInputs,
      status: scored.status,
      rejectionReason: scored.rejectionReason ?? null,
      signalTimestamp: now,
      expiryTimestamp,
      regime: input.regime ?? null,
      dhanOrderId: null,
    });

    const saved = await this.signalsRepo.save(entity);

    return { ...scored, signalId: saved.id };
  }

  // ─── Expiry tracking ─────────────────────────────────────────────────────────

  /**
   * Scan the `Signals` table for all `active` and `accepted` signals whose
   * `expiry_timestamp` is in the past, and mark them as `"expired"` (Req 8.7).
   *
   * Called automatically every 10 seconds via the background interval started
   * in `onModuleInit()`, but also publicly callable for testing or on-demand use.
   *
   * @returns The number of signals that were marked as expired.
   */
  async expireStaleSignals(): Promise<number> {
    const now = new Date();

    // Find active/accepted signals whose expiry time has passed.
    const stale = await this.signalsRepo.find({
      where: [
        { status: 'active', expiryTimestamp: LessThan(now) },
        { status: 'accepted', expiryTimestamp: LessThan(now) },
      ],
    });

    if (stale.length === 0) {
      return 0;
    }

    // Update each expired signal individually to maintain an audit trail.
    for (const signal of stale) {
      await this.signalsRepo.update(signal.id, {
        status: 'expired',
        rejectionReason: 'signal expired without action',
      });
    }

    this.logger.log(`Marked ${stale.length} signal(s) as expired`);
    return stale.length;
  }

  // ─── Price deviation revalidation ────────────────────────────────────────────

  /**
   * Revalidate an active signal when its entry price has drifted away from the
   * current market price by more than the strategy-configured threshold (Req 8.6).
   *
   * ### Logic
   * 1. Load the signal from the DB (with its parent strategy loaded via relation).
   * 2. If the signal is not `active`, or has already expired, return `null`.
   * 3. Compute the fractional deviation:
   *    `deviation = |currentMarketPrice − signal.entryPrice| / signal.entryPrice`
   * 4. If `deviation ≤ strategy.priceDeviationThreshold`, return `null` —
   *    no recomputation is needed.
   * 5. Otherwise re-score the signal using the original component scores but
   *    with the new entry price (which may change the R:R ratio and therefore
   *    the R:R Quality component).
   * 6. Persist the updated `entryPrice`, `compositeScore`, `scoreRrQuality`,
   *    `status`, and `rejectionReason` back to the DB.
   * 7. Return the updated `PersistedScoredSignal`.
   *
   * @param signalId          - UUID of the signal to check.
   * @param currentMarketPrice - Current live market price for the signal's instrument.
   * @returns Updated `PersistedScoredSignal` if recomputation was triggered; `null` otherwise.
   */
  async revalidateIfPriceDeviated(
    signalId: string,
    currentMarketPrice: number,
  ): Promise<PersistedScoredSignal | null> {
    // Load the signal with its strategy relation so we can read strategy config.
    const signal = await this.signalsRepo.findOne({
      where: { id: signalId },
      relations: ['strategy'],
    });

    // Only revalidate active signals.
    if (!signal || signal.status !== 'active') {
      return null;
    }

    // Opportunistic expiry check — the background interval may not have run yet.
    if (signal.expiryTimestamp && signal.expiryTimestamp < new Date()) {
      await this.signalsRepo.update(signal.id, {
        status: 'expired',
        rejectionReason: 'signal expired without action',
      });
      return null;
    }

    const originalEntryPrice = parseFloat(signal.entryPrice);
    const deviation = Math.abs(currentMarketPrice - originalEntryPrice) / originalEntryPrice;

    // Determine the threshold from the strategy config (fall back to default).
    const rawThreshold = signal.strategy?.priceDeviationThreshold;
    const threshold =
      rawThreshold !== null && rawThreshold !== undefined
        ? parseFloat(rawThreshold)
        : DEFAULT_PRICE_DEVIATION_THRESHOLD;

    if (deviation <= threshold) {
      return null; // Deviation within acceptable bounds — no recomputation needed.
    }

    // Recompute R:R with the current market price as the new entry.
    const newRrRatio = this.computeRrRatio(
      currentMarketPrice.toString(),
      signal.stopLossPrice,
      signal.targetPrice,
    );

    const minRrRatio = signal.strategy?.minRrRatio ? parseFloat(signal.strategy.minRrRatio) : 1.0;

    // Reconstruct component scores from the values stored in the DB
    // (NUMERIC columns returned as strings by the pg driver).
    const componentScores: SignalComponentScores = {
      regimeAlignment: parseFloat(signal.scoreRegimeAlignment),
      priceStructure: parseFloat(signal.scorePriceStructure),
      volumeConfirmation: parseFloat(signal.scoreVolumeConfirmation),
      momentum: parseFloat(signal.scoreMomentum),
      vwapTrendAlignment: parseFloat(signal.scoreVwapTrend),
      optionsFuturesConfirmation: parseFloat(signal.scoreOptionsFutures),
      liquidityExecution: parseFloat(signal.scoreLiquidityExecution),
      rrQuality: parseFloat(signal.scoreRrQuality),
    };

    // Re-run the pure scoring logic with the updated price context.
    const revalidated = this.scoreSignal({
      strategyId: signal.strategyId,
      instrumentId: signal.instrumentId,
      engine: signal.engine,
      direction: signal.direction,
      entryPrice: currentMarketPrice.toString(),
      stopLossPrice: signal.stopLossPrice,
      targetPrice: signal.targetPrice,
      positionSize: signal.positionSize,
      componentScores,
      measuredInputs: signal.measuredInputs,
      minRrRatio,
      currentRrRatio: newRrRatio,
      regime: signal.regime ?? undefined,
    });

    // Persist only the fields that changed.
    await this.signalsRepo.update(signal.id, {
      entryPrice: currentMarketPrice.toString(),
      compositeScore: revalidated.compositeScore.toString(),
      scoreRrQuality: revalidated.componentScores.rrQuality.toString(),
      status: revalidated.status,
      rejectionReason: revalidated.rejectionReason ?? null,
    });

    return { ...revalidated, signalId: signal.id };
  }
}
