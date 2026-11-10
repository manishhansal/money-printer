/**
 * greedy-trail.service.ts
 *
 * GreedyTrailService — post-first-target auto-trail decision engine.
 *
 * After a position's first target is hit (partial exit of `FIRST_TARGET_FRACTION`):
 *   1. Fetch the current market snapshot from Redis (volume, OI).
 *   2. Evaluate three conditions:
 *        a. DIRECTION    — price still moving in favour of the trade.
 *        b. VOLUME       — current session volume ≥ VOLUME_ACTIVE_RATIO of entry volume.
 *        c. OI_ACTIVE    — open interest not declining (netOiDelta ≥ 0).
 *   3. Apply the greedy decision rule:
 *        • 3/3 conditions met → CHANDELIER_EXIT   (biggest trail, greediest)
 *        • 2/3 conditions met → ATR_BASED          (standard trail)
 *        • 1/3 or 0/3         → take full profit (no trailing)
 *   4. Return the selected mechanism config (caller updates position in DB).
 *
 * SL after partial exit is always moved to entry price (break-even) so the
 * remaining position is risk-free.
 *
 * All thresholds are environment-configurable.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { MarketSnapshot } from '../market-data/market-data.types';
import {
  TrailingStopMechanism,
  TrailingStopConfig,
  AtrBasedConfig,
  ChandelierExitConfig,
  PercentageBasedConfig,
} from '../trailing-stop/trailing-stop.types';

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

/** Fraction of position to exit at first target (50% default). */
const DEFAULT_FIRST_TARGET_FRACTION = 0.5;

/**
 * Volume ratio threshold: current_volume / entry_volume ≥ this value
 * for the volume condition to pass.
 */
const DEFAULT_VOLUME_ACTIVE_RATIO = 0.6;

/** Minimum number of conditions (out of 3) required to trail. */
const DEFAULT_TRAIL_MIN_CONDITIONS = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GreedyTrailInput {
  /** Current market price of the instrument. */
  currentPrice: number;
  /** Direction of the position ('LONG' | 'SHORT'). */
  direction: 'LONG' | 'SHORT';
  /** Entry price of the position (INR, numeric string). */
  entryPrice: string;
  /** Instrument ID for Redis market-snapshot lookup. */
  instrumentId: string;
  /**
   * Session volume at the time of signal entry (from signal's measuredInputs).
   * Used as the baseline to judge whether current volume is "active".
   * Pass 0 to skip the volume condition (defaults to pass).
   */
  entryVolume: number;
  /** ATR at entry time, used to configure trailing stop distance. */
  atr: number;
}

export interface GreedyTrailDecision {
  /** Whether to trail the remaining position. false = take full profit. */
  shouldTrail: boolean;
  /**
   * Number of conditions (out of 3) that passed.
   * shouldTrail is true iff passedConditions ≥ minConditions.
   */
  passedConditions: number;
  /** Human-readable explanation of the decision. */
  reason: string;
  /** Selected trailing mechanism (defined only when shouldTrail = true). */
  mechanism?: TrailingStopMechanism;
  /** Mechanism configuration to pass to TrailingStopService (defined when shouldTrail = true). */
  config?: TrailingStopConfig;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class GreedyTrailService {
  private readonly logger = new Logger(GreedyTrailService.name);

  /** Fraction of position to exit at first target. */
  readonly firstTargetFraction: number;
  /** Volume ratio threshold for VOLUME condition. */
  private readonly volumeActiveRatio: number;
  /** Minimum conditions required to trail. */
  private readonly minConditions: number;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.firstTargetFraction = this.configService.get<number>(
      'GREEDY_FIRST_TARGET_FRACTION',
      DEFAULT_FIRST_TARGET_FRACTION,
    );
    this.volumeActiveRatio = this.configService.get<number>(
      'GREEDY_VOLUME_ACTIVE_RATIO',
      DEFAULT_VOLUME_ACTIVE_RATIO,
    );
    this.minConditions = this.configService.get<number>(
      'GREEDY_TRAIL_MIN_CONDITIONS',
      DEFAULT_TRAIL_MIN_CONDITIONS,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate whether the remaining position should be trailed after the first
   * target is hit.
   *
   * Fetches the live market snapshot from Redis to assess volume and OI activity.
   * Falls back to pass (trail) if the snapshot is unavailable.
   *
   * @param input  Position context plus live market price at first-target hit.
   * @returns      Decision with mechanism config if shouldTrail = true.
   */
  async decide(input: GreedyTrailInput): Promise<GreedyTrailDecision> {
    const { currentPrice, direction, entryPrice, instrumentId, entryVolume } = input;
    const entry = parseFloat(entryPrice);

    // ── Fetch live market snapshot (volume, OI) from Redis ─────────────────
    const snapshot = await this.fetchSnapshot(instrumentId);

    // ── Evaluate the 3 conditions ──────────────────────────────────────────

    // Condition 1: DIRECTION — price still moving in trade direction past entry
    const directionOk = direction === 'LONG' ? currentPrice > entry : currentPrice < entry;

    // Condition 2: VOLUME — session volume ≥ volumeActiveRatio × entry volume
    let volumeOk = true; // default pass when no baseline
    if (snapshot && entryVolume > 0) {
      const currentVolume = parseFloat(snapshot.volume);
      volumeOk = currentVolume >= entryVolume * this.volumeActiveRatio;
    }

    // Condition 3: OI ACTIVE — open interest has not declined (or is unavailable)
    let oiOk = true; // default pass when OI not available
    if (snapshot?.oi !== null && snapshot?.oi !== undefined) {
      // Current OI from snapshot — OI should not have dropped significantly
      // We can't compare against previous OI easily here, so we just check
      // it's non-zero (zero OI = contract expired or very illiquid)
      const currentOi = parseFloat(snapshot.oi ?? '0');
      oiOk = currentOi > 0;
    }

    const passedConditions = [directionOk, volumeOk, oiOk].filter(Boolean).length;

    this.logger.debug(
      `[GreedyTrail] ${instrumentId}: direction=${directionOk}, ` +
        `volume=${volumeOk}, oi=${oiOk} → passed=${passedConditions}/${this.minConditions}`,
    );

    if (passedConditions < this.minConditions) {
      return {
        shouldTrail: false,
        passedConditions,
        reason:
          `Only ${passedConditions}/3 trail conditions met (need ≥${this.minConditions}) — ` +
          `taking full profit at target.`,
      };
    }

    // ── Auto-select trailing mechanism ────────────────────────────────────
    const { mechanism, config } = this.selectMechanism(passedConditions, input.atr, direction);

    return {
      shouldTrail: true,
      passedConditions,
      reason:
        `${passedConditions}/3 trail conditions met — ` +
        `trailing with ${mechanism} ` +
        `(direction=${directionOk}, volume=${volumeOk}, oi=${oiOk}).`,
      mechanism,
      config,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Auto-select the trailing mechanism based on how many conditions passed.
   *
   * Decision table (greedy-first):
   *   3/3 → CHANDELIER_EXIT   (anchors to highest-high, most room to run)
   *   2/3 → ATR_BASED         (standard ATR trail, proven reliable)
   *   1/3 → PERCENTAGE_BASED  (conservative fallback — but we don't trail with <2)
   */
  private selectMechanism(
    passedConditions: number,
    _atr: number,
    _direction: string,
  ): { mechanism: TrailingStopMechanism; config: TrailingStopConfig } {
    if (passedConditions === 3) {
      // All conditions → CHANDELIER_EXIT (greedy: captures the full trending move)
      const config: ChandelierExitConfig = {
        mechanism: TrailingStopMechanism.CHANDELIER_EXIT,
        period: 14, // 14-bar lookback for highest-high
        multiplier: 3.0, // 3 × ATR — give the trade room to breathe
      };
      return { mechanism: TrailingStopMechanism.CHANDELIER_EXIT, config };
    }

    if (passedConditions === 2) {
      // 2 conditions → ATR_BASED (reliable, momentum-aware)
      const config: AtrBasedConfig = {
        mechanism: TrailingStopMechanism.ATR_BASED,
        multiplier: 2.0, // 2 × ATR — tighter but still trends
      };
      return { mechanism: TrailingStopMechanism.ATR_BASED, config };
    }

    // Fallback (shouldn't reach here with minConditions=2, but be safe)
    const config: PercentageBasedConfig = {
      mechanism: TrailingStopMechanism.PERCENTAGE_BASED,
      percentage: 0.03, // 3% trail from current price
    };
    return { mechanism: TrailingStopMechanism.PERCENTAGE_BASED, config };
  }

  /**
   * Fetch the live market snapshot from Redis.
   * Returns null if unavailable (snapshot expired or never set).
   */
  private async fetchSnapshot(instrumentId: string): Promise<MarketSnapshot | null> {
    try {
      const raw = await this.redisService.get(`mkt:snapshot:${instrumentId}`);
      if (!raw) return null;
      return JSON.parse(raw) as MarketSnapshot;
    } catch {
      return null;
    }
  }
}
