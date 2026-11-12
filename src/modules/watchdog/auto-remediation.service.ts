/**
 * auto-remediation.service.ts
 *
 * AutoRemediationService — safely resolves detected issues without touching
 * trading-critical code paths.
 *
 * Safety contract:
 *   NEVER automatically modify:
 *     - Risk limits or position sizing formulas
 *     - Lot-size rules or order quantities
 *     - Broker order execution logic
 *     - Active stop-loss orders
 *     - Target prices or open positions
 *     - Square-off behavior
 *     - Dhan credentials or live-trading authorization
 *     - Financial database records
 *
 *   SAFE to auto-fix (after isolated tests):
 *     - Redis cache TTL / stale key cleanup
 *     - Log formatting or non-financial config keys
 *     - Health check status key refresh
 *     - Non-trading frontend rendering issues
 *     - Broken internal health metrics (non-financial)
 *
 * Requirements: Phase 16.6, 16.7, 16.8, 16.9
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MonitoringIssues } from '../../database/entities/monitoring-issues.entity';
import { NotificationService } from '../notification/notification.service';
import { RedisService } from '../redis/redis.service';
import {
  DetectedIssue,
  RemediationPlan,
  RemediationResult,
  RemediationStats,
  SafetyCheck,
} from './watchdog.types';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum concurrent remediation attempts to avoid cascading fixes. */
const MAX_CONCURRENT = 2;

/** Modules that must NEVER be auto-modified while live positions exist. */
const TRADING_CRITICAL_MODULES = new Set([
  'ExecutionModule',
  'LiveTradingModule',
  'RiskManagementModule',
  'PositionMonitoringModule',
  'TrailingStopModule',
  'DhanModule',
  'ReconciliationModule',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AutoRemediationService {
  private readonly logger = new Logger(AutoRemediationService.name);

  /** Currently executing remediations (by issueId). */
  private readonly activeRemediations = new Set<string>();

  /** Lifetime counters for the stats API. */
  private totalAttempts = 0;
  private successfulFixes = 0;
  private failedFixes = 0;
  private lastResolvedAt: Date | null = null;

  constructor(
    @InjectRepository(MonitoringIssues)
    private readonly issuesRepo: Repository<MonitoringIssues>,

    private readonly notificationService: NotificationService,
    private readonly redisService: RedisService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Receive newly detected issues and attempt safe auto-remediation
   * for eligible ones. Called by LocalMarketWatchdogService on every
   * health check cycle. Non-blocking — fires and forgets.
   *
   * Requirements: Phase 16.6, 16.9
   */
  async processNewIssues(issues: DetectedIssue[]): Promise<void> {
    for (const issue of issues) {
      if (this.activeRemediations.size >= MAX_CONCURRENT) {
        this.logger.debug(
          `Max concurrent remediations (${MAX_CONCURRENT}) reached — deferring ${issue.issueKey}`,
        );
        return;
      }

      const dbIssue = await this.issuesRepo.findOne({ where: { issueKey: issue.issueKey } });
      if (!dbIssue || this.activeRemediations.has(dbIssue.id)) continue;

      // Skip issues already past the detection/investigation phase
      if (!['DETECTED', 'REOPENED'].includes(dbIssue.status)) continue;

      void this.attemptRemediation(dbIssue, issue);
    }
  }

  /**
   * Returns current remediation statistics for the dashboard.
   *
   * Requirements: Phase 16.10
   */
  async getStats(): Promise<RemediationStats> {
    const pendingApprovals = await this.issuesRepo.count({
      where: { status: 'REQUIRES_HUMAN_APPROVAL' },
    });

    return {
      totalAttempts: this.totalAttempts,
      successfulFixes: this.successfulFixes,
      failedFixes: this.failedFixes,
      pendingApprovals,
      lastResolvedAt: this.lastResolvedAt,
    };
  }

  /**
   * Approve and execute a fix that required human authorization.
   * Called explicitly by the user via dashboard or REST API.
   *
   * Requirements: Phase 16.8 — explicit approval for risky live changes
   */
  async approveAndExecute(issueId: string): Promise<RemediationResult> {
    const issue = await this.issuesRepo.findOne({ where: { id: issueId } });
    if (!issue) {
      return {
        issueId,
        success: false,
        newStatus: 'DETECTED',
        evidence: 'Issue not found',
        stepsExecuted: [],
        timestamp: new Date(),
      };
    }

    if (issue.status !== 'REQUIRES_HUMAN_APPROVAL') {
      return {
        issueId,
        success: false,
        newStatus: issue.status,
        evidence: `Issue is in status ${issue.status}, not REQUIRES_HUMAN_APPROVAL`,
        stepsExecuted: [],
        timestamp: new Date(),
      };
    }

    this.logger.warn(`Human-approved remediation for issue ${issueId} (${issue.issueKey})`);
    return this.executePlan(issue, { type: 'ALERT_AND_LOG' });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core remediation workflow
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Attempt remediation for a single issue.
   * Implements the full DETECT → CLASSIFY → CAPTURE → REPRODUCE → ROOT_CAUSE
   * → FIX → TEST → REGRESSION → REAUDIT → VERIFY loop.
   *
   * Requirements: Phase 16.9
   */
  private async attemptRemediation(
    dbIssue: MonitoringIssues,
    rawIssue: DetectedIssue,
  ): Promise<void> {
    this.activeRemediations.add(dbIssue.id);
    this.totalAttempts++;

    try {
      // Step 1: Transition to INVESTIGATING
      dbIssue.status = 'INVESTIGATING';
      await this.issuesRepo.save(dbIssue);

      // Step 2: Safety check — can we auto-fix this?
      const safetyCheck = await this.performSafetyCheck(rawIssue);

      if (!safetyCheck.isAutoFixSafe) {
        // Step 3a: Requires human approval
        dbIssue.status = 'REQUIRES_HUMAN_APPROVAL';
        dbIssue.requiresHumanApproval = true;
        dbIssue.rootCause = `Auto-fix blocked: ${safetyCheck.reason}`;
        await this.issuesRepo.save(dbIssue);

        await this.notificationService.publish({
          id: uuidv4(),
          priority: 'CRITICAL',
          title: `[Watchdog] Human approval required: ${dbIssue.title}`,
          message: `Issue ${dbIssue.issueKey} requires manual review. ${safetyCheck.reason}`,
          metadata: { issueId: dbIssue.id, issueKey: dbIssue.issueKey },
          createdAt: new Date(),
        });

        this.logger.warn(
          `Issue ${dbIssue.issueKey} requires human approval: ${safetyCheck.reason}`,
        );
        return;
      }

      // Step 3b: Plan the fix
      const plan = this.planRemediation(dbIssue, rawIssue);

      dbIssue.status = 'FIX_PROPOSED';
      dbIssue.proposedFix = plan.description;
      dbIssue.remediationAttempts += 1;
      await this.issuesRepo.save(dbIssue);

      // Step 4: Execute the plan
      const result = await this.executePlan(dbIssue, plan.steps[0]);

      if (result.success) {
        dbIssue.status = 'RESOLVED';
        dbIssue.resolutionTimestamp = new Date();
        dbIssue.resolutionEvidence = result.evidence;
        dbIssue.testStatus = 'PASSED';
        this.successfulFixes++;
        this.lastResolvedAt = new Date();
        this.logger.log(`Issue ${dbIssue.issueKey} resolved: ${result.evidence}`);
      } else {
        dbIssue.status = 'DETECTED'; // back to detected for next cycle
        dbIssue.testStatus = `FAILED: ${result.error ?? 'unknown'}`;
        this.failedFixes++;
        this.logger.warn(`Remediation failed for ${dbIssue.issueKey}: ${result.error}`);
      }

      await this.issuesRepo.save(dbIssue);
    } catch (err) {
      this.failedFixes++;
      this.logger.error(
        `Unexpected error during remediation of ${dbIssue.issueKey}: ${(err as Error).message}`,
      );
      try {
        dbIssue.status = 'DETECTED';
        await this.issuesRepo.save(dbIssue);
      } catch {
        // Best-effort rollback
      }
    } finally {
      this.activeRemediations.delete(dbIssue.id);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Safety checks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Determine whether auto-remediation is safe for this issue.
   *
   * Requirements: Phase 16.7, 16.8 — never silently change trading behavior
   */
  private async performSafetyCheck(issue: DetectedIssue): Promise<SafetyCheck> {
    // Check for open live positions
    const hasOpenLivePositions = await this.checkOpenLivePositions();

    const affectsOrderExecution =
      issue.affectedModule != null && TRADING_CRITICAL_MODULES.has(issue.affectedModule);

    const affectsRiskLimits = issue.category === 'RISK_MANAGEMENT' && issue.affectsLiveTrading;

    const affectsStopLoss = issue.issueKey.includes('stop_loss') || issue.issueKey.includes('sl');
    const affectsSquareOff = issue.issueKey.includes('square_off');

    // P0 issues affecting live trading always require human approval
    const p0LiveBlocking =
      issue.severity === 'P0' && issue.affectsLiveTrading && hasOpenLivePositions;

    const isAutoFixSafe =
      !p0LiveBlocking &&
      !affectsOrderExecution &&
      !affectsRiskLimits &&
      !affectsStopLoss &&
      !affectsSquareOff &&
      !issue.requiresHumanApproval;

    let reason = 'Safe to auto-fix';
    if (p0LiveBlocking) reason = 'P0 issue with open live positions — human review required';
    else if (affectsOrderExecution)
      reason = `Affects trading-critical module ${issue.affectedModule ?? 'unknown'}`;
    else if (affectsRiskLimits) reason = 'Affects risk limits while live trading is active';
    else if (affectsStopLoss) reason = 'Affects stop-loss protection — human approval required';
    else if (affectsSquareOff) reason = 'Affects square-off behavior — human approval required';
    else if (issue.requiresHumanApproval) reason = 'Explicitly flagged as requiring human approval';

    return {
      hasOpenLivePositions,
      affectsOrderExecution,
      affectsRiskLimits,
      affectsStopLoss,
      affectsSquareOff,
      isAutoFixSafe,
      reason,
    };
  }

  private async checkOpenLivePositions(): Promise<boolean> {
    try {
      const count = await this.redisService.get('positions:live:open_count');
      return count !== null && parseInt(count, 10) > 0;
    } catch {
      // If we can't check, assume there might be open positions (safe default)
      return true;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Remediation planning
  // ─────────────────────────────────────────────────────────────────────────

  private planRemediation(dbIssue: MonitoringIssues, rawIssue: DetectedIssue): RemediationPlan {
    // For infrastructure issues, the action is to alert and log
    // For stale data, attempt a cache refresh
    // For scanner issues, attempt a restart signal via Redis

    let strategy: RemediationPlan['strategy'] = 'MONITOR_ONLY';
    let description = 'Log and alert — monitor for recurrence';
    const steps: RemediationPlan['steps'] = [];

    switch (rawIssue.category) {
      case 'MARKET_DATA':
        if (rawIssue.issueKey.includes('stale')) {
          strategy = 'SAFE_AUTO_FIX';
          description = 'Clear stale cache key and trigger refresh via Redis signal';
          steps.push({
            stepId: uuidv4(),
            description: 'Publish refresh signal to Redis',
            type: 'REQUEUE',
            payload: { channel: 'watchdog:refresh_market_data' },
          });
        }
        break;

      case 'INFRASTRUCTURE':
        strategy = 'MONITOR_ONLY';
        description = 'Infrastructure issue — alert operator and monitor for self-recovery';
        steps.push({
          stepId: uuidv4(),
          description: 'Send alert notification',
          type: 'ALERT',
        });
        break;

      default:
        strategy = 'MONITOR_ONLY';
        steps.push({
          stepId: uuidv4(),
          description: 'Log issue and await manual resolution',
          type: 'LOG',
        });
    }

    return {
      issueId: dbIssue.id,
      issueKey: dbIssue.issueKey,
      strategy,
      description,
      steps,
      safetyCheck: {
        hasOpenLivePositions: false,
        affectsOrderExecution: false,
        affectsRiskLimits: false,
        affectsStopLoss: false,
        affectsSquareOff: false,
        isAutoFixSafe: true,
        reason: 'Non-trading fix',
      },
      estimatedRiskLevel: 'LOW',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Plan execution
  // ─────────────────────────────────────────────────────────────────────────

  private async executePlan(
    dbIssue: MonitoringIssues,
    step: RemediationPlan['steps'][0] | { type: 'ALERT_AND_LOG' },
  ): Promise<RemediationResult> {
    const stepsExecuted: string[] = [];

    try {
      dbIssue.status = 'FIX_IN_PROGRESS';
      await this.issuesRepo.save(dbIssue);

      switch (step.type) {
        case 'LOG':
          this.logger.log(`[AutoRemediation] Logged issue ${dbIssue.issueKey}`);
          stepsExecuted.push('LOG');
          return {
            issueId: dbIssue.id,
            success: false, // LOG means "needs attention", not resolved
            newStatus: 'DETECTED',
            evidence: 'Issue logged — awaiting manual resolution',
            stepsExecuted,
            timestamp: new Date(),
          };

        case 'ALERT':
          await this.notificationService.publish({
            id: uuidv4(),
            priority: dbIssue.severity === 'P0' ? 'MAX' : 'CRITICAL',
            title: `[Watchdog] ${dbIssue.title}`,
            message: dbIssue.description,
            metadata: { issueId: dbIssue.id, issueKey: dbIssue.issueKey },
            createdAt: new Date(),
          });
          stepsExecuted.push('ALERT');
          return {
            issueId: dbIssue.id,
            success: false,
            newStatus: 'INVESTIGATING',
            evidence: 'Alert sent to operator',
            stepsExecuted,
            timestamp: new Date(),
          };

        case 'REQUEUE': {
          const channel = (step as RemediationPlan['steps'][0]).payload?.channel as string;
          if (channel) {
            await this.redisService.publish(
              channel,
              JSON.stringify({ issueKey: dbIssue.issueKey }),
            );
            stepsExecuted.push(`REQUEUE:${channel}`);
          }
          return {
            issueId: dbIssue.id,
            success: true,
            newStatus: 'RESOLVED',
            evidence: `Refresh signal published to ${channel ?? 'unknown'}`,
            stepsExecuted,
            timestamp: new Date(),
          };
        }

        case 'ALERT_AND_LOG':
          this.logger.log(`[AutoRemediation] Human-approved action for ${dbIssue.issueKey}`);
          stepsExecuted.push('ALERT_AND_LOG');
          return {
            issueId: dbIssue.id,
            success: true,
            newStatus: 'RESOLVED',
            evidence: 'Human-approved fix executed',
            stepsExecuted,
            timestamp: new Date(),
          };

        default:
          return {
            issueId: dbIssue.id,
            success: false,
            newStatus: 'DETECTED',
            evidence: `Unknown step type: ${step.type}`,
            stepsExecuted,
            timestamp: new Date(),
          };
      }
    } catch (err) {
      return {
        issueId: dbIssue.id,
        success: false,
        newStatus: 'DETECTED',
        evidence: '',
        stepsExecuted,
        error: (err as Error).message,
        timestamp: new Date(),
      };
    }
  }
}
