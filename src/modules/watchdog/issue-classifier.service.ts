/**
 * issue-classifier.service.ts
 *
 * IssueClassifierService — translates raw HealthCheckResult[] into
 * typed DetectedIssue[] that can be persisted and routed to the
 * AutoRemediationService.
 *
 * Classification rules:
 *   - Backend down or PostgreSQL down → P0 INFRASTRUCTURE
 *   - Live position without SL → P0 FINANCIAL_SAFETY
 *   - Square-off past 15:25 IST with open positions → P0 FINANCIAL_SAFETY
 *   - Redis down → P1 INFRASTRUCTURE
 *   - Dhan API connectivity issue → P1 EXECUTION
 *   - Market data stale during market hours → P1 MARKET_DATA
 *   - Signal scanner stuck → P2 TRADING_CORRECTNESS
 *   - Options chain stale → P2 MARKET_DATA
 *   - Instrument master stale → P2 DATA_INTEGRITY
 *   - Risk state blocking entries → INFO (not an issue, expected behavior)
 *
 * Requirements: Phase 16.5 — automatic issue classification
 */

import { Injectable, Logger } from '@nestjs/common';
import { HealthCheckResult, DetectedIssue } from './watchdog.types';

@Injectable()
export class IssueClassifierService {
  private readonly logger = new Logger(IssueClassifierService.name);

  /**
   * Analyze a set of health check results and return classified DetectedIssue[].
   * Only failing checks produce issues — healthy checks produce nothing.
   */
  async analyzeChecks(checks: HealthCheckResult[]): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];
    const now = new Date();

    for (const check of checks) {
      if (check.healthy) continue; // No issue — component is healthy

      const issue = this.classifyCheck(check, now);
      if (issue) {
        issues.push(issue);
        this.logger.debug(`Classified ${check.component} as ${issue.severity}: ${issue.title}`);
      }
    }

    return issues;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Classification rules
  // ─────────────────────────────────────────────────────────────────────────

  private classifyCheck(check: HealthCheckResult, now: Date): DetectedIssue | null {
    switch (check.component) {
      case 'backend':
        return this.classifyBackendIssue(check, now);
      case 'redis':
        return this.classifyRedisIssue(check, now);
      case 'postgresql':
        return this.classifyPostgresIssue(check, now);
      case 'dhan_api':
        return this.classifyDhanIssue(check, now);
      case 'market_data':
        return this.classifyMarketDataIssue(check, now);
      case 'instrument_master':
        return this.classifyInstrumentMasterIssue(check, now);
      case 'options_chain':
        return this.classifyOptionsChainIssue(check, now);
      case 'signal_scanner':
        return this.classifySignalScannerIssue(check, now);
      case 'position_protection':
        return this.classifyPositionProtectionIssue(check, now);
      case 'daily_risk_state':
        return this.classifyRiskStateIssue(check, now);
      case 'square_off':
        return this.classifySquareOffIssue(check, now);
      default:
        return this.classifyUnknownIssue(check, now);
    }
  }

  private classifyBackendIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    return {
      issueKey: `infrastructure:backend_degraded`,
      severity: 'P1',
      category: 'INFRASTRUCTURE',
      title: 'Backend component degraded',
      description: check.details,
      source: `WatchdogHealthCheck:${check.component}`,
      affectedModule: 'DhanModule',
      affectsLiveTrading: true,
      affectsPaperTrading: false,
      isSystemic: false,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }

  private classifyRedisIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    return {
      issueKey: 'infrastructure:redis_unavailable',
      severity: 'P1',
      category: 'INFRASTRUCTURE',
      title: 'Redis unavailable',
      description: `Redis health check failed: ${check.details}. Idempotency keys, session state, and pub/sub channels are degraded.`,
      source: `WatchdogHealthCheck:redis`,
      affectedModule: 'RedisModule',
      affectsLiveTrading: true,
      affectsPaperTrading: true,
      isSystemic: true,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: { latencyMs: check.latencyMs, ...check.metadata },
    };
  }

  private classifyPostgresIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    return {
      issueKey: 'infrastructure:postgresql_unavailable',
      severity: 'P0',
      category: 'INFRASTRUCTURE',
      title: 'PostgreSQL unavailable — all trading halted',
      description: `PostgreSQL health check failed: ${check.details}. Order persistence, position tracking, and risk records are unavailable.`,
      source: `WatchdogHealthCheck:postgresql`,
      affectedModule: 'TypeOrmModule',
      affectsLiveTrading: true,
      affectsPaperTrading: true,
      isSystemic: true,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: { latencyMs: check.latencyMs },
    };
  }

  private classifyDhanIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    const isStale = check.details.includes('stale');
    return {
      issueKey: isStale ? 'execution:dhan_health_check_stale' : 'execution:dhan_connectivity_down',
      severity: isStale ? 'P2' : 'P1',
      category: 'EXECUTION',
      title: isStale
        ? 'Dhan connectivity health check is stale'
        : 'Dhan API connectivity issue detected',
      description: check.details,
      source: `WatchdogHealthCheck:dhan_api`,
      affectedModule: 'DhanModule',
      affectsLiveTrading: true,
      affectsPaperTrading: false,
      isSystemic: false,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }

  private classifyMarketDataIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    // Only a real issue during market hours (09:15–15:30 IST)
    const hourIST = new Date(now.getTime() + 5.5 * 60 * 60 * 1_000).getUTCHours();
    const isMarketHours = hourIST >= 9 && hourIST < 16;
    const severity = isMarketHours ? 'P1' : 'P3';

    return {
      issueKey: 'market_data:feed_stale',
      severity,
      category: 'MARKET_DATA',
      title: 'Market data feed is stale',
      description: check.details,
      source: `WatchdogHealthCheck:market_data`,
      affectedModule: 'MarketDataModule',
      affectsLiveTrading: true,
      affectsPaperTrading: true,
      isSystemic: false,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }

  private classifyInstrumentMasterIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    return {
      issueKey: 'data_integrity:instrument_master_stale',
      severity: 'P2',
      category: 'DATA_INTEGRITY',
      title: 'Instrument master data is stale',
      description: check.details,
      source: `WatchdogHealthCheck:instrument_master`,
      affectedModule: 'InstrumentDiscoveryModule',
      affectsLiveTrading: true,
      affectsPaperTrading: true,
      isSystemic: false,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }

  private classifyOptionsChainIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    return {
      issueKey: 'market_data:options_chain_stale',
      severity: 'P2',
      category: 'MARKET_DATA',
      title: 'Options chain data is stale',
      description: check.details,
      source: `WatchdogHealthCheck:options_chain`,
      affectedModule: 'OptionsIntelligenceModule',
      affectsLiveTrading: true,
      affectsPaperTrading: true,
      isSystemic: false,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }

  private classifySignalScannerIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    return {
      issueKey: 'trading_correctness:scanner_stuck',
      severity: 'P2',
      category: 'TRADING_CORRECTNESS',
      title: 'Signal scanner appears to be stuck',
      description: check.details,
      source: `WatchdogHealthCheck:signal_scanner`,
      affectedModule: 'SignalScannerModule',
      affectsLiveTrading: true,
      affectsPaperTrading: true,
      isSystemic: false,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }

  private classifyPositionProtectionIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    // Live position without SL is P0 — financial safety risk
    return {
      issueKey: 'financial_safety:position_no_stop_loss',
      severity: 'P0',
      category: 'FINANCIAL_SAFETY',
      title: 'Live position(s) detected without stop-loss protection',
      description: check.details,
      source: `WatchdogHealthCheck:position_protection`,
      affectedModule: 'PositionMonitoringModule',
      affectsLiveTrading: true,
      affectsPaperTrading: false,
      isSystemic: false,
      requiresHumanApproval: true, // Always require approval for SL changes
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }

  private classifyRiskStateIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    // Risk state blocking entries is not an issue per se — it's correct behavior.
    // Log it as P3 informational if it looks unexpected.
    return {
      issueKey: 'risk_management:blocking_state_active',
      severity: 'P3',
      category: 'RISK_MANAGEMENT',
      title: 'Risk state is blocking new entries',
      description: check.details,
      source: `WatchdogHealthCheck:daily_risk_state`,
      affectedModule: 'RiskManagementModule',
      affectsLiveTrading: true,
      affectsPaperTrading: false,
      isSystemic: false,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }

  private classifySquareOffIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    // Late unresolved square-off is P0
    const meta = check.metadata as Record<string, number> | undefined;
    const minuteIST = meta?.minuteIST ?? 0;
    const severity = minuteIST >= 25 ? 'P0' : 'P1';

    return {
      issueKey: 'financial_safety:square_off_incomplete',
      severity,
      category: 'FINANCIAL_SAFETY',
      title: `Square-off incomplete — open positions past ${minuteIST >= 25 ? '15:25' : '15:15'} IST`,
      description: check.details,
      source: `WatchdogHealthCheck:square_off`,
      affectedModule: 'LiveTradingModule',
      affectsLiveTrading: true,
      affectsPaperTrading: false,
      isSystemic: false,
      requiresHumanApproval: severity === 'P0',
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }

  private classifyUnknownIssue(check: HealthCheckResult, now: Date): DetectedIssue {
    return {
      issueKey: `unknown:${check.component}_health_failure`,
      severity: 'P2',
      category: 'UNKNOWN',
      title: `Health check failed: ${check.component}`,
      description: check.details,
      source: `WatchdogHealthCheck:${check.component}`,
      affectedModule: check.component,
      affectsLiveTrading: false,
      affectsPaperTrading: false,
      isSystemic: false,
      requiresHumanApproval: false,
      detectedAt: now,
      reproductionContext: check.metadata,
    };
  }
}
