/**
 * VixPositionSizeService — VIX-driven position size controller.
 *
 * Responsibilities (Requirements 9.7, 9.10):
 *
 *  1. Tracks the current position-size state: NORMAL or REDUCED.
 *
 *  2. updateVix(indiaVix):
 *       - If VIX > UNUSUAL_VOLATILITY_VIX_THRESHOLD → immediately transition
 *         to REDUCED state and reset the below-threshold timer.
 *       - If VIX ≤ threshold → start (or continue) the 5-minute restoration
 *         timer.  Once VIX has been continuously below the threshold for
 *         VIX_RESTORE_CONTINUOUS_MINUTES, restore to NORMAL and emit the
 *         NestJS event 'vix.position.size.restored'.
 *
 *  3. getMaxLots():
 *       - Returns VOLATILITY_PROTECTION_LIMIT_LOTS when state = REDUCED.
 *       - Returns NORMAL_MAX_LOTS_PER_SIGNAL when state = NORMAL.
 *
 * Configuration (via ConfigService, env-overridable):
 *   UNUSUAL_VOLATILITY_VIX_THRESHOLD     = 20.0   (VIX level that triggers reduction)
 *   VOLATILITY_PROTECTION_LIMIT_LOTS     = 2      (max lots when VIX elevated)
 *   NORMAL_MAX_LOTS_PER_SIGNAL           = 10     (max lots under normal conditions)
 *   VIX_RESTORE_CONTINUOUS_MINUTES       = 5      (minutes below threshold to restore)
 *
 * Requirements: 9.7, 9.10
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Discriminated state for the VIX position-size controller. */
export type VixPositionSizeState = 'NORMAL' | 'REDUCED';

/** NestJS event name emitted when position size is restored to normal. */
export const VIX_POSITION_SIZE_RESTORED_EVENT = 'vix.position.size.restored';

// ─────────────────────────────────────────────────────────────────────────────
// Default configuration values (overridable via ConfigService / env vars)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_UNUSUAL_VOLATILITY_VIX_THRESHOLD = 20.0;
const DEFAULT_VOLATILITY_PROTECTION_LIMIT_LOTS = 2;
const DEFAULT_NORMAL_MAX_LOTS_PER_SIGNAL = 10;
const DEFAULT_VIX_RESTORE_CONTINUOUS_MINUTES = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class VixPositionSizeService {
  private readonly logger = new Logger(VixPositionSizeService.name);

  /** Current position-size state. Starts NORMAL; elevated VIX switches to REDUCED. */
  private state: VixPositionSizeState = 'NORMAL';

  /**
   * Timestamp of when VIX first dropped to or below the threshold after a
   * REDUCED period.  null when VIX is currently above the threshold or when
   * the timer has not yet started.
   */
  private belowThresholdSince: Date | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the current maximum permitted position size in lots.
   *
   * - REDUCED state → VOLATILITY_PROTECTION_LIMIT_LOTS (e.g. 2)
   * - NORMAL  state → NORMAL_MAX_LOTS_PER_SIGNAL       (e.g. 10)
   *
   * Requirement 9.7
   */
  getMaxLots(): number {
    if (this.state === 'REDUCED') {
      return (
        this.configService.get<number>('VOLATILITY_PROTECTION_LIMIT_LOTS') ??
        DEFAULT_VOLATILITY_PROTECTION_LIMIT_LOTS
      );
    }
    return (
      this.configService.get<number>('NORMAL_MAX_LOTS_PER_SIGNAL') ??
      DEFAULT_NORMAL_MAX_LOTS_PER_SIGNAL
    );
  }

  /**
   * Process the latest India VIX reading and update the position-size state.
   *
   * Logic:
   *   If VIX > threshold:
   *     → state = REDUCED; belowThresholdSince = null
   *
   *   If VIX ≤ threshold:
   *     → if belowThresholdSince is null, record the current time
   *     → if the elapsed time since belowThresholdSince ≥ configured
   *        restore interval AND state is REDUCED:
   *          state = NORMAL; emit 'vix.position.size.restored'
   *
   * Requirements 9.7, 9.10
   *
   * @param indiaVix  Latest India VIX level.
   */
  updateVix(indiaVix: number): void {
    const threshold =
      this.configService.get<number>('UNUSUAL_VOLATILITY_VIX_THRESHOLD') ??
      DEFAULT_UNUSUAL_VOLATILITY_VIX_THRESHOLD;

    const restoreMinutes =
      this.configService.get<number>('VIX_RESTORE_CONTINUOUS_MINUTES') ??
      DEFAULT_VIX_RESTORE_CONTINUOUS_MINUTES;

    if (indiaVix > threshold) {
      // ── VIX above threshold → reduce position size immediately ────────────
      if (this.state !== 'REDUCED') {
        this.logger.warn(
          `[VixPositionSize] VIX=${indiaVix} exceeds threshold=${threshold} — ` +
            `reducing max position size to ${this.getMaxLots()} lots`,
        );
      }
      this.state = 'REDUCED';
      this.belowThresholdSince = null;
    } else {
      // ── VIX at or below threshold → start / continue restoration timer ────
      const now = new Date();

      if (this.belowThresholdSince === null) {
        this.belowThresholdSince = now;
        this.logger.debug(
          `[VixPositionSize] VIX=${indiaVix} dropped to/below threshold=${threshold}. ` +
            `Starting ${restoreMinutes}-minute restoration timer.`,
        );
      }

      // Check whether the continuous below-threshold period meets the restore requirement
      const elapsedMs = now.getTime() - this.belowThresholdSince.getTime();
      const restoreMs = restoreMinutes * 60 * 1000;

      if (elapsedMs >= restoreMs && this.state === 'REDUCED') {
        const prevState = this.state;
        this.state = 'NORMAL';
        this.logger.log(
          `[VixPositionSize] VIX has remained ≤ ${threshold} for ${restoreMinutes} consecutive ` +
            `minutes (elapsed=${Math.round(elapsedMs / 1000)}s). ` +
            `Restoring position size from ${prevState} to NORMAL (${this.getMaxLots()} lots).`,
        );
        this.eventEmitter.emit(VIX_POSITION_SIZE_RESTORED_EVENT);
      }
    }
  }

  /**
   * Returns true when the current state is REDUCED (i.e. VIX is elevated and
   * the 5-minute restoration period has not yet elapsed).
   *
   * Requirement 9.7
   */
  isPositionSizeReduced(): boolean {
    return this.state === 'REDUCED';
  }
}
