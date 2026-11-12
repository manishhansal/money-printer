/**
 * watchdog.types.ts
 *
 * Type definitions for the LocalMarketWatchdogService and related services.
 *
 * Requirements: Phase 16 — Local Continuous Market Monitoring & Self-Remediation
 */

import {
  IssueSeverity,
  IssueStatus,
  IssueCategory,
} from '../../database/entities/monitoring-issues.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Health Check Results
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthCheckResult {
  component: string;
  healthy: boolean;
  latencyMs?: number;
  details: string;
  metadata?: Record<string, unknown>;
  checkedAt: Date;
}

export interface SystemSnapshot {
  timestamp: Date;
  checks: HealthCheckResult[];
  overallHealthy: boolean;
  issues: DetectedIssue[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw issue detected by a health check before it is classified and persisted.
 */
export interface DetectedIssue {
  /** Stable key for deduplication: usually `{module}:{category}:{shortHash}`. */
  issueKey: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  description: string;
  source: string;
  affectedModule?: string;
  affectedInstrument?: string;
  affectedStrategy?: string;
  affectedOrderId?: string;
  reproductionContext?: Record<string, unknown>;
  affectsLiveTrading: boolean;
  affectsPaperTrading: boolean;
  isSystemic: boolean;
  requiresHumanApproval: boolean;
  detectedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Remediation
// ─────────────────────────────────────────────────────────────────────────────

export interface RemediationPlan {
  issueId: string;
  issueKey: string;
  strategy: 'SAFE_AUTO_FIX' | 'ISOLATED_TEST' | 'HUMAN_APPROVAL_REQUIRED' | 'MONITOR_ONLY';
  description: string;
  steps: RemediationStep[];
  safetyCheck: SafetyCheck;
  estimatedRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface RemediationStep {
  stepId: string;
  description: string;
  type:
    | 'LOG'
    | 'ALERT'
    | 'RESTART_MODULE'
    | 'RUN_TEST'
    | 'UPDATE_CONFIG'
    | 'CLEAR_CACHE'
    | 'REQUEUE'
    | 'MANUAL';
  payload?: Record<string, unknown>;
}

export interface SafetyCheck {
  hasOpenLivePositions: boolean;
  affectsOrderExecution: boolean;
  affectsRiskLimits: boolean;
  affectsStopLoss: boolean;
  affectsSquareOff: boolean;
  isAutoFixSafe: boolean;
  reason: string;
}

export interface RemediationResult {
  issueId: string;
  success: boolean;
  newStatus: IssueStatus;
  evidence: string;
  stepsExecuted: string[];
  error?: string;
  timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Watchdog Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface WatchdogConfig {
  /** Interval in ms for lightweight health checks (default: 30_000). */
  healthCheckIntervalMs: number;
  /** Interval in ms for deep audit checks (default: 300_000 = 5 min). */
  deepAuditIntervalMs: number;
  /** Maximum CPU budget (% of single core) for watchdog operations. */
  maxCpuBudgetPercent: number;
  /** Maximum memory budget (MB) for watchdog state. */
  maxMemoryBudgetMb: number;
  /** Whether auto-remediation is enabled (default: true). */
  autoRemediationEnabled: boolean;
  /** Maximum concurrent remediation attempts. */
  maxConcurrentRemediations: number;
  /** Whether to send real-time alerts for P0 issues. */
  p0AlertsEnabled: boolean;
  /** Whether to suppress notifications during off-market hours. */
  suppressOffMarketAlerts: boolean;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  healthCheckIntervalMs: 30_000,
  deepAuditIntervalMs: 300_000,
  maxCpuBudgetPercent: 5,
  maxMemoryBudgetMb: 128,
  autoRemediationEnabled: true,
  maxConcurrentRemediations: 2,
  p0AlertsEnabled: true,
  suppressOffMarketAlerts: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Watchdog Dashboard Data
// ─────────────────────────────────────────────────────────────────────────────

export interface WatchdogDashboardData {
  overallStatus: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  lastCheckedAt: Date;
  nextCheckAt: Date;
  components: ComponentHealthSummary[];
  issueCounts: { P0: number; P1: number; P2: number; P3: number };
  recentIssues: RecentIssueSummary[];
  remediationStats: RemediationStats;
}

export interface ComponentHealthSummary {
  component: string;
  status: 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
  latencyMs?: number;
  lastCheckedAt: Date;
  details: string;
}

export interface RecentIssueSummary {
  id: string;
  issueKey: string;
  severity: IssueSeverity;
  title: string;
  status: IssueStatus;
  detectedAt: Date;
  affectsLiveTrading: boolean;
}

export interface RemediationStats {
  totalAttempts: number;
  successfulFixes: number;
  failedFixes: number;
  pendingApprovals: number;
  lastResolvedAt: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue Registry Query
// ─────────────────────────────────────────────────────────────────────────────

export interface IssueQueryFilter {
  severity?: IssueSeverity | IssueSeverity[];
  status?: IssueStatus | IssueStatus[];
  category?: IssueCategory;
  affectsLiveTrading?: boolean;
  since?: Date;
  limit?: number;
}
