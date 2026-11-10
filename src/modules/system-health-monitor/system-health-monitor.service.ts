/**
 * system-health-monitor.service.ts
 *
 * Tracks operational health for 6 CloudEngine metrics:
 *   1. cloudengine_modules      — health of key CloudEngine modules (passive)
 *   2. dhan_api_connectivity    — Dhan REST/WebSocket reachability (passive)
 *   3. postgresql_connection    — PostgreSQL query round-trip (active)
 *   4. redis_availability       — Redis PING round-trip (active)
 *   5. websocket_feed_latency   — real-time feed latency (passive)
 *   6. order_execution_latency  — broker-side order round-trip (passive)
 *
 * Active checks (postgresql_connection, redis_availability) are executed on
 * every 30-second poll. Passive metrics are updated by other modules via
 * updateMetricStatus().
 *
 * On every 30-second poll:
 *  - Each active metric is classified as Healthy / Degraded / Down.
 *  - `health:{metric_name}` Redis keys are set with TTL 90 s for all 6 metrics.
 *  - An INFO summary alert is published to NotificationService.
 *  - Any Healthy → Degraded or Degraded → Down transition triggers an
 *    immediate CRITICAL alert.
 *
 * updateMetricStatus() — allows other modules to report their own health.
 * Transitions detected via this method also publish CRITICAL alerts immediately,
 * independent of the 30-second poll interval.
 *
 * Requirements: 2.7, 2.8, 20.8, 20.9
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { RedisService } from '../redis/redis.service';
import { NotificationService } from '../notification/notification.service';
import { HealthMetricName, HealthStatus } from './system-health-monitor.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** TTL (seconds) for every `health:{metric}` Redis key. */
export const HEALTH_KEY_TTL_SECONDS = 90;

/**
 * Active-check round-trip threshold.
 * Responses slower than this are classified as Degraded rather than Healthy.
 */
const DEGRADED_THRESHOLD_MS = 500;

/** All six monitored metrics in a stable iteration order. */
export const ALL_METRICS: HealthMetricName[] = [
  'cloudengine_modules',
  'dhan_api_connectivity',
  'postgresql_connection',
  'redis_availability',
  'websocket_feed_latency',
  'order_execution_latency',
];

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SystemHealthMonitorService {
  private readonly logger = new Logger(SystemHealthMonitorService.name);

  /**
   * Single source of truth for each metric's current HealthStatus.
   *
   * Initialised to 'Healthy' for all metrics at construction time.
   * Updated by:
   *  - pollHealth() for active metrics (postgresql_connection, redis_availability)
   *  - updateMetricStatus() for passive metrics reported by other modules
   */
  private readonly states = new Map<HealthMetricName, HealthStatus>();

  constructor(
    private readonly redisService: RedisService,
    private readonly notificationService: NotificationService,
    @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
  ) {
    for (const metric of ALL_METRICS) {
      this.states.set(metric, 'Healthy');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scheduled poll — every 30 seconds
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Main health-check loop, executed on every 30-second clock boundary.
   *
   * Execution order:
   *  1. Run active checks for postgresql_connection and redis_availability.
   *  2. Set `health:{metric}` Redis keys (TTL 90 s) for ALL 6 metrics.
   *  3. Detect and publish CRITICAL alerts for any degrading transitions.
   *  4. Publish an INFO summary of the current state of all 6 metrics.
   *
   * Requirement: 20.8 — health status refreshed every ≤ 30 seconds.
   */
  @Cron('*/30 * * * * *')
  async pollHealth(): Promise<void> {
    this.logger.debug('SystemHealthMonitor: polling 6 metrics');

    // ── Step 1: active checks ───────────────────────────────────────────────
    const postgresStatus = await this.checkPostgresql();
    const redisStatus = await this.checkRedis();

    // Collect per-metric status updates (active checks override current state)
    const updatedStates = new Map<HealthMetricName, HealthStatus>(this.states);
    updatedStates.set('postgresql_connection', postgresStatus);
    updatedStates.set('redis_availability', redisStatus);

    // ── Step 2: Redis key persistence ──────────────────────────────────────
    await Promise.all(
      ALL_METRICS.map((metric) =>
        this.redisService
          .set(`health:${metric}`, updatedStates.get(metric) as string, HEALTH_KEY_TTL_SECONDS)
          .catch((err: Error) =>
            this.logger.error(`Failed to set Redis key health:${metric}: ${err.message}`),
          ),
      ),
    );

    // ── Step 3: transition detection & CRITICAL alerts ─────────────────────
    for (const metric of ALL_METRICS) {
      const previous = this.states.get(metric) as HealthStatus;
      const current = updatedStates.get(metric) as HealthStatus;

      if (this.isDegradingTransition(previous, current)) {
        await this.publishTransitionAlert(metric, previous, current).catch((err: Error) =>
          this.logger.error(`Failed to publish transition alert for ${metric}: ${err.message}`),
        );
      }

      // Persist the new state
      this.states.set(metric, current);
    }

    // ── Step 4: INFO summary ───────────────────────────────────────────────
    await this.publishSummary().catch((err: Error) =>
      this.logger.error(`Failed to publish health summary: ${err.message}`),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns a snapshot of the current status of all 6 monitored metrics.
   *
   * Requirement: 20.9 — health dashboard reads this record on request.
   */
  getHealthSnapshot(): Record<HealthMetricName, HealthStatus> {
    return Object.fromEntries(this.states) as Record<HealthMetricName, HealthStatus>;
  }

  /**
   * Allows any CloudEngine module to report its own operational status.
   *
   * - Updates the in-memory state for `metric` immediately.
   * - If the update causes a Healthy → Degraded or Degraded → Down transition,
   *   a CRITICAL alert is published to NotificationService immediately,
   *   independent of the 30-second poll interval.
   *
   * @param metric  The metric being reported.
   * @param status  The new HealthStatus classification.
   * @param details Optional human-readable context (e.g. error message).
   *
   * Requirements: 2.7, 20.8
   */
  async updateMetricStatus(
    metric: HealthMetricName,
    status: HealthStatus,
    details?: string,
  ): Promise<void> {
    const previous = this.states.get(metric) as HealthStatus;
    this.states.set(metric, status);

    this.logger.log(`Metric ${metric}: ${previous} → ${status}${details ? ` — ${details}` : ''}`);

    if (this.isDegradingTransition(previous, status)) {
      await this.publishTransitionAlert(metric, previous, status, details).catch((err: Error) =>
        this.logger.error(`Failed to publish transition alert for ${metric}: ${err.message}`),
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Active health checks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs `SELECT 1` against PostgreSQL and classifies the response:
   *  - < DEGRADED_THRESHOLD_MS  → Healthy
   *  - ≥ DEGRADED_THRESHOLD_MS  → Degraded
   *  - exception                → Down
   *
   * Returns the current cached state if no DataSource is available (optional
   * injection — allows the module to run in environments without a DB).
   */
  private async checkPostgresql(): Promise<HealthStatus> {
    if (!this.dataSource) {
      return this.states.get('postgresql_connection') ?? 'Healthy';
    }

    try {
      const start = Date.now();
      await this.dataSource.query('SELECT 1');
      const elapsed = Date.now() - start;
      return elapsed >= DEGRADED_THRESHOLD_MS ? 'Degraded' : 'Healthy';
    } catch (err: unknown) {
      this.logger.error(`PostgreSQL health check failed: ${(err as Error).message}`);
      return 'Down';
    }
  }

  /**
   * Sends a Redis PING and classifies the response:
   *  - PONG in < DEGRADED_THRESHOLD_MS  → Healthy
   *  - PONG in ≥ DEGRADED_THRESHOLD_MS  → Degraded
   *  - no PONG / exception              → Down
   */
  private async checkRedis(): Promise<HealthStatus> {
    try {
      const start = Date.now();
      const healthy = await this.redisService.isHealthy();
      const elapsed = Date.now() - start;

      if (!healthy) return 'Down';
      return elapsed >= DEGRADED_THRESHOLD_MS ? 'Degraded' : 'Healthy';
    } catch (err: unknown) {
      this.logger.error(`Redis health check failed: ${(err as Error).message}`);
      return 'Down';
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Transition helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns true for transitions that represent a deterioration in service
   * quality and therefore warrant an immediate CRITICAL alert:
   *   - Healthy  → Degraded
   *   - Degraded → Down
   *
   * Improvement transitions (Degraded → Healthy, Down → Healthy, Down →
   * Degraded) are silent — the next INFO summary will reflect recovery.
   */
  private isDegradingTransition(previous: HealthStatus, current: HealthStatus): boolean {
    return (
      (previous === 'Healthy' && current === 'Degraded') ||
      (previous === 'Degraded' && current === 'Down')
    );
  }

  /** Publishes a CRITICAL NotificationAlert for a degrading transition. */
  private async publishTransitionAlert(
    metric: HealthMetricName,
    from: HealthStatus,
    to: HealthStatus,
    details?: string,
  ): Promise<void> {
    this.logger.warn(
      `Health transition: ${metric} ${from} → ${to}${details ? ` — ${details}` : ''}`,
    );

    await this.notificationService.publish({
      id: uuidv4(),
      priority: 'CRITICAL',
      title: `Health Degraded: ${metric}`,
      message: `${metric} transitioned from ${from} to ${to}.${details ? ` Details: ${details}` : ''}`,
      metadata: { metric, from, to, ...(details ? { details } : {}) },
      createdAt: new Date(),
    });
  }

  /** Publishes an INFO alert summarising the current state of all 6 metrics. */
  private async publishSummary(): Promise<void> {
    const snapshot = this.getHealthSnapshot();
    const summary = ALL_METRICS.map((m) => `${m}=${snapshot[m]}`).join(', ');

    await this.notificationService.publish({
      id: uuidv4(),
      priority: 'INFO',
      title: 'System Health Status',
      message: `Health poll: ${summary}`,
      metadata: { snapshot },
      createdAt: new Date(),
    });
  }
}
