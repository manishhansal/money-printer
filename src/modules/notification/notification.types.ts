/**
 * notification.types.ts
 *
 * Shared types and constants for the NotificationModule.
 * Requirements: 12.7, 12.8, 20.9
 */

export type AlertPriority = 'MAX' | 'CRITICAL' | 'WARNING' | 'INFO';

/**
 * Canonical alert payload delivered to the Chrome Extension.
 *
 * - `acknowledged` and `acknowledgedAt` are only meaningful for MAX-priority alerts
 *   (tracked by TrailingStopEngine SL escalation and kill-switch acknowledgment).
 */
export interface NotificationAlert {
  /** UUID, globally unique per alert */
  id: string;
  /** Severity level — MAX > CRITICAL > WARNING > INFO */
  priority: AlertPriority;
  /** Short human-readable headline for the Extension UI */
  title: string;
  /** Full alert detail */
  message: string;
  /** Arbitrary key-value context attached by the publishing module */
  metadata?: Record<string, unknown>;
  /** UTC timestamp of alert creation */
  createdAt: Date;
  /** MAX-priority only: true once the user acknowledges via the Extension */
  acknowledged?: boolean;
  /** UTC timestamp of acknowledgment; set by NotificationService.acknowledge() */
  acknowledgedAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority ordering helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Numeric weight per priority level.
 * Higher weight = more urgent = processed first.
 */
export const PRIORITY_WEIGHT: Readonly<Record<AlertPriority, number>> = {
  MAX: 4,
  CRITICAL: 3,
  WARNING: 2,
  INFO: 1,
} as const;

/**
 * Canonical delivery order — highest priority first.
 * Used when flushing the Redis buffer on client reconnection.
 */
export const PRIORITY_ORDER: readonly AlertPriority[] = [
  'MAX',
  'CRITICAL',
  'WARNING',
  'INFO',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Redis key patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redis LIST key for undelivered alerts per priority.
 * Pattern: notifications:pending:{priority}
 */
export const redisBufferKey = (priority: AlertPriority): string =>
  `notifications:pending:${priority}`;

/**
 * Redis key for MAX-alert acknowledgment state.
 * Pattern: notifications:ack:{alertId}
 */
export const redisAckKey = (alertId: string): string => `notifications:ack:${alertId}`;

// ─────────────────────────────────────────────────────────────────────────────
// Delivery constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum WebSocket delivery attempts before buffering to Redis */
export const MAX_DELIVERY_RETRIES = 3;

/** Base delay between retry attempts in milliseconds (multiplied by attempt number) */
export const RETRY_DELAY_MS = 500;

/** TTL (seconds) for acknowledgment records in Redis — 24 hours for audit purposes */
export const ACK_TTL_SECONDS = 86_400;
