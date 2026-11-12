/**
 * target-and-runner.service.ts
 *
 * TargetAndRunnerService — orchestrates the transition from initial-target
 * capture to intelligent runner management.
 *
 * MoneyPrinter trading philosophy:
 *   "Capture the initial target. If the market confirms continuation, keep
 *    the profitable position running with intelligent trailing."
 *
 * Responsibilities:
 *  1. Evaluate whether Target 1 has been reached for a given position.
 *  2. On Target 1: assess continuation conditions using GreedyTrailService.
 *  3. On continuation confirmed: activate RUNNER mode with selected trailing mechanism.
 *  4. On continuation denied: recommend FULL_EXIT.
 *  5. Enforce whole-lot-aware partial exit (never split a single lot).
 *  6. Provide structured trade phase labels for dashboard display.
 *
 * Integration:
 *  - GreedyTrailService: post-target continuation decision + mechanism selection.
 *  - TrailingStopService: trailing stop level computation (called by upstream).
 *  - PositionMonitoringService: calls evaluatePosition() on each price tick.
 *
 * Requirements: Phase 7 — Target and Runner Engine
 */

import { Injectable, Logger } from '@nestjs/common';
import { GreedyTrailService, GreedyTrailInput, GreedyTrailDecision } from './greedy-trail.service';
import { TrailingStopMechanism } from '../trailing-stop/trailing-stop.types';

// ─────────────────────────────────────────────────────────────────────────────
// Trade phase labels
// ─────────────────────────────────────────────────────────────────────────────

export type TradePhase =
  | 'ENTRY' // Position open, monitoring for Target 1
  | 'TARGET1_REACHED' // Target 1 hit — evaluating continuation
  | 'RUNNER' // Runner mode — intelligent trailing active
  | 'BREAK_EVEN' // SL moved to entry — risk-free runner
  | 'FULL_EXIT' // Recommend closing the entire remaining position
  | 'PARTIAL_EXIT'; // Recommend exiting a portion (lot-aware)

// ─────────────────────────────────────────────────────────────────────────────
// Input / output types
// ─────────────────────────────────────────────────────────────────────────────

export interface PositionState {
  /** DB UUID of the position. */
  positionId: string;
  /** Direction of the position. */
  direction: 'LONG' | 'SHORT';
  /** Entry price (INR). */
  entryPrice: string;
  /** Current stop-loss price (INR). */
  currentStopLoss: string;
  /** Target 1 price (INR). */
  target1Price: string;
  /** Total quantity of the position in UNITS. */
  quantityUnits: number;
  /** Contract lot size (from instruments table). */
  lotSize: number;
  /** Instrument ID for Redis market-snapshot lookup. */
  instrumentId: string;
  /** Volume at entry time (for GreedyTrailService volume condition). */
  entryVolume: number;
  /** ATR at entry time. */
  atr: number;
  /** Current trade phase (from last evaluation). */
  currentPhase: TradePhase;
}

export interface RunnerEvaluation {
  /** Recommended action for this position. */
  action: 'HOLD' | 'PARTIAL_EXIT' | 'FULL_EXIT' | 'ACTIVATE_RUNNER';
  /** Updated trade phase. */
  newPhase: TradePhase;
  /** Number of UNITS to exit (always a multiple of lotSize). */
  exitUnits?: number;
  /** Number of LOTS to exit (exitUnits / lotSize). */
  exitLots?: number;
  /** Trailing mechanism to activate when action = ACTIVATE_RUNNER. */
  trailingMechanism?: TrailingStopMechanism;
  /** New stop-loss level after action. */
  newStopLoss?: string;
  /** Human-readable explanation. */
  reason: string;
  /** GreedyTrail decision (populated after Target 1 is reached). */
  greedyDecision?: GreedyTrailDecision;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class TargetAndRunnerService {
  private readonly logger = new Logger(TargetAndRunnerService.name);

  constructor(private readonly greedyTrailService: GreedyTrailService) {}

  /**
   * Evaluate a position on a price tick and determine the recommended action.
   *
   * Called by PositionMonitoringService on every significant price change.
   *
   * Phase transitions:
   *   ENTRY → TARGET1_REACHED  when currentPrice reaches target1Price
   *   TARGET1_REACHED → RUNNER when greedy conditions are met
   *   TARGET1_REACHED → FULL_EXIT when greedy conditions are NOT met
   *   RUNNER  → FULL_EXIT when trailing SL is hit
   *
   * @param position    Current position state.
   * @param currentPrice Current LTP of the instrument.
   */
  async evaluatePosition(position: PositionState, currentPrice: number): Promise<RunnerEvaluation> {
    const {
      direction,
      entryPrice: _entryPrice,
      target1Price,
      currentStopLoss,
      currentPhase,
    } = position;
    const target1Num = parseFloat(target1Price);
    const slNum = parseFloat(currentStopLoss);

    // ── ENTRY phase: watching for Target 1 ───────────────────────────────────
    if (currentPhase === 'ENTRY') {
      const target1Hit =
        direction === 'LONG' ? currentPrice >= target1Num : currentPrice <= target1Num;

      if (!target1Hit) {
        // Check SL hit
        const slHit = direction === 'LONG' ? currentPrice <= slNum : currentPrice >= slNum;
        if (slHit) {
          return {
            action: 'FULL_EXIT',
            newPhase: 'FULL_EXIT',
            exitUnits: position.quantityUnits,
            exitLots: Math.floor(position.quantityUnits / position.lotSize),
            reason: `Stop-loss hit at ${currentPrice.toFixed(2)}`,
          };
        }
        return { action: 'HOLD', newPhase: 'ENTRY', reason: 'Monitoring for Target 1' };
      }

      // Target 1 hit — transition phase and evaluate continuation.
      return this.evaluateTarget1(position, currentPrice);
    }

    // ── TARGET1_REACHED: re-evaluate if still at this phase ──────────────────
    if (currentPhase === 'TARGET1_REACHED') {
      return this.evaluateTarget1(position, currentPrice);
    }

    // ── RUNNER phase: check trailing SL ──────────────────────────────────────
    if (currentPhase === 'RUNNER' || currentPhase === 'BREAK_EVEN') {
      const slHit = direction === 'LONG' ? currentPrice <= slNum : currentPrice >= slNum;
      if (slHit) {
        return {
          action: 'FULL_EXIT',
          newPhase: 'FULL_EXIT',
          exitUnits: position.quantityUnits,
          exitLots: Math.floor(position.quantityUnits / position.lotSize),
          reason: `Runner trailing SL hit at ${currentPrice.toFixed(2)}`,
        };
      }
      return {
        action: 'HOLD',
        newPhase: currentPhase,
        reason: 'Runner active — monitoring trailing SL',
      };
    }

    // Already in terminal phase
    return { action: 'HOLD', newPhase: currentPhase, reason: 'Position in terminal phase' };
  }

  /**
   * Evaluate continuation at Target 1.
   * Uses GreedyTrailService for the 3-condition decision.
   */
  private async evaluateTarget1(
    position: PositionState,
    currentPrice: number,
  ): Promise<RunnerEvaluation> {
    const { direction, entryPrice, atr, instrumentId, entryVolume, quantityUnits, lotSize } =
      position;

    // Build input for GreedyTrailService
    const greedyInput: GreedyTrailInput = {
      currentPrice,
      direction,
      entryPrice,
      instrumentId,
      entryVolume,
      atr,
    };

    let greedyDecision: GreedyTrailDecision;
    try {
      greedyDecision = await this.greedyTrailService.decide(greedyInput);
    } catch (err) {
      this.logger.warn(
        `[TargetAndRunner] GreedyTrailService failed for ${position.positionId}: ` +
          `${(err as Error).message}. Defaulting to FULL_EXIT.`,
      );
      return {
        action: 'FULL_EXIT',
        newPhase: 'FULL_EXIT',
        exitUnits: quantityUnits,
        exitLots: Math.floor(quantityUnits / lotSize),
        reason: 'Could not evaluate continuation conditions — defaulting to full exit',
      };
    }

    if (!greedyDecision.shouldTrail) {
      // Conditions not met → take full profit
      this.logger.log(
        `[TargetAndRunner] Position ${position.positionId}: Target 1 hit, ` +
          `continuation denied (${greedyDecision.passedConditions}/3 conditions met). ` +
          `Recommending FULL_EXIT.`,
      );
      return {
        action: 'FULL_EXIT',
        newPhase: 'FULL_EXIT',
        exitUnits: quantityUnits,
        exitLots: Math.floor(quantityUnits / lotSize),
        reason: `Target 1 reached, continuation denied: ${greedyDecision.reason}`,
        greedyDecision,
      };
    }

    // Continuation confirmed → partial exit (book first_target_fraction) + activate runner
    const fractionToBook = this.greedyTrailService.firstTargetFraction;

    // Compute whole-lot partial exit (never split a lot)
    const totalLots = Math.floor(quantityUnits / lotSize);
    const lotsToExit = Math.max(0, Math.floor(totalLots * fractionToBook));
    const unitsToExit = lotsToExit * lotSize;
    const remainingUnits = quantityUnits - unitsToExit;

    if (remainingUnits === 0 || lotsToExit === 0) {
      // Only 1 lot — can't do partial exit, take full profit
      return {
        action: 'FULL_EXIT',
        newPhase: 'FULL_EXIT',
        exitUnits: quantityUnits,
        exitLots: totalLots,
        reason: 'Target 1 reached — single lot, taking full profit',
        greedyDecision,
      };
    }

    // Move SL to entry (break-even) for the runner
    const newStopLoss = parseFloat(entryPrice).toFixed(2);

    this.logger.log(
      `[TargetAndRunner] Position ${position.positionId}: Target 1 hit, ` +
        `continuation confirmed (${greedyDecision.passedConditions}/3). ` +
        `Partial exit: ${lotsToExit} lots (${unitsToExit} units). ` +
        `Runner: ${remainingUnits} units @ ${greedyDecision.mechanism}. ` +
        `New SL: ${newStopLoss} (break-even).`,
    );

    return {
      action: 'ACTIVATE_RUNNER',
      newPhase: 'RUNNER',
      exitUnits: unitsToExit,
      exitLots: lotsToExit,
      trailingMechanism: greedyDecision.mechanism,
      newStopLoss,
      reason:
        `Target 1 reached. Booking ${lotsToExit} lots. Runner: ${remainingUnits} units ` +
        `with ${greedyDecision.mechanism ?? 'trailing'} mechanism.`,
      greedyDecision,
    };
  }
}
