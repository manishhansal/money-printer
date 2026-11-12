/**
 * watchdog.controller.ts
 *
 * REST API for the monitoring issue registry and watchdog dashboard.
 *
 * Routes:
 *   GET  /watchdog/dashboard      — live system health + issue summary
 *   GET  /watchdog/issues         — query the issue registry
 *   GET  /watchdog/issues/:id     — single issue detail
 *   POST /watchdog/issues/:id/acknowledge  — acknowledge an issue
 *   POST /watchdog/issues/:id/approve-fix  — approve a pending human-approval fix
 *   POST /watchdog/check-now      — trigger an immediate health check
 *
 * Requirements: Phase 16.10, 16.4
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  NotFoundException,
  HttpCode,
} from '@nestjs/common';
import { LocalMarketWatchdogService } from './local-market-watchdog.service';
import { AutoRemediationService } from './auto-remediation.service';
import { IssueStatus, IssueCategory } from '../../database/entities/monitoring-issues.entity';
import { IsOptional, IsString, IsIn, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

class QueryIssuesDto {
  @IsOptional()
  @IsIn(['P0', 'P1', 'P2', 'P3'])
  severity?: 'P0' | 'P1' | 'P2' | 'P3';

  @IsOptional()
  @IsIn([
    'DETECTED',
    'INVESTIGATING',
    'ROOT_CAUSE_IDENTIFIED',
    'FIX_PROPOSED',
    'FIX_IN_PROGRESS',
    'TESTING',
    'RESOLVED',
    'REOPENED',
    'REQUIRES_HUMAN_APPROVAL',
    'WONT_FIX_WITH_REASON',
  ])
  status?: IssueStatus;

  @IsOptional()
  @IsIn([
    'FINANCIAL_SAFETY',
    'TRADING_CORRECTNESS',
    'DATA_INTEGRITY',
    'MARKET_DATA',
    'EXECUTION',
    'POSITION_MANAGEMENT',
    'RISK_MANAGEMENT',
    'INFRASTRUCTURE',
    'PERFORMANCE',
    'FRONTEND',
    'LOGGING',
    'CONFIGURATION',
    'UNKNOWN',
  ])
  category?: IssueCategory;

  @IsOptional()
  @Transform(({ value }: { value: string }) => value === 'true')
  @IsBoolean()
  affectsLiveTrading?: boolean;

  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value as string, 10))
  limit?: number;
}

class AcknowledgeIssueDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

@Controller('watchdog')
export class WatchdogController {
  constructor(
    private readonly watchdog: LocalMarketWatchdogService,
    private readonly remediation: AutoRemediationService,
  ) {}

  /**
   * GET /watchdog/dashboard
   * Live system health + issue summary for the monitoring panel.
   */
  @Get('dashboard')
  async getDashboard() {
    return this.watchdog.getDashboardData();
  }

  /**
   * GET /watchdog/issues
   * Query the issue registry with optional filters.
   */
  @Get('issues')
  async getIssues(@Query() filter: QueryIssuesDto) {
    return this.watchdog.queryIssues(filter);
  }

  /**
   * GET /watchdog/issues/counts
   * Open issue counts by severity.
   */
  @Get('issues/counts')
  async getIssueCounts() {
    return this.watchdog.getIssueCounts();
  }

  /**
   * POST /watchdog/issues/:id/acknowledge
   * Acknowledge an issue — transitions to INVESTIGATING.
   */
  @Post('issues/:id/acknowledge')
  @HttpCode(200)
  async acknowledgeIssue(@Param('id') id: string, @Body() body: AcknowledgeIssueDto) {
    try {
      await this.watchdog.acknowledgeIssue(id, body.notes);
      return { success: true, message: `Issue ${id} acknowledged` };
    } catch (err) {
      throw new NotFoundException((err as Error).message);
    }
  }

  /**
   * POST /watchdog/issues/:id/approve-fix
   * Approve a human-approval-required fix and execute it.
   */
  @Post('issues/:id/approve-fix')
  @HttpCode(200)
  async approveFix(@Param('id') id: string) {
    const result = await this.remediation.approveAndExecute(id);
    return result;
  }

  /**
   * POST /watchdog/check-now
   * Trigger an immediate health check outside the 30s cron window.
   */
  @Post('check-now')
  @HttpCode(200)
  async triggerCheck() {
    const snapshot = await this.watchdog.forceCheck();
    return {
      timestamp: snapshot.timestamp,
      overallHealthy: snapshot.overallHealthy,
      checksRun: snapshot.checks.length,
      issuesDetected: snapshot.issues.length,
      components: snapshot.checks.map((c) => ({
        component: c.component,
        healthy: c.healthy,
        details: c.details,
      })),
    };
  }

  /**
   * GET /watchdog/stats
   * Remediation statistics.
   */
  @Get('stats')
  async getStats() {
    return this.remediation.getStats();
  }
}
