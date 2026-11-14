/**
 * strategy.service.ts
 *
 * StrategyService — manages the 8 trading strategy configurations (A–H) and
 * exposes query helpers used by the SignalScoringModule, RiskEngine, and the
 * Adaptive StrategyEngine.
 *
 * Responsibilities:
 *  1. Seed / upsert all 8 strategy rows into the `strategies` table on module
 *     init so that the rest of the system always has a valid configuration to
 *     query (Requirement 6.1, 6.2).
 *  2. Provide read-only helpers that downstream modules use at evaluation time:
 *       - getActiveStrategies()       — non-suspended, active strategies.
 *       - getStrategyByCode()         — fast single-strategy lookup.
 *       - getCompatibleStrategies()   — regime + opening-phase filtered list.
 *  3. Run the 5-gate sequential signal-candidate evaluation for every active
 *     strategy, writing a `SignalEvaluations` audit record for each outcome
 *     and emitting a `SIGNAL_CANDIDATE_EVENT` for every candidate that passes
 *     all gates (Requirements 6.3, 6.4, 6.5, 6.6).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 20.2
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Strategies } from '../../database/entities/strategies.entity';
import { SignalEvaluations } from '../../database/entities/signal-evaluations.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';
import {
  STRATEGY_CONFIGS,
  SignalCandidateInput,
  SIGNAL_CANDIDATE_EVENT,
  SignalCandidateEventPayload,
  STRATEGY_DEGRADATION_EVENT,
  StrategyDegradationPayload,
} from './strategy.types';

@Injectable()
export class StrategyService implements OnModuleInit {
  private readonly logger = new Logger(StrategyService.name);

  constructor(
    @InjectRepository(Strategies)
    private readonly strategiesRepo: Repository<Strategies>,
    @InjectRepository(SignalEvaluations)
    private readonly signalEvaluationsRepo: Repository<SignalEvaluations>,
    @InjectRepository(StrategyPerformance)
    private readonly strategyPerformanceRepo: Repository<StrategyPerformance>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Called automatically by NestJS when the module is initialised.
   *
   * Delegates to `initializeStrategies()` so the seed logic is independently
   * callable in tests.
   */
  async onModuleInit(): Promise<void> {
    await this.initializeStrategies();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Seed / upsert
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Upserts all 8 strategy configurations into the `strategies` table.
   *
   * On conflict for the unique `code` column the row is updated with the
   * latest configuration values.  Runtime-managed columns (isActive,
   * isSuspended, minPerformanceThreshold, currentOosWinRate, version) are
   * NOT overwritten so that operator adjustments survive redeploys.
   *
   * Requirements: 6.1, 6.2
   */
  async initializeStrategies(): Promise<void> {
    this.logger.log('[Strategy] Initialising strategy configurations…');

    for (const config of STRATEGY_CONFIGS) {
      try {
        await this.strategiesRepo
          .createQueryBuilder()
          .insert()
          .into(Strategies)
          .values({
            code: config.code,
            name: config.name,
            compatibleRegimes: config.compatibleRegimes,
            minRrRatio: config.minRrRatio,
            maxConcurrentPositions: config.maxConcurrentPositions,
            openingPhaseCompatible: config.openingPhaseCompatible,
            // Runtime defaults — only applied on first insert.
            isActive: true,
            isSuspended: false,
            minPerformanceThreshold: null,
            currentOosWinRate: null,
            version: 1,
          })
          .orUpdate(
            // Columns to overwrite on conflict — configuration fields only.
            [
              'name',
              'compatible_regimes',
              'min_rr_ratio',
              'max_concurrent_positions',
              'opening_phase_compatible',
            ],
            // Conflict target — the unique code column.
            ['code'],
          )
          .execute();
      } catch (err) {
        this.logger.error(
          `[Strategy] Failed to upsert strategy '${config.code}' (${config.name}): ` +
            `${(err as Error).message}`,
        );
        // Continue with the remaining strategies — a partial initialisation is
        // better than aborting the entire module startup.
      }
    }

    const count = await this.strategiesRepo.count();
    this.logger.log(`[Strategy] Strategy table now has ${count} row(s).`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns all strategies that are active (`isActive = true`) and not
   * suspended (`isSuspended = false`).
   *
   * Used by the StrategyEngine evaluation loop to determine the candidate set
   * before applying regime and other filters.
   *
   * Requirements: 6.1
   */
  async getActiveStrategies(): Promise<Strategies[]> {
    return this.strategiesRepo.find({
      where: { isActive: true, isSuspended: false },
      order: { code: 'ASC' },
    });
  }

  /**
   * Returns the strategy with the given single-letter code, or null if not
   * found.
   *
   * @param code  One of 'A'–'H' (case-sensitive).
   */
  async getStrategyByCode(code: string): Promise<Strategies | null> {
    return this.strategiesRepo.findOne({ where: { code: code as Strategies['code'] } });
  }

  /**
   * Returns active, non-suspended strategies that are compatible with the
   * given market regime and, when `isOpeningPhase` is true, that also have
   * `openingPhaseCompatible = true`.
   *
   * Algorithm:
   *   1. Load all active non-suspended strategies.
   *   2. Keep those whose `compatibleRegimes` TEXT[] includes `currentRegime`.
   *   3. If `isOpeningPhase` is true, further filter to only those with
   *      `openingPhaseCompatible = true`.
   *
   * Note: The PostgreSQL `@>` (array contains) operator would be more
   * efficient at scale, but filtering in-memory is acceptable here because the
   * strategies table has at most 8 rows and is already cached by the ORM
   * identity map.
   *
   * Requirements: 6.2, 6.3
   *
   * @param currentRegime   Current market regime code (e.g. 'STRONG_BULL').
   * @param isOpeningPhase  True during the 09:15–09:20 opening volatility window.
   */
  async getCompatibleStrategies(
    currentRegime: string,
    isOpeningPhase: boolean,
  ): Promise<Strategies[]> {
    const active = await this.getActiveStrategies();

    return active.filter((strategy) => {
      // Gate 1: regime compatibility
      if (!strategy.compatibleRegimes.includes(currentRegime)) {
        return false;
      }

      // Gate 2: opening-phase compatibility (only applied during opening phase)
      if (isOpeningPhase && !strategy.openingPhaseCompatible) {
        return false;
      }

      return true;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Sequential gate evaluation  (Requirements 6.3, 6.4, 6.5, 6.6)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs the 5-gate sequential evaluation for one signal candidate across all
   * active, non-suspended strategies.
   *
   * ### Gate sequence
   * ```
   * Gate 1 — Regime availability
   *   IF candidate.currentRegime is null
   *   THEN record "regime unavailable" for ALL active strategies and return.
   *
   * Gate 2 — Regime / session-phase compatibility   (per strategy)
   *   IF strategy.compatibleRegimes does NOT include currentRegime
   *   THEN record "incompatible regime" for this strategy and continue.
   *   IF isOpeningPhase AND strategy.openingPhaseCompatible is false
   *   THEN record "opening phase restriction" for this strategy and continue.
   *
   * Gate 3 — Entry conditions                        (per strategy)
   *   IF candidate.entryConditionsMet is false
   *   THEN record entryConditionsFailReason (or "entry conditions not met") and continue.
   *
   * Gate 4 — R:R ratio                               (per strategy)
   *   IF computed R:R < strategy.minRrRatio
   *   THEN record "r:r below minimum" for this strategy and continue.
   *
   * Gate 5 — Generate signal                         (per strategy)
   *   Record producedSignal=true (no skipReason).
   *   Emit SIGNAL_CANDIDATE_EVENT with full SignalCandidateEventPayload so
   *   the SignalScoringModule can score and persist the signal.
   * ```
   *
   * A `SignalEvaluations` row is written for EVERY strategy × gate
   * combination, regardless of outcome, to satisfy Requirement 6.5.
   *
   * Requirements: 6.3, 6.4, 6.5, 6.6
   *
   * @param candidate  Full signal candidate data (regime, prices, scores, etc.).
   */
  async evaluateSignalCandidate(candidate: SignalCandidateInput): Promise<void> {
    const evaluatedAt = new Date();
    const activeStrategies = await this.getActiveStrategies();

    // ── Gate 1: Regime availability ────────────────────────────────────────
    // Requirement 6.6: if regime is unavailable, skip ALL strategies.
    if (candidate.currentRegime === null) {
      this.logger.warn(
        `[StrategyEngine] Regime unavailable — recording for all ` +
          `${activeStrategies.length} active strategies on instrument ${candidate.instrumentId}`,
      );
      for (const strategy of activeStrategies) {
        await this.persistEvaluation(
          strategy,
          candidate.instrumentId,
          evaluatedAt,
          false,
          'regime unavailable',
          null,
        );
      }
      return;
    }

    // ── Gates 2–5: Per-strategy sequential evaluation ──────────────────────
    for (const strategy of activeStrategies) {
      // Gate 2a: Regime compatibility (Requirement 6.4)
      if (!strategy.compatibleRegimes.includes(candidate.currentRegime)) {
        this.logger.debug(
          `[StrategyEngine] Strategy ${strategy.code} skipped — incompatible regime ` +
            `(${candidate.currentRegime} not in [${strategy.compatibleRegimes.join(', ')}])`,
        );
        await this.persistEvaluation(
          strategy,
          candidate.instrumentId,
          evaluatedAt,
          false,
          'incompatible regime',
          candidate.currentRegime,
        );
        continue;
      }

      // Gate 2b: Opening-phase compatibility (Session Req 17.5)
      if (candidate.isOpeningPhase && !strategy.openingPhaseCompatible) {
        this.logger.debug(
          `[StrategyEngine] Strategy ${strategy.code} skipped — opening phase restriction`,
        );
        await this.persistEvaluation(
          strategy,
          candidate.instrumentId,
          evaluatedAt,
          false,
          'opening phase restriction',
          candidate.currentRegime,
        );
        continue;
      }

      // Gate 3: Entry conditions
      if (!candidate.entryConditionsMet) {
        const reason = candidate.entryConditionsFailReason ?? 'entry conditions not met';
        this.logger.debug(`[StrategyEngine] Strategy ${strategy.code} skipped — ${reason}`);
        await this.persistEvaluation(
          strategy,
          candidate.instrumentId,
          evaluatedAt,
          false,
          reason,
          candidate.currentRegime,
        );
        continue;
      }

      // Gate 4: R:R ratio check
      const rrRatio = this.computeRrRatio(
        candidate.entryPrice,
        candidate.stopLossPrice,
        candidate.targetPrice,
      );
      const minRrRatio = parseFloat(strategy.minRrRatio);

      if (rrRatio < minRrRatio) {
        this.logger.debug(
          `[StrategyEngine] Strategy ${strategy.code} skipped — R:R ${rrRatio.toFixed(2)} < ` +
            `minimum ${minRrRatio}`,
        );
        await this.persistEvaluation(
          strategy,
          candidate.instrumentId,
          evaluatedAt,
          false,
          'r:r below minimum',
          candidate.currentRegime,
        );
        continue;
      }

      // Gate 5: All gates passed — persist the evaluation and emit to SignalScoringModule
      this.logger.log(
        `[StrategyEngine] Strategy ${strategy.code} passed all gates for instrument ` +
          `${candidate.instrumentId} (R:R=${rrRatio.toFixed(2)}, regime=${candidate.currentRegime})`,
      );
      const evaluation = await this.persistEvaluation(
        strategy,
        candidate.instrumentId,
        evaluatedAt,
        true,
        null,
        candidate.currentRegime,
      );

      const payload: SignalCandidateEventPayload = {
        strategyId: strategy.id,
        evaluationId: evaluation.id,
        instrumentId: candidate.instrumentId,
        engine: candidate.engine,
        direction: candidate.direction,
        entryPrice: candidate.entryPrice,
        stopLossPrice: candidate.stopLossPrice,
        targetPrice: candidate.targetPrice,
        positionSize: candidate.positionSize,
        componentScores: candidate.componentScores,
        measuredInputs: candidate.measuredInputs,
        currentRrRatio: rrRatio,
        minRrRatio,
        regime: candidate.currentRegime,
      };

      this.eventEmitter.emit(SIGNAL_CANDIDATE_EVENT, payload);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persists a single `SignalEvaluations` audit record.
   *
   * On DB failure the error is logged and a minimal stub is returned so
   * the caller's loop can continue processing remaining strategies.
   *
   * Requirements: 6.5
   */
  private async persistEvaluation(
    strategy: Strategies,
    instrumentId: string,
    evaluatedAt: Date,
    producedSignal: boolean,
    skipReason: string | null,
    regimeAtEvaluation: string | null,
  ): Promise<SignalEvaluations> {
    try {
      const evaluation = this.signalEvaluationsRepo.create({
        strategy,
        instrumentId,
        evaluatedAt,
        producedSignal,
        skipReason,
        signal: null,
        regimeAtEvaluation,
      });
      return await this.signalEvaluationsRepo.save(evaluation);
    } catch (err) {
      this.logger.error(
        `[StrategyEngine] Failed to persist evaluation for strategy '${strategy.code}' ` +
          `instrument '${instrumentId}': ${(err as Error).message}`,
      );
      // Return a minimal stub so the outer loop does not crash.
      return {
        id: 'persist-error-stub',
        strategy,
        strategyId: strategy.id,
        instrumentId,
        evaluatedAt,
        producedSignal,
        skipReason,
        signal: null,
        signalId: null,
        regimeAtEvaluation,
      } as SignalEvaluations;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Adaptive StrategyEngine  (Requirements 6.7, 6.8, 20.2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes the out-of-sample win rate for the given strategy over the
   * trailing 20 `StrategyPerformance` records for the specified regime.
   *
   * ### Behaviour
   * 1. Fetches the 20 most-recent `StrategyPerformance` rows (by `trading_date`
   *    DESC) that match `strategyId` + `regime`.
   * 2. Aggregates `win_count` / `trades_count` across those rows into a single
   *    win-rate percentage (0–100, two decimal places).
   * 3. If data is available, updates `strategy.currentOosWinRate`.
   * 4. If `strategy.minPerformanceThreshold` is set AND the computed rate is
   *    below that threshold → sets `isSuspended = true`, emits
   *    `STRATEGY_DEGRADATION_EVENT`, and records rationale
   *    `"suspended: win rate below threshold"`.
   * 5. Otherwise records rationale `"performance within threshold"`.
   *
   * Re-enabling a suspended strategy requires an explicit user action via
   * `reenableStrategy()` — the system never auto-re-enables.
   *
   * Requirements: 6.7, 6.8
   *
   * @param strategyId  UUID of the strategy to evaluate.
   * @param regime      Current market regime code (e.g. 'STRONG_BULL').
   */
  async updateStrategyPerformanceMetrics(strategyId: string, regime: string): Promise<void> {
    const strategy = await this.strategiesRepo.findOne({ where: { id: strategyId } });
    if (!strategy) {
      this.logger.warn(
        `[AdaptiveEngine] Strategy with id '${strategyId}' not found — skipping metrics update`,
      );
      return;
    }

    // ── Compute OOS win rate from trailing 20 trading-day rows ──────────────
    const perfRows = await this.strategyPerformanceRepo.find({
      where: { strategy_id: strategyId, regime },
      order: { trading_date: 'DESC' },
      take: 20,
    });

    let oosWinRate: number | null = null;
    if (perfRows.length > 0) {
      const totalTrades = perfRows.reduce((sum, r) => sum + r.trades_count, 0);
      const totalWins = perfRows.reduce((sum, r) => sum + r.win_count, 0);
      oosWinRate =
        totalTrades > 0 ? parseFloat(((totalWins / totalTrades) * 100).toFixed(2)) : null;
    }

    // ── Update strategy and check suspension ────────────────────────────────
    if (oosWinRate !== null) {
      strategy.currentOosWinRate = oosWinRate.toFixed(2);
    }

    const threshold =
      strategy.minPerformanceThreshold !== null
        ? parseFloat(strategy.minPerformanceThreshold)
        : null;

    const shouldSuspend = threshold !== null && oosWinRate !== null && oosWinRate < threshold;

    if (shouldSuspend) {
      strategy.isSuspended = true;
    }

    // Persist strategy changes (win rate + possible suspension) in one write.
    if (oosWinRate !== null) {
      await this.strategiesRepo.save(strategy);
    }

    // ── Emit degradation alert ───────────────────────────────────────────────
    if (shouldSuspend) {
      const payload: StrategyDegradationPayload = {
        strategyCode: strategy.code,
        strategyName: strategy.name,
        currentOosWinRate: oosWinRate!,
        minPerformanceThreshold: threshold!,
        suspendedAt: new Date(),
      };
      this.eventEmitter.emit(STRATEGY_DEGRADATION_EVENT, payload);
      this.logger.warn(
        `[AdaptiveEngine] Strategy ${strategy.code} suspended — ` +
          `OOS win rate ${oosWinRate!.toFixed(2)}% < threshold ${threshold}%`,
      );
    }

    // ── Record StrategyPerformance audit entry ───────────────────────────────
    const rationale = shouldSuspend
      ? 'suspended: win rate below threshold'
      : 'performance within threshold';

    await this.persistStrategyPerformanceRecord(
      strategy.id,
      regime,
      new Date().toISOString().split('T')[0],
      oosWinRate,
      rationale,
    );
  }

  /**
   * Returns active, non-suspended strategies compatible with `regime` ranked
   * by `currentOosWinRate` DESC (strategies with no historical data are placed
   * last — they receive equal opportunity as "new" strategies).
   *
   * Records a `StrategyPerformance` entry for every strategy in the result
   * list, capturing its rank position and OOS win rate as the selection
   * rationale (Requirement 20.2).
   *
   * Requirements: 6.7, 20.2
   *
   * @param regime  Current market regime code.
   */
  async rankStrategiesByPerformance(regime: string): Promise<Strategies[]> {
    const compatible = await this.getCompatibleStrategies(regime, false);

    // Sort DESC by currentOosWinRate; null values go to the end of the list.
    const sorted = [...compatible].sort((a, b) => {
      const aRate = a.currentOosWinRate !== null ? parseFloat(a.currentOosWinRate) : null;
      const bRate = b.currentOosWinRate !== null ? parseFloat(b.currentOosWinRate) : null;

      if (aRate === null && bRate === null) return 0;
      if (aRate === null) return 1; // null → end
      if (bRate === null) return -1; // null → end
      return bRate - aRate; // higher OOS win rate first
    });

    const today = new Date().toISOString().split('T')[0];

    // Record a StrategyPerformance entry for each ranked strategy.
    for (let i = 0; i < sorted.length; i++) {
      const strategy = sorted[i];
      const rank = i + 1;
      const rateStr =
        strategy.currentOosWinRate !== null
          ? `${parseFloat(strategy.currentOosWinRate).toFixed(2)}%`
          : 'no data';
      const rationale = `rank ${rank}: OOS win rate ${rateStr} for regime ${regime}`;

      await this.persistStrategyPerformanceRecord(
        strategy.id,
        regime,
        today,
        strategy.currentOosWinRate !== null ? parseFloat(strategy.currentOosWinRate) : null,
        rationale,
      );
    }

    return sorted;
  }

  /**
   * Re-enables a strategy that was suspended by the Adaptive StrategyEngine.
   *
   * Re-enabling is an explicit user action — the system never auto-re-enables.
   * Sets `isSuspended = false` and records a `StrategyPerformance` audit entry
   * with rationale `"re-enabled by user action"`.
   *
   * @throws Error when no strategy with the given code exists.
   *
   * Requirements: 6.8
   *
   * @param strategyCode  Single-letter strategy code ('A'–'H').
   */
  async reenableStrategy(strategyCode: string): Promise<Strategies> {
    const strategy = await this.strategiesRepo.findOne({
      where: { code: strategyCode as Strategies['code'] },
    });

    if (!strategy) {
      throw new Error(`Strategy with code '${strategyCode}' not found`);
    }

    strategy.isSuspended = false;
    strategy.isActive = true; // restore active flag in case it was cleared while suspended
    await this.strategiesRepo.save(strategy);

    await this.persistStrategyPerformanceRecord(
      strategy.id,
      null,
      new Date().toISOString().split('T')[0],
      strategy.currentOosWinRate !== null ? parseFloat(strategy.currentOosWinRate) : null,
      're-enabled by user action',
    );

    this.logger.log(`[AdaptiveEngine] Strategy ${strategyCode} re-enabled by user action`);

    return strategy;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persists a single `StrategyPerformance` audit / rationale record.
   *
   * On DB failure the error is logged and a minimal stub is returned so the
   * calling method can continue without crashing.
   *
   * Requirements: 6.7, 6.8, 20.2
   */
  private async persistStrategyPerformanceRecord(
    strategyId: string,
    regime: string | null,
    tradingDate: string,
    oosWinRate: number | null,
    selectionRationale: string,
  ): Promise<StrategyPerformance> {
    try {
      const record = this.strategyPerformanceRepo.create({
        strategy_id: strategyId,
        engine: 'LIVE',
        regime,
        trading_date: tradingDate,
        trades_count: 0,
        win_count: 0,
        loss_count: 0,
        total_net_pnl: '0.00',
        selection_rationale: selectionRationale,
        oos_win_rate: oosWinRate !== null ? oosWinRate.toFixed(2) : null,
      });
      return await this.strategyPerformanceRepo.save(record);
    } catch (err) {
      this.logger.error(
        `[AdaptiveEngine] Failed to persist StrategyPerformance for strategy '${strategyId}': ` +
          `${(err as Error).message}`,
      );
      return {
        id: 'persist-error-stub',
        strategy_id: strategyId,
        engine: 'LIVE',
        regime,
        trading_date: tradingDate,
        trades_count: 0,
        win_count: 0,
        loss_count: 0,
        total_net_pnl: '0.00',
        selection_rationale: selectionRationale,
        oos_win_rate: oosWinRate !== null ? oosWinRate.toFixed(2) : null,
      } as StrategyPerformance;
    }
  }

  /**
   * Computes the Risk:Reward ratio from raw price strings.
   *
   * Formula (direction-agnostic):
   *   R:R = |target − entry| / |entry − stop|
   *
   * Returns `0` when `entry === stop` (zero risk — invalid signal).
   * The caller treats 0 as a Gate 4 fail.
   */
  private computeRrRatio(entryPrice: string, stopLossPrice: string, targetPrice: string): number {
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
}
