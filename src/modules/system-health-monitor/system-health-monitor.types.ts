/**
 * system-health-monitor.types.ts
 *
 * Shared types for the SystemHealthMonitorModule.
 *
 * Requirements: 2.7, 2.8, 20.8, 20.9
 */

/**
 * Operational health classification for a monitored metric.
 *
 * - `Healthy`  — metric is operating within normal parameters.
 * - `Degraded` — metric is functional but performance is impaired (e.g. slow
 *                response time, elevated error rate).
 * - `Down`     — metric is non-functional; operations depending on it may fail.
 */
export type HealthStatus = 'Healthy' | 'Degraded' | 'Down';

/**
 * Canonical set of monitored metrics.
 *
 * Each name maps to a Redis key `health:{metric_name}` (TTL 90 s) and a
 * corresponding entry in every HealthSnapshot.
 */
export type HealthMetricName =
  | 'cloudengine_modules'
  | 'dhan_api_connectivity'
  | 'postgresql_connection'
  | 'redis_availability'
  | 'websocket_feed_latency'
  | 'order_execution_latency';

/**
 * Point-in-time health snapshot for a single metric.
 *
 * Returned by SystemHealthMonitorService.getHealthSnapshot() (array form) and
 * published as metadata in INFO/CRITICAL notification alerts.
 */
export interface HealthSnapshot {
  /** Which metric this snapshot describes. */
  metric: HealthMetricName;
  /** Current operational classification. */
  status: HealthStatus;
  /** UTC timestamp of the most recent check for this metric. */
  lastCheckedAt: Date;
  /** Optional human-readable context from the check or the reporting module. */
  details?: string;
}
