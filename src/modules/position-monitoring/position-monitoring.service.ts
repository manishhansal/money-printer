/**
 * position-monitoring.service.ts
 *
 * PositionMonitoringService — continuously tracks all open LIVE positions,
 * updating Maximum Favorable Excursion (MFE) and Maximum Adverse Excursion
 * (MAE) in memory, evaluating exit conditions on every market tick, and
 * feeding real-time unrealized P&L to the RiskEngine for EMERGENCY_HALT
 * threshold monitoring.
 *
 * Key responsibilities:
 *   1. On startup:  load all open LIVE positions; build the instrument →
 *      position tracking map; subscribe to `events:tick:{instrument_id}`
 *      Redis channels for every tracked instrument.
 *   2. Per tick:    compute unrealized P&L; update in-memory MFE/MAE caches
 *      (no DB write per tick); check SL-hit and target-hit exit conditions;
 *      emit POSITION_EXIT_EVENT on any breach; emit UNREALIZED_PNL_UPDATED_EVENT
 *      with the aggregate unrealized P&L across all tracked positions.
 *   3. Lifecycle:   expose addPosition / removePosition so other modules can
 *      register new positions without restarting.
 *
 * MFE / MAE semantics:
 *   MFE = maximum favorable excursion = highest unrealized P&L seen since entry.
 *   MAE = maximum adverse excursion   = most negative unrealized P&L seen since
 *         entry.
 *   Both are updated in memory only during tick processing.  They persist across
 *   service restarts via the positions.mfe / positions.mae DB columns (written
 *   periodically by a separate persistence task, out of scope here).
 *
 * Requirements: 7.4, 9.4, 12.2
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Position } from '../../database/entities/positions.entity';
import { RedisService } from '../redis/redis.service';
import {
  POSITION_EXIT_EVENT,
  UNREALIZED_PNL_UPDATED_EVENT,
  PositionExitReason,
  PositionExitSignal,
} from './position-monitoring.types';
import { GreedyTrailService } from './greedy-trail.service';
import { TargetAndRunnerService } from './target-and-runner.service';

/** Mechanism name used to flag a position for greedy partial-profit trailing. */
const PARTIAL_PROFIT_MECHANISM = 'PARTIAL_PROFIT';

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class PositionMonitoringService implements OnModuleInit {
  private readonly logger = new Logger(PositionMonitoringService.name);

  // ── Tracking maps ──────────────────────────────────────────────────────────

  /**
   * Primary tracking map.
   *
   * Key:   instrument_id (UUID string)
   * Value: Set of position IDs (UUID strings) that are open for that instrument
   *
   * Used to determine which Redis tick channels to subscribe to, and to quickly
   * identify which positions belong to a given instrument without a DB query.
   */
  private readonly instrumentToPositions = new Map<string, Set<string>>();

  /**
   * Reverse lookup: position_id → instrument_id.
   *
   * Enables O(1) lookup in removePosition without iterating the primary map.
   */
  private readonly positionToInstrument = new Map<string, string>();

  /**
   * Set of instrument IDs whose Redis tick channels we have already subscribed
   * to.  Guards against duplicate subscriptions across onModuleInit and
   * addPosition calls.
   */
  private readonly subscribedInstruments = new Set<string>();

  // ── In-memory P&L caches (no DB write per tick) ────────────────────────────

  /**
   * MFE cache: positionId → highest unrealized P&L seen since entry (₹).
   * Seeded from positions.mfe at startup; updated upward-only during tick processing.
   */
  private readonly mfeCache = new Map<string, number>();

  /**
   * MAE cache: positionId → most negative unrealized P&L seen since entry (₹).
   * Seeded from positions.mae at startup; updated downward-only during tick processing.
   */
  private readonly maeCache = new Map<string, number>();

  /**
   * Unrealized P&L cache: positionId → current unrealized P&L (₹).
   * Seeded from positions.unrealized_pnl at startup; recalculated on every tick.
   * Summed to produce the UNREALIZED_PNL_UPDATED_EVENT payload.
   */
  private readonly unrealizedPnlCache = new Map<string, number>();

  // ── Constructor ────────────────────────────────────────────────────────────

  constructor(
    @InjectRepository(Position)
    private readonly positionsRepo: Repository<Position>,
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
    private readonly greedyTrailService: GreedyTrailService,
    private readonly targetAndRunnerService: TargetAndRunnerService,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Load all open LIVE positions from the database, populate the in-memory
   * tracking and cache maps, and subscribe to tick channels for each tracked
   * instrument.
   *
   * Called automatically by NestJS when the module initialises.
   */
  async onModuleInit(): Promise<void> {
    const openPositions = await this.positionsRepo.find({
      where: { engine: 'LIVE', is_open: true },
    });

    for (const position of openPositions) {
      this.registerPositionInMaps(position.id, position.instrument_id);
      this.mfeCache.set(position.id, parseFloat(position.mfe));
      this.maeCache.set(position.id, parseFloat(position.mae));
      this.unrealizedPnlCache.set(position.id, parseFloat(position.unrealized_pnl));
    }

    // Subscribe to tick events for every instrument that has open positions.
    for (const instrumentId of this.instrumentToPositions.keys()) {
      await this.subscribeToInstrumentTicks(instrumentId);
    }

    this.logger.log(
      `PositionMonitoringService initialised: ` +
        `${openPositions.length} open LIVE position(s) across ` +
        `${this.instrumentToPositions.size} instrument(s).`,
    );
  }

  // ── Core tick handler ──────────────────────────────────────────────────────

  /**
   * Process a single market tick for the given instrument.
   *
   * For every open position on this instrument the method:
   *   1. Computes unrealized P&L from current market price.
   *   2. Updates the in-memory MFE (max) and MAE (min) caches.
   *   3. Checks SL-hit and target-hit exit conditions; emits
   *      POSITION_EXIT_EVENT if either is triggered (SL takes priority).
   *   4. After processing all positions, emits UNREALIZED_PNL_UPDATED_EVENT
   *      with the aggregated unrealized P&L across ALL tracked positions.
   *
   * No database writes are performed during tick processing.
   *
   * Returns immediately (no event emitted) if no open positions exist for the
   * instrument.
   *
   * @param instrumentId  UUID of the instrument that produced the tick.
   * @param currentPrice  Current market price in INR.
   *
   * Requirements: 7.4, 9.4, 12.2
   */
  async processTick(instrumentId: string, currentPrice: number): Promise<void> {
    const positions = await this.positionsRepo.find({
      where: { instrument_id: instrumentId, is_open: true },
    });

    if (positions.length === 0) {
      // Nothing to process — no events emitted for empty position list.
      return;
    }

    for (const position of positions) {
      const entryPrice = parseFloat(position.average_entry_price);
      const qty = position.quantity;

      // ── Unrealized P&L ───────────────────────────────────────────────────
      const unrealizedPnl =
        position.direction === 'LONG'
          ? (currentPrice - entryPrice) * qty
          : (entryPrice - currentPrice) * qty;

      // ── MFE update (highest unrealized P&L seen since entry) ─────────────
      const existingMfe = this.mfeCache.has(position.id)
        ? this.mfeCache.get(position.id)!
        : parseFloat(position.mfe);
      this.mfeCache.set(position.id, Math.max(existingMfe, unrealizedPnl));

      // ── MAE update (most negative unrealized P&L seen since entry) ───────
      const existingMae = this.maeCache.has(position.id)
        ? this.maeCache.get(position.id)!
        : parseFloat(position.mae);
      this.maeCache.set(position.id, Math.min(existingMae, unrealizedPnl));

      // ── Unrealized P&L cache update ───────────────────────────────────────
      this.unrealizedPnlCache.set(position.id, unrealizedPnl);

      // ── Exit condition: SL hit ────────────────────────────────────────────
      const currentSl = position.current_sl !== null ? parseFloat(position.current_sl) : null;

      if (currentSl !== null) {
        const slHit =
          position.direction === 'LONG' ? currentPrice <= currentSl : currentPrice >= currentSl;

        if (slHit) {
          this.eventEmitter.emit(POSITION_EXIT_EVENT, {
            positionId: position.id,
            reason: PositionExitReason.SL_HIT,
            currentPrice,
            timestamp: new Date(),
          } satisfies PositionExitSignal);

          // SL takes priority — skip target check for this position.
          continue;
        }
      }

      // ── Exit condition: target hit ────────────────────────────────────────
      const targetPrice = position.target_price !== null ? parseFloat(position.target_price) : null;

      if (targetPrice !== null) {
        const targetHit =
          position.direction === 'LONG' ? currentPrice >= targetPrice : currentPrice <= targetPrice;

        if (targetHit) {
          // ── Greedy partial-profit check ─────────────────────────────────
          // When trailing_stop_mechanism = PARTIAL_PROFIT, the first target is
          // treated as a scalp target. After booking 50% profit we evaluate
          // whether to trail the remainder or take full profit.
          if (position.trailing_stop_mechanism === PARTIAL_PROFIT_MECHANISM) {
            void this.handlePartialProfitTarget(position, currentPrice, instrumentId);
          } else {
            this.eventEmitter.emit(POSITION_EXIT_EVENT, {
              positionId: position.id,
              reason: PositionExitReason.TARGET_HIT,
              currentPrice,
              timestamp: new Date(),
            } satisfies PositionExitSignal);
          }
        }
      }
    }

    // ── Aggregate unrealized P&L feed to RiskEngine ───────────────────────
    // Sum across ALL tracked positions, not just those on this instrument.
    // This gives the DailyLossStateMachineService the total intraday exposure
    // needed for EMERGENCY_HALT threshold monitoring (Requirement 9.4).
    const totalUnrealizedPnl = Array.from(this.unrealizedPnlCache.values()).reduce(
      (sum, pnl) => sum + pnl,
      0,
    );

    this.eventEmitter.emit(UNREALIZED_PNL_UPDATED_EVENT, { totalUnrealizedPnl });
  }

  // ── Position lifecycle management ─────────────────────────────────────────

  /**
   * Register a new position for tick monitoring.
   *
   * Looks up the position in the database to retrieve its instrument_id, then
   * adds it to the tracking maps and subscribes to the instrument's tick
   * channel if not already subscribed.
   *
   * Called by ExecutionService (or LiveTradingModule) immediately after a new
   * position is opened so that monitoring begins without waiting for the next
   * onModuleInit cycle.
   *
   * @param positionId  UUID of the newly opened position.
   */
  async addPosition(positionId: string): Promise<void> {
    const position = await this.positionsRepo.findOne({ where: { id: positionId } });

    if (!position) {
      this.logger.warn(`addPosition: position ${positionId} not found in database — skipping.`);
      return;
    }

    this.registerPositionInMaps(positionId, position.instrument_id);

    // Seed caches only if this position is not already tracked (to avoid
    // overwriting live in-memory MFE/MAE values on duplicate calls).
    if (!this.mfeCache.has(positionId)) {
      this.mfeCache.set(positionId, parseFloat(position.mfe));
    }
    if (!this.maeCache.has(positionId)) {
      this.maeCache.set(positionId, parseFloat(position.mae));
    }
    if (!this.unrealizedPnlCache.has(positionId)) {
      this.unrealizedPnlCache.set(positionId, parseFloat(position.unrealized_pnl));
    }

    // Subscribe to tick events for this instrument if we haven't already.
    await this.subscribeToInstrumentTicks(position.instrument_id);

    this.logger.debug(
      `Position ${positionId} added to monitoring ` + `(instrument: ${position.instrument_id}).`,
    );
  }

  /**
   * Deregister a position from tick monitoring.
   *
   * Removes the position from all tracking and cache maps.  Should be called
   * by ExecutionService after a position is fully closed (is_open = false).
   *
   * @param positionId  UUID of the closed position.
   */
  removePosition(positionId: string): void {
    const instrumentId = this.positionToInstrument.get(positionId);

    if (!instrumentId) {
      this.logger.debug(`removePosition: position ${positionId} is not currently tracked — no-op.`);
      return;
    }

    // Remove from primary tracking map.
    const positionSet = this.instrumentToPositions.get(instrumentId);
    if (positionSet) {
      positionSet.delete(positionId);
      if (positionSet.size === 0) {
        this.instrumentToPositions.delete(instrumentId);
        // Note: we intentionally do NOT unsubscribe from the Redis channel here
        // because (a) ioredis doesn't support per-handler unsubscription, and
        // (b) if a new position on the same instrument opens shortly after,
        // the subscription will still be active.
      }
    }

    // Remove from reverse lookup and all caches.
    this.positionToInstrument.delete(positionId);
    this.mfeCache.delete(positionId);
    this.maeCache.delete(positionId);
    this.unrealizedPnlCache.delete(positionId);

    this.logger.debug(`Position ${positionId} removed from monitoring.`);
  }

  /**
   * Returns the array of all currently tracked position IDs.
   *
   * Useful for diagnostics, reconciliation, and integration tests.
   */
  getTrackedPositionIds(): string[] {
    return Array.from(this.positionToInstrument.keys());
  }

  /**
   * Evaluate a position's current phase and recommend an action using the
   * TargetAndRunnerService (lot-aware runner mode, break-even SL, etc.).
   *
   * Called externally (e.g. by a strategy layer or execution handler) when
   * a target is hit and the caller needs a lot-aware exit/runner recommendation.
   *
   * @param position    Current position state.
   * @param currentPrice Current LTP of the instrument.
   */
  async evaluateRunnerDecision(
    position: {
      positionId: string;
      direction: 'LONG' | 'SHORT';
      entryPrice: string;
      currentStopLoss: string;
      target1Price: string;
      quantityUnits: number;
      lotSize: number;
      instrumentId: string;
      entryVolume: number;
      atr: number;
      currentPhase: import('./target-and-runner.service').TradePhase;
    },
    currentPrice: number,
  ) {
    return this.targetAndRunnerService.evaluatePosition(position, currentPrice);
  }

  /**
   * Returns the in-memory MFE, MAE, and unrealized P&L for a tracked position.
   *
   * Returns null if the position is not currently tracked (not in the caches).
   * Primarily used for diagnostics and unit tests.
   *
   * @param positionId  UUID of the position to query.
   */
  getPositionStats(positionId: string): { mfe: number; mae: number; unrealizedPnl: number } | null {
    const mfe = this.mfeCache.get(positionId);
    const mae = this.maeCache.get(positionId);
    const unrealizedPnl = this.unrealizedPnlCache.get(positionId);

    if (mfe === undefined || mae === undefined || unrealizedPnl === undefined) {
      return null;
    }

    return { mfe, mae, unrealizedPnl };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Adds a position to both the primary map and the reverse lookup.
   * Idempotent — safe to call multiple times for the same positionId.
   */
  private registerPositionInMaps(positionId: string, instrumentId: string): void {
    if (!this.instrumentToPositions.has(instrumentId)) {
      this.instrumentToPositions.set(instrumentId, new Set());
    }
    this.instrumentToPositions.get(instrumentId)!.add(positionId);
    this.positionToInstrument.set(positionId, instrumentId);
  }

  /**
   * Subscribes the pub/sub client to `events:tick:{instrumentId}`.
   *
   * Each tick message is expected to be a JSON object with at least a `price`
   * field (number).  Any parse errors are logged at ERROR level but do not
   * crash the service.
   *
   * Guards against duplicate subscriptions via subscribedInstruments set.
   */
  private async subscribeToInstrumentTicks(instrumentId: string): Promise<void> {
    if (this.subscribedInstruments.has(instrumentId)) {
      return; // already subscribed — no duplicate subscription needed
    }

    const channel = `events:tick:${instrumentId}`;

    await this.redisService.subscribe(channel, (_chan: string, message: string) => {
      try {
        const payload = JSON.parse(message) as { price: number };
        void this.processTick(instrumentId, payload.price);
      } catch (err) {
        this.logger.error(
          `Failed to parse tick message on channel ${channel}: ` + `${(err as Error).message}`,
        );
      }
    });

    this.subscribedInstruments.add(instrumentId);
    this.logger.debug(`Subscribed to tick channel: ${channel}`);
  }

  /**
   * Evaluate whether to trail after the first target is hit for a PARTIAL_PROFIT position.
   *
   * Flow:
   *  1. Emit PARTIAL_PROFIT_BOOKED so execution layer exits `fraction` lots.
   *  2. GreedyTrailService decides: shouldTrail / mechanism.
   *  3. If trail → update DB: new trailing mechanism + SL at break-even.
   *  4. If no trail → emit TARGET_HIT (full exit of remaining lots).
   */
  private async handlePartialProfitTarget(
    position: Position,
    currentPrice: number,
    instrumentId: string,
  ): Promise<void> {
    const fraction = this.greedyTrailService.firstTargetFraction;

    // Step 1 — Emit partial profit event so the execution layer exits `fraction` lots.
    this.eventEmitter.emit(POSITION_EXIT_EVENT, {
      positionId: position.id,
      reason: PositionExitReason.PARTIAL_PROFIT_BOOKED,
      currentPrice,
      timestamp: new Date(),
      partialExitFraction: fraction,
    });

    // Step 2 — Ask GreedyTrailService whether conditions support trailing.
    const decision = await this.greedyTrailService.decide({
      currentPrice,
      direction: position.direction as 'LONG' | 'SHORT',
      entryPrice: position.average_entry_price,
      instrumentId,
      entryVolume: 0, // 0 = skip volume baseline; GreedyTrailService defaults pass
      atr: 0, // ATR not available here; GreedyTrail uses snapshot-based logic
    });

    this.logger.log(`[GreedyTrail] Position ${position.id}: ${decision.reason}`);

    if (decision.shouldTrail && decision.mechanism) {
      // Step 3 — Break-even SL + switch to auto-selected trailing mechanism.
      await this.positionsRepo.update(position.id, {
        current_sl: position.average_entry_price,
        trailing_stop_mechanism: decision.mechanism,
        target_price: null, // Remove fixed target — now trail-driven
      });

      this.logger.log(
        `[GreedyTrail] Position ${position.id} trailing with ${decision.mechanism} — ` +
          `SL moved to break-even (${position.average_entry_price}).`,
      );
    } else {
      // Step 4 — Conditions not met: exit remaining lots at market.
      this.eventEmitter.emit(POSITION_EXIT_EVENT, {
        positionId: position.id,
        reason: PositionExitReason.TARGET_HIT,
        currentPrice,
        timestamp: new Date(),
      } satisfies PositionExitSignal);
    }
  }
}
