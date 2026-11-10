/**
 * session-manager.service.ts
 *
 * Tracks the 8 NSE trading session phases and drives phase-change events.
 *
 * Responsibilities:
 *  - Determine the current SessionPhase from IST wall-clock time.
 *  - Run a cron job every minute to detect phase transitions.
 *  - On transition:
 *      1. Set `session:phase:current` Redis key.
 *      2. Publish `SessionPhaseChangeEvent` to `events:session_phase` Redis channel.
 *      3. Emit `session.phase.changed` NestJS event for intra-process subscribers.
 *  - Expose synchronous helpers: getCurrentPhase(), isOpeningVolatilityPhase(),
 *    isWithinMarketHours().
 *
 * Phase boundaries (IST = UTC+05:30) — all intervals are [start, end):
 *   PRE_MARKET            09:00 – 09:15
 *   OPENING_VOLATILITY    09:15 – 09:20
 *   ORB_FORMATION         09:20 – 09:30  (09:15–09:30 per spec; OPENING_VOLATILITY takes 09:15–09:20)
 *   MORNING_MOMENTUM      09:30 – 11:00
 *   MID_SESSION           11:00 – 13:00
 *   AFTERNOON             13:00 – 14:30
 *   CLOSING               14:30 – 15:30
 *   EOD_RECONCILIATION    15:30 – 16:00
 *   MARKET_CLOSED         outside 09:00–16:00
 *
 * Requirements: 17.1, 17.2, 17.5
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '../redis/redis.service';
import {
  SessionPhase,
  SessionPhaseChangeEvent,
  PhaseBoundary,
  SESSION_PHASE_KEY,
  SESSION_PHASE_CHANNEL,
  SESSION_PHASE_CHANGED_EVENT,
} from './session-manager.types';

/**
 * Phase definitions ordered by specificity.
 * Evaluation stops at the first matching entry, so OPENING_VOLATILITY
 * (09:15–09:20) must precede ORB_FORMATION (09:20–09:30) to implement
 * the overlap rule correctly.
 */
const PHASE_BOUNDARIES: PhaseBoundary[] = [
  {
    phase: SessionPhase.PRE_MARKET,
    start: { hours: 9, minutes: 0 },
    end: { hours: 9, minutes: 15 },
  },
  {
    phase: SessionPhase.OPENING_VOLATILITY,
    start: { hours: 9, minutes: 15 },
    end: { hours: 9, minutes: 20 },
  },
  {
    phase: SessionPhase.ORB_FORMATION,
    start: { hours: 9, minutes: 20 },
    end: { hours: 9, minutes: 30 },
  },
  {
    phase: SessionPhase.MORNING_MOMENTUM,
    start: { hours: 9, minutes: 30 },
    end: { hours: 11, minutes: 0 },
  },
  {
    phase: SessionPhase.MID_SESSION,
    start: { hours: 11, minutes: 0 },
    end: { hours: 13, minutes: 0 },
  },
  {
    phase: SessionPhase.AFTERNOON,
    start: { hours: 13, minutes: 0 },
    end: { hours: 14, minutes: 30 },
  },
  {
    phase: SessionPhase.CLOSING,
    start: { hours: 14, minutes: 30 },
    end: { hours: 15, minutes: 30 },
  },
  {
    phase: SessionPhase.EOD_RECONCILIATION,
    start: { hours: 15, minutes: 30 },
    end: { hours: 16, minutes: 0 },
  },
];

/** IST offset from UTC in minutes (UTC+05:30). */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

@Injectable()
export class SessionManagerService implements OnModuleInit {
  private readonly logger = new Logger(SessionManagerService.name);

  /** Last known phase — updated on every successful transition check. */
  private currentPhase: SessionPhase = SessionPhase.MARKET_CLOSED;

  constructor(
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    // Determine the initial phase so callers get a valid answer immediately,
    // without waiting for the first cron tick.
    const initial = this.determinePhase(new Date());
    this.currentPhase = initial;

    // Persist to Redis so external consumers see the current phase right away.
    await this.redisService.set(SESSION_PHASE_KEY, initial);

    this.logger.log(`SessionManagerService initialised — current phase: ${initial}`);
  }

  // ---------------------------------------------------------------------------
  // Cron job — runs every minute
  // ---------------------------------------------------------------------------

  /**
   * Evaluates the current session phase and fires a phase-change event when
   * the phase differs from the last recorded one.
   *
   * The cron fires at second :00 of every minute so the check is tightly
   * aligned with the minute boundaries used by IST phase windows.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async evaluatePhase(): Promise<void> {
    const now = new Date();
    const newPhase = this.determinePhase(now);

    if (newPhase !== this.currentPhase) {
      await this.handlePhaseTransition(this.currentPhase, newPhase, now);
    }
  }

  // ---------------------------------------------------------------------------
  // Public synchronous API
  // ---------------------------------------------------------------------------

  /**
   * Returns the current session phase synchronously.
   * The value is updated by the cron job every minute.
   */
  getCurrentPhase(): SessionPhase {
    return this.currentPhase;
  }

  /**
   * Returns true when the current phase is OPENING_VOLATILITY (09:15–09:20 IST).
   * Requirement 17.2: StrategyEngine must restrict to opening-phase-compatible
   * strategies during this window.
   */
  isOpeningVolatilityPhase(): boolean {
    return this.currentPhase === SessionPhase.OPENING_VOLATILITY;
  }

  /**
   * Returns true during any phase where the market is considered active
   * (i.e. any phase that is NOT MARKET_CLOSED).
   */
  isWithinMarketHours(): boolean {
    return this.currentPhase !== SessionPhase.MARKET_CLOSED;
  }

  // ---------------------------------------------------------------------------
  // Phase determination logic
  // ---------------------------------------------------------------------------

  /**
   * Determines the NSE session phase for the given UTC timestamp by converting
   * it to IST (UTC+05:30) and comparing the time-of-day against the phase
   * boundaries table.
   *
   * Evaluation is first-match: OPENING_VOLATILITY is listed before ORB_FORMATION
   * so the 09:15–09:20 overlap resolves to OPENING_VOLATILITY as specified.
   *
   * @param utcDate  Any Date object representing a wall-clock moment (UTC).
   * @returns        The matching SessionPhase, or MARKET_CLOSED if outside
   *                 the 09:00–16:00 IST window.
   */
  determinePhase(utcDate: Date): SessionPhase {
    const istMinutes = this.toIstMinutes(utcDate);

    for (const boundary of PHASE_BOUNDARIES) {
      const startMinutes = boundary.start.hours * 60 + boundary.start.minutes;
      const endMinutes = boundary.end.hours * 60 + boundary.end.minutes;

      if (istMinutes >= startMinutes && istMinutes < endMinutes) {
        return boundary.phase;
      }
    }

    return SessionPhase.MARKET_CLOSED;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts a UTC Date to the number of minutes elapsed since midnight IST.
   * Uses pure arithmetic (no locale/timezone API) for determinism across
   * environments regardless of the host system's local timezone setting.
   */
  private toIstMinutes(utcDate: Date): number {
    const utcTotalMinutes = utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes();
    // Modulo 1440 (minutes per day) handles midnight rollovers correctly.
    return (utcTotalMinutes + IST_OFFSET_MINUTES) % (24 * 60);
  }

  /**
   * Handles a confirmed phase transition:
   *  1. Logs the transition.
   *  2. Updates the in-memory phase.
   *  3. Persists the new phase to Redis.
   *  4. Publishes a SessionPhaseChangeEvent to the Redis pub/sub channel.
   *  5. Emits a NestJS event for intra-process subscribers.
   */
  private async handlePhaseTransition(
    previousPhase: SessionPhase,
    newPhase: SessionPhase,
    timestamp: Date,
  ): Promise<void> {
    this.logger.log(
      `Session phase transition: ${previousPhase} → ${newPhase} at ${timestamp.toISOString()}`,
    );

    // Update in-memory state first so synchronous callers immediately see the
    // new phase even if the async operations below are still in-flight.
    this.currentPhase = newPhase;

    const event: SessionPhaseChangeEvent = {
      phase: newPhase,
      previousPhase,
      timestamp,
    };

    // Persist current phase to Redis key.
    try {
      await this.redisService.set(SESSION_PHASE_KEY, newPhase);
    } catch (err) {
      this.logger.error(`Failed to set Redis key ${SESSION_PHASE_KEY}: ${(err as Error).message}`);
    }

    // Publish phase-change event to Redis pub/sub channel.
    try {
      await this.redisService.publish(SESSION_PHASE_CHANNEL, JSON.stringify(event));
    } catch (err) {
      this.logger.error(
        `Failed to publish to Redis channel ${SESSION_PHASE_CHANNEL}: ${(err as Error).message}`,
      );
    }

    // Emit intra-process NestJS event (consumed by StrategyEngine, RiskEngine, etc.).
    this.eventEmitter.emit(SESSION_PHASE_CHANGED_EVENT, event);

    // Log Opening Volatility restriction notice (Requirement 17.2).
    if (newPhase === SessionPhase.OPENING_VOLATILITY) {
      this.logger.warn(
        'Entered OPENING_VOLATILITY phase — StrategyEngine must restrict to opening-phase-compatible strategies.',
      );
    }
  }
}
