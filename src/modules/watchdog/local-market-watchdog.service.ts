/**
 * local-market-watchdog.service.ts
 *
 * LocalMarketWatchdogService — the continuous monitoring heart of MoneyPrinter.
 *
 * Runs health checks every 30 seconds and a deep audit every 5 minutes.
 * Detects issues across all application layers, classifies them P0–P3,
 * persists them to the monitoring_issues table, and routes them to the
 * AutoRemediationService for safe automatic resolution.
 *
 * Operates on a separate execution lane — NEVER blocks the critical
 * order-submission or position-management paths.
 *
 * Requirements: Phase 16.1, 16.2, 16.5, 16.11
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RedisService } from '../redis/redis.service';
import { NotificationService } from '../notification/notification.service';
import { SystemHealthMonitorService } from '../system-health-monitor/system-health-monitor.service';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { MonitoringIssues } from '../../database/entities/monitoring-issues.entity';
import { IssueClassifierService } from './issue-classifier.service';
import { AutoRemediationService } from './auto-remediation.service';
import {
  DetectedIssue,
  HealthCheckResult,
  SystemSnapshot,
  WatchdogDashboardData,
  ComponentHealthSummary,
  IssueQueryFilter,
  DEFAULT_WATCHDOG_CONFIG,
  WatchdogConfig,
} from './watchdog.types';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Market data freshness threshold — alert if no tick for this long (ms). */
const MARKET_DATA_STALENESS_MS = 10_000;

/** Options chain freshness threshold (ms). */
const OPTIONS_CHAIN_STALENESS_MS = 90_000;

/** Maximum age of instrument master scan (ms) — alert if not refreshed. */
const INSTRUMENT_MASTER_MAX_AGE_MS = 2 * 60 * 60 * 1_000; // 2 hours

/** Redis health key prefix set by SystemHealthMonitorService. */
const HEALTH_KEY_PREFIX = 'health:';

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class LocalMarketWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocalMarketWatchdogService.name);

  /** Configuration — can be overridden via env or admin API. */
  private config: WatchdogConfig = { ...DEFAULT_WATCHDOG_CONFIG };

  /** Latest snapshot for fast dashboard reads. */
  private lastSnapshot: SystemSnapshot | null = null;

  /** Whether the watchdog is currently running a check (guards against overlap). */
  private checkInProgress = false;

  /** Consecutive health check failures before we self-escalate. */
  private consecutiveCheckFailures = 0;

  /** Whether to skip the next scheduled check (used during remediation). */
  private skipNextCheck = false;

  constructor(
    @InjectRepository(MonitoringIssues)
    private readonly issuesRepo: Repository<MonitoringIssues>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    private readonly redisService: RedisService,
    private readonly notificationService: NotificationService,
    private readonly systemHealthMonitor: SystemHealthMonitorService,
    private readonly dhanApiClient: DhanApiClient,
    private readonly issueClassifier: IssueClassifierService,
    private readonly autoRemediation: AutoRemediationService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    this.logger.log('LocalMarketWatchdogService initialised — starting initial health check');
    // Run initial check asynchronously so startup is not blocked.
    setTimeout(() => {
      void this.runHealthCheck();
    }, 15_000); // 15s after boot — let other modules settle first
  }

  onModuleDestroy(): void {
    this.logger.log('LocalMarketWatchdogService shutting down — final state preserved in DB');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scheduled checks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Lightweight health check — every 30 seconds during market hours.
   * Also runs outside market hours but suppresses non-critical alerts.
   *
   * Requirements: Phase 16.1
   */
  @Cron('*/30 * * * * *')
  async runHealthCheck(): Promise<void> {
    if (this.checkInProgress || this.skipNextCheck) {
      this.skipNextCheck = false;
      return;
    }

    this.checkInProgress = true;
    const checkStart = Date.now();

    try {
      const checks = await this.gatherHealthChecks();
      const detectedIssues = await this.issueClassifier.analyzeChecks(checks);
      const snapshot = this.buildSnapshot(checks, detectedIssues);
      this.lastSnapshot = snapshot;

      // Persist new issues and update existing ones
      await this.persistIssues(detectedIssues);

      // Route to auto-remediation (non-blocking)
      void this.autoRemediation.processNewIssues(detectedIssues);

      const durationMs = Date.now() - checkStart;
      this.logger.debug(
        `Health check completed in ${durationMs}ms — ` +
          `${checks.length} components, ${detectedIssues.length} issue(s)`,
      );

      this.consecutiveCheckFailures = 0;
    } catch (err) {
      this.consecutiveCheckFailures++;
      this.logger.error(
        `Health check failed (attempt ${this.consecutiveCheckFailures}): ${(err as Error).message}`,
      );

      if (this.consecutiveCheckFailures >= 3) {
        // Watchdog itself is degraded — alert but don't crash
        await this.publishWatchdogAlert(err as Error);
      }
    } finally {
      this.checkInProgress = false;
    }
  }

  /**
   * Deep audit — every 5 minutes.
   * Performs more expensive checks: strategy performance, P&L consistency, etc.
   *
   * Requirements: Phase 16.1
   */
  @Cron('0 */5 * * * *')
  async runDeepAudit(): Promise<void> {
    if (this.checkInProgress) return;

    try {
      const deepIssues = await this.gatherDeepAuditIssues();
      if (deepIssues.length > 0) {
        await this.persistIssues(deepIssues);
        void this.autoRemediation.processNewIssues(deepIssues);
        this.logger.warn(`Deep audit found ${deepIssues.length} additional issue(s)`);
      } else {
        this.logger.debug('Deep audit: all checks passed');
      }
    } catch (err) {
      this.logger.error(`Deep audit failed: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Health Checks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Gather lightweight health checks across all monitored components.
   * Each check must complete quickly (< 2s) to stay within the 30s window.
   */
  private async gatherHealthChecks(): Promise<HealthCheckResult[]> {
    const now = new Date();
    const checks: HealthCheckResult[] = [];

    /** Per-check timeout — prevents a single hanging check from blocking the watchdog. */
    const CHECK_TIMEOUT_MS = 5_000;

    /**
     * Wraps a check function with an individual timeout so that one slow or
     * permanently-hanging check cannot stall the entire health-check cycle.
     * Resolves to an UNKNOWN result if the timeout fires.
     */
    const withTimeout = (
      name: string,
      fn: (now: Date) => Promise<HealthCheckResult>,
    ): Promise<HealthCheckResult> => {
      let handle: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<HealthCheckResult>((resolve) => {
        handle = setTimeout(() => {
          resolve({
            component: name,
            healthy: false,
            details: `Check timed out after ${CHECK_TIMEOUT_MS}ms — status UNKNOWN`,
            checkedAt: now,
          });
        }, CHECK_TIMEOUT_MS);
      });
      return Promise.race([fn(now), timeoutPromise]).finally(() => clearTimeout(handle));
    };

    // Run all checks in parallel with individual error isolation + timeouts
    const checkFunctions: Array<[string, (now: Date) => Promise<HealthCheckResult>]> = [
      ['backend', this.checkBackendHealth.bind(this)],
      ['redis', this.checkRedisHealth.bind(this)],
      ['postgresql', this.checkPostgresHealth.bind(this)],
      ['dhan', this.checkDhanConnectivity.bind(this)],
      ['market_data', this.checkMarketDataFreshness.bind(this)],
      ['instrument_master', this.checkInstrumentMasterFreshness.bind(this)],
      ['options_chain', this.checkOptionsChainFreshness.bind(this)],
      ['signal_scanner', this.checkSignalScannerActivity.bind(this)],
      ['position_protection', this.checkOpenPositionProtection.bind(this)],
      ['daily_risk', this.checkDailyRiskState.bind(this)],
      ['square_off', this.checkSquareOffReadiness.bind(this)],
    ];

    const results = await Promise.allSettled(
      checkFunctions.map(([name, fn]) => withTimeout(name, fn)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        checks.push(result.value);
      } else {
        // Check itself failed — treat as UNKNOWN
        checks.push({
          component: 'unknown',
          healthy: false,
          details: `Check threw: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          checkedAt: now,
        });
      }
    }

    return checks;
  }

  private async checkBackendHealth(now: Date): Promise<HealthCheckResult> {
    // Backend is running if we're here — check that key services report healthy
    const dhanStatus = await this.redisService.get(`${HEALTH_KEY_PREFIX}dhan_api_connectivity`);
    const wsStatus = await this.redisService.get(`${HEALTH_KEY_PREFIX}websocket_feed_latency`);

    const healthy = dhanStatus === 'Healthy';
    return {
      component: 'backend',
      healthy,
      details: `Dhan: ${dhanStatus ?? 'unknown'}, WebSocket: ${wsStatus ?? 'unknown'}`,
      metadata: { dhanStatus, wsStatus },
      checkedAt: now,
    };
  }

  private async checkRedisHealth(now: Date): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const healthy = await this.redisService.isHealthy();
      return {
        component: 'redis',
        healthy,
        latencyMs: Date.now() - start,
        details: healthy ? 'PING responded' : 'PING failed',
        checkedAt: now,
      };
    } catch (err) {
      return {
        component: 'redis',
        healthy: false,
        latencyMs: Date.now() - start,
        details: `Redis error: ${(err as Error).message}`,
        checkedAt: now,
      };
    }
  }

  private async checkPostgresHealth(now: Date): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return {
        component: 'postgresql',
        healthy: true,
        latencyMs: Date.now() - start,
        details: 'SELECT 1 succeeded',
        checkedAt: now,
      };
    } catch (err) {
      return {
        component: 'postgresql',
        healthy: false,
        latencyMs: Date.now() - start,
        details: `Query failed: ${(err as Error).message}`,
        checkedAt: now,
      };
    }
  }

  private async checkDhanConnectivity(now: Date): Promise<HealthCheckResult> {
    const redisKey = `${HEALTH_KEY_PREFIX}dhan_api_connectivity`;
    const status = await this.redisService.get(redisKey);
    const lastUpdatedRaw = await this.redisService.get('health:dhan_last_checked_at');

    const ageMs = lastUpdatedRaw ? Date.now() - new Date(lastUpdatedRaw).getTime() : Infinity;
    const stale = ageMs > 120_000; // 2 minutes

    return {
      component: 'dhan_api',
      healthy: status === 'Healthy' && !stale,
      details: stale
        ? `Dhan health check stale (${Math.round(ageMs / 1000)}s ago)`
        : `Status: ${status ?? 'unknown'}`,
      metadata: { status, ageMs },
      checkedAt: now,
    };
  }

  private async checkMarketDataFreshness(now: Date): Promise<HealthCheckResult> {
    const lastTickRaw = await this.redisService.get('market:last_tick_at');
    if (!lastTickRaw) {
      return {
        component: 'market_data',
        healthy: true, // No tick yet could mean market is closed
        details: 'No tick timestamp — market may be closed',
        checkedAt: now,
      };
    }

    const ageMs = Date.now() - new Date(lastTickRaw).getTime();
    const stale = ageMs > MARKET_DATA_STALENESS_MS;

    return {
      component: 'market_data',
      healthy: !stale,
      details: stale
        ? `Market data stale — last tick ${Math.round(ageMs / 1000)}s ago`
        : `Last tick ${Math.round(ageMs / 1000)}s ago`,
      metadata: { ageMs, staleThresholdMs: MARKET_DATA_STALENESS_MS },
      checkedAt: now,
    };
  }

  private async checkInstrumentMasterFreshness(now: Date): Promise<HealthCheckResult> {
    const lastScanRaw = await this.redisService.get('instruments:last_scan_at');
    if (!lastScanRaw) {
      return {
        component: 'instrument_master',
        healthy: true, // Not yet run today (before 09:15 IST)
        details: 'Instrument master not yet scanned today',
        checkedAt: now,
      };
    }

    const ageMs = Date.now() - new Date(lastScanRaw).getTime();
    const stale = ageMs > INSTRUMENT_MASTER_MAX_AGE_MS;

    return {
      component: 'instrument_master',
      healthy: !stale,
      details: stale
        ? `Instrument master stale — last scan ${Math.round(ageMs / 60_000)} minutes ago`
        : `Last scan ${Math.round(ageMs / 60_000)} minutes ago`,
      metadata: { ageMs },
      checkedAt: now,
    };
  }

  private async checkOptionsChainFreshness(now: Date): Promise<HealthCheckResult> {
    const lastUpdateRaw = await this.redisService.get('options:chain:last_updated_at');
    if (!lastUpdateRaw) {
      return {
        component: 'options_chain',
        healthy: true,
        details: 'Options chain not yet fetched today',
        checkedAt: now,
      };
    }

    const ageMs = Date.now() - new Date(lastUpdateRaw).getTime();
    const stale = ageMs > OPTIONS_CHAIN_STALENESS_MS;

    return {
      component: 'options_chain',
      healthy: !stale,
      details: stale
        ? `Options chain stale — last update ${Math.round(ageMs / 1000)}s ago`
        : `Last update ${Math.round(ageMs / 1000)}s ago`,
      metadata: { ageMs },
      checkedAt: now,
    };
  }

  private async checkSignalScannerActivity(now: Date): Promise<HealthCheckResult> {
    const lastScanRaw = await this.redisService.get('scanner:last_run_at');
    const scannerStatus = await this.redisService.get('scanner:status');

    if (!lastScanRaw) {
      return {
        component: 'signal_scanner',
        healthy: true,
        details: 'Scanner not yet run (may be awaiting market open)',
        checkedAt: now,
      };
    }

    const ageMs = Date.now() - new Date(lastScanRaw).getTime();
    const stuck = ageMs > 5 * 60_000 && scannerStatus === 'running'; // stuck for >5 min

    return {
      component: 'signal_scanner',
      healthy: !stuck,
      details: stuck
        ? `Scanner appears stuck — running for ${Math.round(ageMs / 60_000)} minutes`
        : `Last scan ${Math.round(ageMs / 1000)}s ago, status: ${scannerStatus ?? 'idle'}`,
      metadata: { ageMs, scannerStatus },
      checkedAt: now,
    };
  }

  private async checkOpenPositionProtection(now: Date): Promise<HealthCheckResult> {
    // Check how many open live positions exist and whether they have SL set
    try {
      const result = await this.dataSource.query(`
        SELECT
          COUNT(*) FILTER (WHERE engine = 'LIVE' AND is_open = true) AS live_open,
          COUNT(*) FILTER (WHERE engine = 'LIVE' AND is_open = true AND current_sl IS NULL) AS live_no_sl,
          COUNT(*) FILTER (WHERE engine = 'PAPER' AND is_open = true) AS paper_open
        FROM positions
      `);

      const row = result[0] as { live_open: string; live_no_sl: string; paper_open: string };
      const liveOpen = parseInt(row.live_open, 10);
      const liveNoSl = parseInt(row.live_no_sl, 10);
      const paperOpen = parseInt(row.paper_open, 10);

      const healthy = liveNoSl === 0;
      return {
        component: 'position_protection',
        healthy,
        details: healthy
          ? `${liveOpen} live position(s), all protected. ${paperOpen} paper position(s).`
          : `⚠ ${liveNoSl} live position(s) have NO stop-loss set! Requires immediate attention.`,
        metadata: { liveOpen, liveNoSl, paperOpen },
        checkedAt: now,
      };
    } catch (err) {
      return {
        component: 'position_protection',
        healthy: false,
        details: `Could not query positions: ${(err as Error).message}`,
        checkedAt: now,
      };
    }
  }

  private async checkDailyRiskState(now: Date): Promise<HealthCheckResult> {
    const liveState = await this.redisService.get('risk:daily_loss_state:LIVE');
    const paperState = await this.redisService.get('risk:daily_loss_state:PAPER');

    const blockingStates = ['TWO_LOSS_LOCKOUT', 'EMERGENCY_HALT', 'KILL_SWITCH_ACTIVE'];
    const isBlocked = blockingStates.includes(liveState ?? '');
    return {
      component: 'daily_risk_state',
      healthy: !isBlocked,
      details: `LIVE: ${liveState ?? 'NORMAL'}, PAPER: ${paperState ?? 'NORMAL'}`,
      metadata: { liveState, paperState },
      checkedAt: now,
    };
  }

  private async checkSquareOffReadiness(now: Date): Promise<HealthCheckResult> {
    const hourIST = new Date(now.getTime() + 5.5 * 60 * 60 * 1_000).getUTCHours();
    const minuteIST = new Date(now.getTime() + 5.5 * 60 * 60 * 1_000).getUTCMinutes();

    // Only relevant during the 15:10–15:30 IST window
    if (hourIST < 15 || (hourIST === 15 && minuteIST < 10)) {
      return {
        component: 'square_off',
        healthy: true,
        details: 'Square-off window not yet active',
        checkedAt: now,
      };
    }

    // Check for any open live positions after 15:15 IST
    if (hourIST === 15 && minuteIST >= 15) {
      try {
        const result = await this.dataSource.query(
          `SELECT COUNT(*) AS open_count FROM positions WHERE engine = 'LIVE' AND is_open = true`,
        );
        const openCount = parseInt((result[0] as { open_count: string }).open_count, 10);
        const isLate = hourIST === 15 && minuteIST >= 25;

        return {
          component: 'square_off',
          healthy: openCount === 0 || !isLate,
          details:
            openCount > 0
              ? `${openCount} live position(s) still open at ${hourIST}:${String(minuteIST).padStart(2, '0')} IST`
              : 'All positions squared off',
          metadata: { openCount, hourIST, minuteIST },
          checkedAt: now,
        };
      } catch (err) {
        return {
          component: 'square_off',
          healthy: false,
          details: `Square-off check failed: ${(err as Error).message}`,
          checkedAt: now,
        };
      }
    }

    return {
      component: 'square_off',
      healthy: true,
      details: `IST time: ${hourIST}:${String(minuteIST).padStart(2, '0')} — monitoring`,
      checkedAt: now,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Deep Audit
  // ─────────────────────────────────────────────────────────────────────────

  private async gatherDeepAuditIssues(): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];

    // Check for orders stuck in 'pending' for >10 minutes
    try {
      const stalePending = await this.dataSource.query(`
        SELECT COUNT(*) AS cnt
        FROM orders
        WHERE status = 'pending'
          AND engine = 'LIVE'
          AND created_at < NOW() - INTERVAL '10 minutes'
      `);
      const cnt = parseInt((stalePending[0] as { cnt: string }).cnt, 10);
      if (cnt > 0) {
        issues.push({
          issueKey: 'execution:stale_pending_orders',
          severity: 'P1',
          category: 'EXECUTION',
          title: `${cnt} stale pending LIVE order(s) detected`,
          description: `${cnt} LIVE order(s) have been in 'pending' status for >10 minutes without broker confirmation.`,
          source: 'LocalMarketWatchdogService.deepAudit',
          affectedModule: 'ExecutionModule',
          affectsLiveTrading: true,
          affectsPaperTrading: false,
          isSystemic: false,
          requiresHumanApproval: false,
          detectedAt: new Date(),
          reproductionContext: { stalePendingCount: cnt },
        });
      }
    } catch (err) {
      this.logger.warn(`Deep audit stale-orders check failed: ${(err as Error).message}`);
    }

    // Check for strategy performance degradation
    try {
      const stratPerf = await this.dataSource.query(`
        SELECT strategy_id, engine, SUM(total_net_pnl) AS week_pnl, SUM(trades_count) AS trades
        FROM strategy_performance
        WHERE trading_date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY strategy_id, engine
        HAVING SUM(total_net_pnl) < -5000 AND SUM(trades_count) >= 5
      `);
      if ((stratPerf as unknown[]).length > 0) {
        issues.push({
          issueKey: 'strategy:performance_degradation_7d',
          severity: 'P2',
          category: 'TRADING_CORRECTNESS',
          title: 'Strategy performance degradation detected (7-day window)',
          description: `${(stratPerf as unknown[]).length} strategy(ies) have net P&L < -₹5000 over 7 days.`,
          source: 'LocalMarketWatchdogService.deepAudit',
          affectedModule: 'StrategyModule',
          affectsLiveTrading: true,
          affectsPaperTrading: true,
          isSystemic: false,
          requiresHumanApproval: false,
          detectedAt: new Date(),
          reproductionContext: { degradedStrategies: stratPerf },
        });
      }
    } catch (err) {
      this.logger.warn(`Deep audit strategy-perf check failed: ${(err as Error).message}`);
    }

    // Check for data integrity: positions without trades (orphaned)
    try {
      const orphaned = await this.dataSource.query(`
        SELECT COUNT(*) AS cnt
        FROM positions p
        WHERE p.is_open = false
          AND NOT EXISTS (
            SELECT 1 FROM trades t WHERE t.position_id = p.id
          )
          AND p.created_at < NOW() - INTERVAL '1 hour'
      `);
      const cnt = parseInt((orphaned[0] as { cnt: string }).cnt, 10);
      if (cnt > 0) {
        issues.push({
          issueKey: 'data_integrity:orphaned_positions',
          severity: 'P2',
          category: 'DATA_INTEGRITY',
          title: `${cnt} closed position(s) have no trade records`,
          description:
            'Closed positions exist without corresponding trade records — P&L may be incomplete.',
          source: 'LocalMarketWatchdogService.deepAudit',
          affectedModule: 'TradeJournalModule',
          affectsLiveTrading: false,
          affectsPaperTrading: false,
          isSystemic: false,
          requiresHumanApproval: false,
          detectedAt: new Date(),
          reproductionContext: { orphanedCount: cnt },
        });
      }
    } catch (err) {
      this.logger.warn(`Deep audit orphaned-positions check failed: ${(err as Error).message}`);
    }

    return issues;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Issue Persistence
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persist detected issues to the monitoring_issues table.
   * Deduplicates by issue_key — increments occurrence_count on re-detection.
   * Reopens resolved issues that have recurred.
   *
   * Requirements: Phase 16.4 — deduplicate; retain occurrence history
   */
  private async persistIssues(issues: DetectedIssue[]): Promise<void> {
    if (issues.length === 0) return;

    for (const issue of issues) {
      try {
        const existing = await this.issuesRepo.findOne({ where: { issueKey: issue.issueKey } });

        if (existing) {
          // Update existing record
          existing.lastDetectedAt = issue.detectedAt;
          existing.occurrenceCount += 1;
          existing.description = issue.description; // description may gain more context

          // Reopen if previously resolved
          if (existing.status === 'RESOLVED' || existing.status === 'WONT_FIX_WITH_REASON') {
            existing.status = 'REOPENED';
            this.logger.warn(`Issue ${issue.issueKey} has RECURRED — reopened`);
          }

          await this.issuesRepo.save(existing);
        } else {
          // Create new record
          const record = this.issuesRepo.create({
            issueKey: issue.issueKey,
            severity: issue.severity,
            category: issue.category,
            title: issue.title,
            description: issue.description,
            source: issue.source,
            firstDetectedAt: issue.detectedAt,
            lastDetectedAt: issue.detectedAt,
            occurrenceCount: 1,
            affectedModule: issue.affectedModule ?? null,
            affectedInstrument: issue.affectedInstrument ?? null,
            affectedStrategy: issue.affectedStrategy ?? null,
            affectedOrderId: issue.affectedOrderId ?? null,
            reproductionContext: issue.reproductionContext ?? null,
            status: 'DETECTED',
            remediationAttempts: 0,
            affectsLiveTrading: issue.affectsLiveTrading,
            affectsPaperTrading: issue.affectsPaperTrading,
            isSystemic: issue.isSystemic,
            requiresHumanApproval: issue.requiresHumanApproval,
          });
          await this.issuesRepo.save(record);

          // Alert immediately for P0 issues
          if (issue.severity === 'P0' && this.config.p0AlertsEnabled) {
            await this.alertP0Issue(issue);
          }

          this.logger.warn(`New ${issue.severity} issue detected: ${issue.title}`);
        }
      } catch (err) {
        this.logger.error(`Failed to persist issue ${issue.issueKey}: ${(err as Error).message}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get current dashboard data — fast in-memory response.
   *
   * Requirements: Phase 16.10
   */
  async getDashboardData(): Promise<WatchdogDashboardData> {
    const snapshot = this.lastSnapshot;
    const now = new Date();

    // Load issue counts from DB
    const issueCounts = await this.getIssueCounts();
    const recentIssues = await this.getRecentIssues(10);
    const remediationStats = await this.autoRemediation.getStats();

    const components: ComponentHealthSummary[] = snapshot
      ? snapshot.checks.map((c) => ({
          component: c.component,
          status: c.healthy ? 'UP' : ('DOWN' as 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN'),
          latencyMs: c.latencyMs,
          lastCheckedAt: c.checkedAt,
          details: c.details,
        }))
      : [];

    const p0Count = issueCounts.P0;
    const p1Count = issueCounts.P1;
    const overallStatus: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' =
      p0Count > 0 ? 'CRITICAL' : p1Count > 0 ? 'DEGRADED' : 'HEALTHY';

    return {
      overallStatus,
      lastCheckedAt: snapshot?.timestamp ?? now,
      nextCheckAt: new Date(now.getTime() + this.config.healthCheckIntervalMs),
      components,
      issueCounts,
      recentIssues,
      remediationStats,
    };
  }

  /**
   * Query issues from the registry with optional filters.
   *
   * Requirements: Phase 16.4
   */
  async queryIssues(filter: IssueQueryFilter): Promise<MonitoringIssues[]> {
    const qb = this.issuesRepo.createQueryBuilder('issue');

    if (filter.severity) {
      const severities = Array.isArray(filter.severity) ? filter.severity : [filter.severity];
      qb.andWhere('issue.severity IN (:...severities)', { severities });
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      qb.andWhere('issue.status IN (:...statuses)', { statuses });
    }
    if (filter.category) {
      qb.andWhere('issue.category = :category', { category: filter.category });
    }
    if (filter.affectsLiveTrading !== undefined) {
      qb.andWhere('issue.affects_live_trading = :live', { live: filter.affectsLiveTrading });
    }
    if (filter.since) {
      qb.andWhere('issue.first_detected_at >= :since', { since: filter.since });
    }

    qb.orderBy('issue.first_detected_at', 'DESC').limit(filter.limit ?? 100);

    return qb.getMany();
  }

  /**
   * Acknowledge a P0 issue — sets status to INVESTIGATING.
   * Called by the user via the dashboard or API.
   *
   * Requirements: Phase 16.6
   */
  async acknowledgeIssue(issueId: string, notes?: string): Promise<void> {
    const issue = await this.issuesRepo.findOne({ where: { id: issueId } });
    if (!issue) throw new Error(`Issue not found: ${issueId}`);

    issue.status = 'INVESTIGATING';
    if (notes) issue.rootCause = notes;
    await this.issuesRepo.save(issue);

    this.logger.log(`Issue ${issueId} acknowledged (${issue.issueKey})`);
  }

  /**
   * Force a watchdog check right now — useful for testing and after deployments.
   */
  async forceCheck(): Promise<SystemSnapshot> {
    this.skipNextCheck = false;
    await this.runHealthCheck();
    return this.lastSnapshot!;
  }

  /**
   * Returns the number of open (non-resolved) issues by severity.
   */
  async getIssueCounts(): Promise<{ P0: number; P1: number; P2: number; P3: number }> {
    const openStatuses: string[] = [
      'DETECTED',
      'INVESTIGATING',
      'ROOT_CAUSE_IDENTIFIED',
      'FIX_PROPOSED',
      'FIX_IN_PROGRESS',
      'TESTING',
      'REOPENED',
      'REQUIRES_HUMAN_APPROVAL',
    ];

    const results = await this.issuesRepo
      .createQueryBuilder('issue')
      .select('issue.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where('issue.status IN (:...statuses)', { statuses: openStatuses })
      .groupBy('issue.severity')
      .getRawMany<{ severity: string; count: string }>();

    const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const row of results) {
      counts[row.severity as keyof typeof counts] = parseInt(row.count, 10);
    }
    return counts;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private buildSnapshot(checks: HealthCheckResult[], issues: DetectedIssue[]): SystemSnapshot {
    return {
      timestamp: new Date(),
      checks,
      overallHealthy: checks.every((c) => c.healthy),
      issues,
    };
  }

  private async getRecentIssues(limit: number) {
    const issues = await this.issuesRepo.find({
      order: { firstDetectedAt: 'DESC' },
      take: limit,
    });
    return issues.map((i) => ({
      id: i.id,
      issueKey: i.issueKey,
      severity: i.severity,
      title: i.title,
      status: i.status,
      detectedAt: i.firstDetectedAt,
      affectsLiveTrading: i.affectsLiveTrading,
    }));
  }

  private async alertP0Issue(issue: DetectedIssue): Promise<void> {
    try {
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'MAX',
        title: `[P0 WATCHDOG] ${issue.title}`,
        message: issue.description,
        metadata: {
          issueKey: issue.issueKey,
          category: issue.category,
          affectsLiveTrading: issue.affectsLiveTrading,
          source: issue.source,
        },
        createdAt: new Date(),
      });
    } catch (err) {
      this.logger.error(`Failed to publish P0 alert: ${(err as Error).message}`);
    }
  }

  private async publishWatchdogAlert(err: Error): Promise<void> {
    try {
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'CRITICAL',
        title: '[WATCHDOG] Health check repeatedly failing',
        message: `LocalMarketWatchdogService has failed ${this.consecutiveCheckFailures} consecutive checks. Latest error: ${err.message}`,
        metadata: { consecutiveFailures: this.consecutiveCheckFailures },
        createdAt: new Date(),
      });
    } catch {
      // Can't do much if notification itself fails
    }
  }

  /**
   * Expose tracked position IDs for the RedisChannelWiringService.
   * Always returns empty array — this service doesn't track positions directly.
   */
  getTrackedPositionIds(): string[] {
    return [];
  }

  /** Update watchdog configuration at runtime (non-trading config only). */
  updateConfig(partial: Partial<WatchdogConfig>): void {
    this.config = { ...this.config, ...partial };
    this.logger.log(`Watchdog config updated: ${JSON.stringify(partial)}`);
  }
}
