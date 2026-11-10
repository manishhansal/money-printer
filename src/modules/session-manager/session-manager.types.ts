/**
 * session-manager.types.ts
 *
 * Type definitions for the SessionManager module.
 *
 * Requirements: 17.1, 17.5
 */

/**
 * All 8 recognised NSE trading session phases plus MARKET_CLOSED for
 * timestamps that fall outside the 09:00–16:00 IST trading window.
 *
 * Phase boundaries (IST = UTC+05:30):
 *   PRE_MARKET            09:00 – 09:15
 *   OPENING_VOLATILITY    09:15 – 09:20  (overlaps ORB; takes precedence 09:15–09:20)
 *   ORB_FORMATION         09:20 – 09:30  (ORB window resumes after Opening Volatility ends)
 *   MORNING_MOMENTUM      09:30 – 11:00
 *   MID_SESSION           11:00 – 13:00
 *   AFTERNOON             13:00 – 14:30
 *   CLOSING               14:30 – 15:30
 *   EOD_RECONCILIATION    15:30 – 16:00
 *   MARKET_CLOSED         outside 09:00–16:00
 */
export enum SessionPhase {
  PRE_MARKET = 'PRE_MARKET',
  OPENING_VOLATILITY = 'OPENING_VOLATILITY',
  ORB_FORMATION = 'ORB_FORMATION',
  MORNING_MOMENTUM = 'MORNING_MOMENTUM',
  MID_SESSION = 'MID_SESSION',
  AFTERNOON = 'AFTERNOON',
  CLOSING = 'CLOSING',
  EOD_RECONCILIATION = 'EOD_RECONCILIATION',
  MARKET_CLOSED = 'MARKET_CLOSED',
}

/**
 * Payload published to the `events:session_phase` Redis pub/sub channel
 * and emitted as a NestJS event (`session.phase.changed`) on every phase
 * transition.
 *
 * Requirement 17.5: SessionManager SHALL publish a session-phase-change event
 * consumed by StrategyEngine, RiskEngine, and OptionsIntelligence.
 */
export interface SessionPhaseChangeEvent {
  /** The phase the system has just entered. */
  phase: SessionPhase;
  /** The phase the system was in immediately before this transition. */
  previousPhase: SessionPhase;
  /** Wall-clock timestamp of the transition (UTC). */
  timestamp: Date;
}

/**
 * IST time expressed as { hours, minutes } in 24-hour format.
 * Used internally to define phase boundaries without importing heavyweight
 * date-time libraries.
 */
export interface IstTime {
  hours: number;
  minutes: number;
}

/**
 * Defines the inclusive-start / exclusive-end boundary for a session phase.
 */
export interface PhaseBoundary {
  phase: SessionPhase;
  /** Phase starts at this IST time (inclusive). */
  start: IstTime;
  /** Phase ends at this IST time (exclusive). */
  end: IstTime;
}

/** Redis key under which the current phase string is always stored. */
export const SESSION_PHASE_KEY = 'session:phase:current';

/** Redis pub/sub channel for phase-change broadcasts. */
export const SESSION_PHASE_CHANNEL = 'events:session_phase';

/** NestJS EventEmitter event name for intra-process subscribers. */
export const SESSION_PHASE_CHANGED_EVENT = 'session.phase.changed';
