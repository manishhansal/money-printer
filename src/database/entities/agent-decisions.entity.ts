/**
 * agent-decisions.entity.ts
 *
 * Persistent store for multi-agent research decisions.
 *
 * Every ResearchDecision produced by AgentOrchestratorService is stored here.
 * Records are immutable (append-only) — outcome settlement updates the
 * resolution_* columns only, never the original decision columns.
 *
 * Key invariants:
 *   - workflow_id is unique: one record per research run
 *   - All prices and quantities come from verified MoneyPrinter services
 *   - LLM-generated content is stored in JSONB, never used for order execution
 *   - Future leakage is prevented by snapshot_at timestamp enforcement
 *
 * Requirements: Phase 11
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** What the portfolio manager recommended. */
export type AgentVerdict = 'EXECUTE' | 'SKIP' | 'PAPER_ONLY';

/** Actual trade outcome (populated after position close). */
export type DecisionOutcome =
  'PENDING' | 'PROFITABLE' | 'LOSS' | 'BREAKEVEN' | 'NOT_EXECUTED' | 'INVALIDATED';

@Entity({ name: 'agent_decisions' })
@Index('idx_agent_decisions_underlying_snapshot', ['underlying', 'snapshotAt'])
@Index('idx_agent_decisions_verdict_outcome', ['finalVerdict', 'outcome'])
export class AgentDecisions {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Unique workflow run ID from AgentOrchestratorService.
   * Used for correlation with logs and notification alerts.
   */
  @Column({ name: 'workflow_id', type: 'uuid', unique: true })
  workflowId!: string;

  /** Underlying instrument analyzed (e.g. "NIFTY", "BANKNIFTY"). */
  @Column({ name: 'underlying', type: 'varchar' })
  underlying!: string;

  /** Timestamp of the market data snapshot used for this decision. */
  @Column({ name: 'snapshot_at', type: 'timestamp with time zone' })
  snapshotAt!: Date;

  /** When the full workflow completed. */
  @Column({ name: 'completed_at', type: 'timestamp with time zone' })
  completedAt!: Date;

  /** Total workflow duration in milliseconds. */
  @Column({ name: 'workflow_duration_ms', type: 'integer' })
  workflowDurationMs!: number;

  /**
   * Verified market context snapshot at decision time.
   * Stored as JSONB — all values sourced from MoneyPrinter services.
   * NOT from LLM output.
   */
  @Column({ name: 'market_context', type: 'jsonb' })
  marketContext!: Record<string, unknown>;

  /** Consensus direction from Research Manager. */
  @Column({ name: 'consensus_direction', type: 'varchar' })
  consensusDirection!: string;

  /** Consensus confidence from Research Manager. */
  @Column({ name: 'consensus_confidence', type: 'varchar' })
  consensusConfidence!: string;

  /** Final portfolio manager verdict. */
  @Column({ name: 'final_verdict', type: 'varchar' })
  finalVerdict!: AgentVerdict;

  /** Advisory risk budget percentage (0.5–2.0). */
  @Column({
    name: 'advisory_risk_budget_pct',
    type: 'numeric',
    precision: 4,
    scale: 2,
  })
  advisoryRiskBudgetPct!: string;

  /** Confidence score (0–100). */
  @Column({ name: 'confidence_score', type: 'integer' })
  confidenceScore!: number;

  /** Whether all 15 agents completed within timeout. */
  @Column({ name: 'all_agents_completed', type: 'boolean' })
  allAgentsCompleted!: boolean;

  /** Number of agents that timed out and used fallback output. */
  @Column({ name: 'timed_out_agents', type: 'integer', default: 0 })
  timedOutAgents!: number;

  /**
   * Full ResearchDecision JSON — stored for audit and reflection.
   * Never used for order execution.
   */
  @Column({ name: 'full_decision', type: 'jsonb' })
  fullDecision!: Record<string, unknown>;

  /**
   * Whether the research suggested execution and execution was attempted.
   * NULL before settlement.
   */
  @Column({ name: 'was_executed', type: 'boolean', nullable: true })
  wasExecuted!: boolean | null;

  /**
   * Trade ID if the decision led to a trade being placed.
   * NULL if no trade was placed.
   */
  @Column({ name: 'trade_id', type: 'uuid', nullable: true })
  tradeId!: string | null;

  /** Actual net P&L of the resulting trade (after charges). NULL if not executed. */
  @Column({ name: 'actual_net_pnl', type: 'numeric', precision: 15, scale: 2, nullable: true })
  actualNetPnl!: string | null;

  /** Outcome classification after trade settlement. */
  @Column({ name: 'outcome', type: 'varchar', default: 'PENDING' })
  outcome!: DecisionOutcome;

  /**
   * Whether the decision direction matched the actual market movement.
   * Used in reflection analysis to improve agent calibration.
   */
  @Column({ name: 'direction_correct', type: 'boolean', nullable: true })
  directionCorrect!: boolean | null;

  /**
   * Reflection notes — summary of what agents got right/wrong.
   * Written by the reflection process after settlement.
   */
  @Column({ name: 'reflection_notes', type: 'text', nullable: true })
  reflectionNotes!: string | null;

  /** Whether this decision has been settled and reflected upon. */
  @Column({ name: 'is_settled', type: 'boolean', default: false })
  isSettled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;
}
