/**
 * monitoring-issues.entity.ts
 *
 * Persistent issue registry for the LocalMarketWatchdogService.
 *
 * Every issue detected by the watchdog is stored here with full provenance,
 * severity, remediation history, and resolution evidence.
 *
 * Requirements: Phase 16.4 — persistent local issue registry
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Issue severity levels (P0 = most critical). */
export type IssueSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/** Issue lifecycle status. */
export type IssueStatus =
  | 'DETECTED'
  | 'INVESTIGATING'
  | 'ROOT_CAUSE_IDENTIFIED'
  | 'FIX_PROPOSED'
  | 'FIX_IN_PROGRESS'
  | 'TESTING'
  | 'RESOLVED'
  | 'REOPENED'
  | 'REQUIRES_HUMAN_APPROVAL'
  | 'WONT_FIX_WITH_REASON';

/** Broad category for routing and display. */
export type IssueCategory =
  | 'FINANCIAL_SAFETY'
  | 'TRADING_CORRECTNESS'
  | 'DATA_INTEGRITY'
  | 'MARKET_DATA'
  | 'EXECUTION'
  | 'POSITION_MANAGEMENT'
  | 'RISK_MANAGEMENT'
  | 'INFRASTRUCTURE'
  | 'PERFORMANCE'
  | 'FRONTEND'
  | 'LOGGING'
  | 'CONFIGURATION'
  | 'UNKNOWN';

@Entity({ name: 'monitoring_issues' })
@Index('idx_monitoring_issues_severity_status', ['severity', 'status'])
@Index('idx_monitoring_issues_first_detected', ['firstDetectedAt'])
@Index('idx_monitoring_issues_issue_key', ['issueKey'], { unique: true })
export class MonitoringIssues {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Stable deduplication key — constructed from module + category + hash of description.
   * When a new occurrence matches an existing issue_key, occurrence_count is incremented
   * rather than creating a new row.
   */
  @Column({ name: 'issue_key', type: 'varchar', unique: true })
  issueKey!: string;

  @Column({ name: 'severity', type: 'varchar', length: 3 })
  severity!: IssueSeverity;

  @Column({ name: 'category', type: 'varchar' })
  category!: IssueCategory;

  @Column({ name: 'title', type: 'varchar' })
  title!: string;

  @Column({ name: 'description', type: 'text' })
  description!: string;

  /** Service, cron job, or external system that first reported this issue. */
  @Column({ name: 'source', type: 'varchar' })
  source!: string;

  @Column({ name: 'first_detected_at', type: 'timestamp with time zone' })
  firstDetectedAt!: Date;

  @Column({ name: 'last_detected_at', type: 'timestamp with time zone' })
  lastDetectedAt!: Date;

  @Column({ name: 'occurrence_count', type: 'integer', default: 1 })
  occurrenceCount!: number;

  /** NestJS module or service where the issue originated. */
  @Column({ name: 'affected_module', type: 'varchar', nullable: true })
  affectedModule!: string | null;

  /** Instrument security ID, if relevant. */
  @Column({ name: 'affected_instrument', type: 'varchar', nullable: true })
  affectedInstrument!: string | null;

  /** Strategy code (A–H), if relevant. */
  @Column({ name: 'affected_strategy', type: 'varchar', nullable: true })
  affectedStrategy!: string | null;

  /** DB order UUID, if relevant. */
  @Column({ name: 'affected_order_id', type: 'uuid', nullable: true })
  affectedOrderId!: string | null;

  /**
   * JSON snapshot of relevant state at detection time.
   * Used by the auto-remediation engine to reproduce the issue.
   * Never contains secrets, tokens, or PII.
   */
  @Column({ name: 'reproduction_context', type: 'jsonb', nullable: true })
  reproductionContext!: Record<string, unknown> | null;

  /** Root cause analysis text, written by the auto-remediation engine or manually. */
  @Column({ name: 'root_cause', type: 'text', nullable: true })
  rootCause!: string | null;

  /** Proposed fix description. */
  @Column({ name: 'proposed_fix', type: 'text', nullable: true })
  proposedFix!: string | null;

  @Column({ name: 'status', type: 'varchar', default: 'DETECTED' })
  status!: IssueStatus;

  /** Number of auto-remediation attempts made. */
  @Column({ name: 'remediation_attempts', type: 'integer', default: 0 })
  remediationAttempts!: number;

  /** Test outcome after the latest remediation attempt. */
  @Column({ name: 'test_status', type: 'varchar', nullable: true })
  testStatus!: string | null;

  /** Whether this issue affects live trading (drives urgency). */
  @Column({ name: 'affects_live_trading', type: 'boolean', default: false })
  affectsLiveTrading!: boolean;

  /** Whether this issue affects paper trading. */
  @Column({ name: 'affects_paper_trading', type: 'boolean', default: false })
  affectsPaperTrading!: boolean;

  /** Whether the issue is isolated to one component or system-wide. */
  @Column({ name: 'is_systemic', type: 'boolean', default: false })
  isSystemic!: boolean;

  /** Whether this issue requires explicit human approval before the fix is applied. */
  @Column({ name: 'requires_human_approval', type: 'boolean', default: false })
  requiresHumanApproval!: boolean;

  @Column({ name: 'resolution_timestamp', type: 'timestamp with time zone', nullable: true })
  resolutionTimestamp!: Date | null;

  /** Evidence that the issue is resolved (test output, health check results, etc.). */
  @Column({ name: 'resolution_evidence', type: 'text', nullable: true })
  resolutionEvidence!: string | null;

  /** Human-readable reason when status is WONT_FIX_WITH_REASON. */
  @Column({ name: 'wont_fix_reason', type: 'text', nullable: true })
  wontFixReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt!: Date;
}
