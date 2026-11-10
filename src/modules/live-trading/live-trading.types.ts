/**
 * live-trading.types.ts
 *
 * Shared types and constants for the LiveTrading module.
 *
 * Requirements: 11.1, 11.2
 */

/**
 * All valid states of the two-step live-mode arming state machine.
 *
 * Valid transitions (Requirement 11.1):
 *   DISARMED → ARMED_PENDING  via requestArm()   (Step 1 — user clicks "Activate")
 *   ARMED_PENDING → ARMED     via confirmArm()   (Step 2 — user clicks "Confirm")
 *   any → DISARMED            via disarm()       (unconditional disarm)
 *
 * A single user action can NEVER transition DISARMED → ARMED directly.
 */
export enum ArmedState {
  DISARMED = 'DISARMED',
  ARMED_PENDING = 'ARMED_PENDING',
  ARMED = 'ARMED',
}

/**
 * Redis key used to persist the armed state across process boundaries.
 *
 * On every CloudEngine startup, this key is always overwritten with DISARMED
 * regardless of its previous value (Requirement 11.2).
 */
export const ARMED_STATE_KEY = 'trading:armed_state';
