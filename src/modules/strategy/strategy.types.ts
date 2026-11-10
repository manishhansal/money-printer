/**
 * strategy.types.ts
 *
 * Shared types, constants, and configuration definitions for the StrategyModule.
 *
 * The 8 strategy configurations (A–H) are the canonical source of truth for
 * regime compatibility, R:R requirements, concurrency limits, and opening-phase
 * eligibility.  They are written to the `strategies` table on startup via
 * `StrategyService.initializeStrategies()`.
 *
 * Requirements: 6.1, 6.2
 */

import { StrategyCode } from '../../database/entities/strategies.entity';
import { MarketRegime } from '../market-regime/market-regime.types';
import { SignalComponentScores } from '../signal-scoring/signal-scoring.types';

// ─────────────────────────────────────────────────────────────────────────────
// Strategy seed data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape of one strategy's immutable seed configuration.
 *
 * All runtime-mutable fields (isActive, isSuspended, minPerformanceThreshold,
 * currentOosWinRate, version) are managed separately; they are NOT part of the
 * seed record so that upsert operations never overwrite operator adjustments.
 */
export interface StrategyConfig {
  /** Single-letter strategy code — unique, immutable after insert. */
  code: StrategyCode;

  /** Full human-readable strategy name. */
  name: string;

  /**
   * Market regimes in which this strategy is permitted to generate signals.
   * Values must be valid `MarketRegime` enum strings.
   * Requirement 6.2.
   */
  compatibleRegimes: MarketRegime[];

  /**
   * Minimum required Risk:Reward ratio (1.0 – 10.0).
   * Stored as a NUMERIC string to match the entity column type.
   * Requirement 6.2.
   */
  minRrRatio: string;

  /**
   * Maximum number of simultaneously open positions for this strategy (1 – 20).
   * Requirement 6.2.
   */
  maxConcurrentPositions: number;

  /**
   * When true the strategy may generate signals during the 09:15–09:20
   * opening volatility phase.
   * Requirement 6.2.
   */
  openingPhaseCompatible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical 8-strategy seed table  (Requirements 6.1, 6.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seed configurations for all 8 strategies.
 *
 * Requirements:
 *   6.1 — exactly 8 strategies: A–H with their defined names.
 *   6.2 — each has compatible_regimes, min_rr_ratio (1.0–10.0),
 *          max_concurrent_positions (1–20), opening_phase_compatible.
 */
export const STRATEGY_CONFIGS: readonly StrategyConfig[] = [
  {
    code: 'A',
    name: 'Opening Range Breakout',
    compatibleRegimes: [MarketRegime.BREAKOUT, MarketRegime.STRONG_BULL, MarketRegime.STRONG_BEAR],
    minRrRatio: '1.5',
    maxConcurrentPositions: 3,
    openingPhaseCompatible: true,
  },
  {
    code: 'B',
    name: 'VWAP Reclaim and Rejection',
    compatibleRegimes: [MarketRegime.WEAK_BULL, MarketRegime.WEAK_BEAR, MarketRegime.REVERSAL],
    minRrRatio: '1.5',
    maxConcurrentPositions: 3,
    openingPhaseCompatible: false,
  },
  {
    code: 'C',
    name: 'Momentum Expansion',
    compatibleRegimes: [MarketRegime.STRONG_BULL, MarketRegime.STRONG_BEAR, MarketRegime.BREAKOUT],
    minRrRatio: '2.0',
    maxConcurrentPositions: 2,
    openingPhaseCompatible: false,
  },
  {
    code: 'D',
    name: 'Breakout and Retest',
    compatibleRegimes: [MarketRegime.BREAKOUT, MarketRegime.STRONG_BULL, MarketRegime.STRONG_BEAR],
    minRrRatio: '2.0',
    maxConcurrentPositions: 2,
    openingPhaseCompatible: false,
  },
  {
    code: 'E',
    name: 'Trend Continuation',
    compatibleRegimes: [
      MarketRegime.STRONG_BULL,
      MarketRegime.WEAK_BULL,
      MarketRegime.STRONG_BEAR,
      MarketRegime.WEAK_BEAR,
    ],
    minRrRatio: '1.5',
    maxConcurrentPositions: 3,
    openingPhaseCompatible: false,
  },
  {
    code: 'F',
    name: 'Liquidity Sweep and Reversal',
    compatibleRegimes: [MarketRegime.REVERSAL, MarketRegime.UNSTABLE],
    minRrRatio: '2.0',
    maxConcurrentPositions: 2,
    openingPhaseCompatible: false,
  },
  {
    code: 'G',
    name: 'Fair Value Gap and Market Structure',
    compatibleRegimes: [
      MarketRegime.STRONG_BULL,
      MarketRegime.STRONG_BEAR,
      MarketRegime.WEAK_BULL,
      MarketRegime.WEAK_BEAR,
    ],
    minRrRatio: '2.0',
    maxConcurrentPositions: 2,
    openingPhaseCompatible: false,
  },
  {
    code: 'H',
    name: 'Options Flow Intelligence',
    compatibleRegimes: [
      MarketRegime.STRONG_BULL,
      MarketRegime.STRONG_BEAR,
      MarketRegime.BREAKOUT,
      MarketRegime.HIGH_VOL,
    ],
    minRrRatio: '1.5',
    maxConcurrentPositions: 3,
    openingPhaseCompatible: false,
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// NestJS event constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NestJS EventEmitter event emitted when a strategy is auto-suspended by the
 * Adaptive StrategyEngine due to its OOS win rate falling below the configured
 * minimum performance threshold.
 *
 * Consumers: NotificationService (Requirement 6.8).
 */
export const STRATEGY_DEGRADATION_EVENT = 'strategy.degradation';

/** Payload for STRATEGY_DEGRADATION_EVENT. */
export interface StrategyDegradationPayload {
  /** Code of the suspended strategy ('A'–'H'). */
  strategyCode: StrategyCode;
  /** Name of the suspended strategy. */
  strategyName: string;
  /** Current OOS win-rate that triggered the suspension (0–100). */
  currentOosWinRate: number;
  /** The configured threshold that was not met (0–100). */
  minPerformanceThreshold: number;
  /** UTC timestamp of the suspension. */
  suspendedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequential gate evaluation types  (Requirements 6.3, 6.4, 6.5, 6.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All data the StrategyEngine needs to run the 5-gate sequential evaluation
 * for one instrument across all active, non-suspended strategies.
 *
 * The caller (e.g. StrategyEngineOrchestrator) pre-computes the per-component
 * scores and entry-condition result via TechnicalAnalysis / OptionsIntelligence
 * and hands them to `StrategyService.evaluateSignalCandidate()`.
 *
 * Requirements: 6.3, 6.4, 6.5, 6.6
 */
export interface SignalCandidateInput {
  /** UUID of the instrument being evaluated. */
  instrumentId: string;

  /**
   * Current market regime code.
   * `null` means regime data is unavailable — triggers Gate 1 short-circuit
   * (Requirement 6.6).
   */
  currentRegime: string | null;

  /**
   * True during the 09:15–09:20 Opening Volatility session phase.
   * When true, only strategies with `openingPhaseCompatible = true` may pass
   * Gate 2 (Requirement 6.2 / SessionManager 17.5).
   */
  isOpeningPhase: boolean;

  /** Trading engine context — 'LIVE' or 'PAPER'. */
  engine: 'LIVE' | 'PAPER';

  /** Trade direction. */
  direction: 'BUY' | 'SELL';

  /** Proposed entry price as a numeric string (INR). */
  entryPrice: string;

  /** Stop-loss price as a numeric string (INR). */
  stopLossPrice: string;

  /** Target price as a numeric string (INR). */
  targetPrice: string;

  /** Proposed position size in lots. */
  positionSize: number;

  /**
   * Pre-computed per-component scores provided by the calling module
   * (TechnicalAnalysis / OptionsIntelligence / StrategyOrchestrator).
   * Used by Gate 5 to build the SignalInput forwarded to SignalScoringModule.
   */
  componentScores: SignalComponentScores;

  /** Raw measured input values used to derive each component score (JSONB). */
  measuredInputs: Record<string, unknown>;

  /**
   * Whether the strategy-specific entry conditions are satisfied for this
   * candidate (Gate 3).
   *
   * The caller is responsible for evaluating these conditions via
   * TechnicalAnalysis / OptionsIntelligence before invoking
   * `evaluateSignalCandidate`.
   */
  entryConditionsMet: boolean;

  /**
   * Optional human-readable reason when `entryConditionsMet` is false.
   * Defaults to `"entry conditions not met"` if omitted.
   */
  entryConditionsFailReason?: string;
}

/**
 * NestJS EventEmitter event emitted for every signal candidate that passes all
 * 5 evaluation gates.  The SignalScoringModule listens on this event and runs
 * the composite scoring + accept/reject decision.
 *
 * Requirements: 6.5, 8.1
 */
export const SIGNAL_CANDIDATE_EVENT = 'strategy.signal.candidate';

/**
 * Payload for `SIGNAL_CANDIDATE_EVENT`.
 *
 * Contains everything SignalScoringModule needs to call
 * `SignalScoringService.scoreSignal()` and persist the resulting `Signals`
 * record, plus the `evaluationId` so it can back-link the `SignalEvaluations`
 * row once the signal is persisted.
 */
export interface SignalCandidateEventPayload {
  /** UUID of the strategy that passed all gates. */
  strategyId: string;
  /** UUID of the `SignalEvaluations` row created for this gate-5 event. */
  evaluationId: string;
  /** UUID of the instrument being traded. */
  instrumentId: string;
  /** Trading engine context. */
  engine: 'LIVE' | 'PAPER';
  /** Trade direction. */
  direction: 'BUY' | 'SELL';
  /** Proposed entry price as numeric string (INR). */
  entryPrice: string;
  /** Stop-loss price as numeric string (INR). */
  stopLossPrice: string;
  /** Target price as numeric string (INR). */
  targetPrice: string;
  /** Proposed position size in lots. */
  positionSize: number;
  /** Per-component scores forwarded to SignalScorer. */
  componentScores: SignalComponentScores;
  /** Raw measured inputs forwarded to SignalScorer. */
  measuredInputs: Record<string, unknown>;
  /** Computed R:R ratio for this signal (reward ÷ risk). */
  currentRrRatio: number;
  /** Minimum required R:R for the originating strategy (from `strategy.minRrRatio`). */
  minRrRatio: number;
  /** Market regime active at evaluation time. */
  regime: string;
}
