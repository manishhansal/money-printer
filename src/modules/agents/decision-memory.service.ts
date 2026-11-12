/**
 * decision-memory.service.ts
 *
 * DecisionMemoryService — persists research decisions, settles outcomes,
 * and provides reflection on agent calibration.
 *
 * Key invariants:
 *   - Records are append-only (never modified post-write, only settled)
 *   - LLM-generated content is stored for audit but NEVER used for execution
 *   - Future leakage prevention: outcome settlement only after trade closes
 *   - Memory never directly modifies risk limits or trading behavior
 *
 * Requirements: Phase 11
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentDecisions, DecisionOutcome } from '../../database/entities/agent-decisions.entity';
import { ResearchDecision } from './agent.types';

export interface SettlementData {
  workflowId: string;
  wasExecuted: boolean;
  tradeId?: string;
  actualNetPnl?: number;
  outcome: DecisionOutcome;
  directionCorrect?: boolean;
}

export interface ReflectionSummary {
  totalDecisions: number;
  executedDecisions: number;
  profitableDecisions: number;
  lossDecisions: number;
  avgConfidenceScore: number;
  directionAccuracy: number;
  timedOutWorkflows: number;
  verdictBreakdown: Record<string, number>;
  outcomeBreakdown: Record<string, number>;
}

@Injectable()
export class DecisionMemoryService {
  private readonly logger = new Logger(DecisionMemoryService.name);

  constructor(
    @InjectRepository(AgentDecisions)
    private readonly decisionsRepo: Repository<AgentDecisions>,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persist a completed ResearchDecision to the agent_decisions table.
   *
   * Idempotent — if the workflow_id already exists, returns the existing record.
   * This prevents duplicate writes if the caller retries.
   *
   * Requirements: Phase 11
   */
  async store(decision: ResearchDecision): Promise<AgentDecisions> {
    // Idempotency check
    const existing = await this.decisionsRepo.findOne({
      where: { workflowId: decision.workflowId },
    });
    if (existing) {
      this.logger.debug(`Decision ${decision.workflowId} already stored — returning existing`);
      return existing;
    }

    const record = this.decisionsRepo.create({
      workflowId: decision.workflowId,
      underlying: decision.underlying,
      snapshotAt: decision.snapshotAt,
      completedAt: decision.completedAt,
      workflowDurationMs: decision.workflowDurationMs,
      marketContext: decision.marketContext as unknown as Record<string, unknown>,
      consensusDirection: decision.researchManager.consensusDirection,
      consensusConfidence: decision.researchManager.consensusConfidence,
      finalVerdict: decision.portfolioManager.finalVerdict,
      advisoryRiskBudgetPct: String(decision.portfolioManager.advisoryRiskBudgetPct),
      confidenceScore: decision.portfolioManager.confidenceScore,
      allAgentsCompleted: decision.allAgentsCompleted,
      timedOutAgents: decision.timedOutAgents,
      fullDecision: decision as unknown as Record<string, unknown>,
      outcome: 'PENDING',
      isSettled: false,
      wasExecuted: null,
      tradeId: null,
      actualNetPnl: null,
      directionCorrect: null,
      reflectionNotes: null,
    });

    const saved = await this.decisionsRepo.save(record);
    this.logger.debug(
      `Stored decision ${decision.workflowId}: ${decision.portfolioManager.finalVerdict} ` +
        `(${decision.portfolioManager.confidenceScore}% confidence)`,
    );
    return saved;
  }

  /**
   * Settle a decision after the resulting trade closes.
   *
   * Populates outcome, actual P&L, and direction accuracy.
   * Called by TradeJournalService or PositionMonitoringService after a close.
   *
   * Requirements: Phase 11 — outcome settlement
   */
  async settle(data: SettlementData): Promise<void> {
    const record = await this.decisionsRepo.findOne({ where: { workflowId: data.workflowId } });
    if (!record) {
      this.logger.warn(`Cannot settle decision ${data.workflowId} — record not found`);
      return;
    }

    if (record.isSettled) {
      this.logger.debug(`Decision ${data.workflowId} already settled — skipping`);
      return;
    }

    record.wasExecuted = data.wasExecuted;
    record.tradeId = data.tradeId ?? null;
    record.actualNetPnl = data.actualNetPnl != null ? String(data.actualNetPnl) : null;
    record.outcome = data.outcome;
    record.directionCorrect = data.directionCorrect ?? null;
    record.isSettled = true;
    record.reflectionNotes = this.generateReflectionNotes(record, data);

    await this.decisionsRepo.save(record);
    this.logger.log(
      `Settled decision ${data.workflowId}: outcome=${data.outcome} ` +
        `pnl=${data.actualNetPnl ?? 'N/A'} directionCorrect=${data.directionCorrect ?? 'N/A'}`,
    );
  }

  /**
   * Get a summary of agent calibration performance over the last N days.
   *
   * Requirements: Phase 11 — reflection
   */
  async getReflectionSummary(daysBack = 30): Promise<ReflectionSummary> {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1_000);

    const records = await this.decisionsRepo
      .createQueryBuilder('d')
      .where('d.created_at >= :since', { since })
      .getMany();

    if (records.length === 0) {
      return {
        totalDecisions: 0,
        executedDecisions: 0,
        profitableDecisions: 0,
        lossDecisions: 0,
        avgConfidenceScore: 0,
        directionAccuracy: 0,
        timedOutWorkflows: 0,
        verdictBreakdown: {},
        outcomeBreakdown: {},
      };
    }

    const executed = records.filter((r) => r.wasExecuted === true);
    const profitable = records.filter((r) => r.outcome === 'PROFITABLE');
    const loss = records.filter((r) => r.outcome === 'LOSS');
    const dirCorrect = records.filter((r) => r.directionCorrect === true);
    const dirAssessed = records.filter((r) => r.directionCorrect != null);
    const timedOut = records.filter((r) => r.timedOutAgents > 0);

    const avgConfidence = records.reduce((sum, r) => sum + r.confidenceScore, 0) / records.length;

    const verdictBreakdown: Record<string, number> = {};
    const outcomeBreakdown: Record<string, number> = {};

    for (const r of records) {
      verdictBreakdown[r.finalVerdict] = (verdictBreakdown[r.finalVerdict] ?? 0) + 1;
      outcomeBreakdown[r.outcome] = (outcomeBreakdown[r.outcome] ?? 0) + 1;
    }

    return {
      totalDecisions: records.length,
      executedDecisions: executed.length,
      profitableDecisions: profitable.length,
      lossDecisions: loss.length,
      avgConfidenceScore: Math.round(avgConfidence),
      directionAccuracy:
        dirAssessed.length > 0 ? Math.round((dirCorrect.length / dirAssessed.length) * 100) : 0,
      timedOutWorkflows: timedOut.length,
      verdictBreakdown,
      outcomeBreakdown,
    };
  }

  /**
   * Get recent research decisions for the dashboard.
   */
  async getRecentDecisions(limit = 20): Promise<AgentDecisions[]> {
    return this.decisionsRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
      select: [
        'id',
        'workflowId',
        'underlying',
        'snapshotAt',
        'consensusDirection',
        'finalVerdict',
        'confidenceScore',
        'outcome',
        'isSettled',
        'createdAt',
      ],
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private generateReflectionNotes(record: AgentDecisions, settlement: SettlementData): string {
    const lines: string[] = [];

    lines.push(`Workflow: ${record.workflowId}`);
    lines.push(`Underlying: ${record.underlying}`);
    lines.push(`Verdict: ${record.finalVerdict} → Outcome: ${settlement.outcome}`);

    if (settlement.directionCorrect === true) {
      lines.push(`Direction: CORRECT — agents identified the right bias`);
    } else if (settlement.directionCorrect === false) {
      lines.push(`Direction: INCORRECT — agents missed the actual market move`);
    }

    if (settlement.actualNetPnl != null) {
      const pnlNum = settlement.actualNetPnl;
      lines.push(`P&L: ₹${pnlNum.toFixed(2)} ${pnlNum >= 0 ? '(profitable)' : '(loss)'}`);
    }

    if (!settlement.wasExecuted) {
      lines.push(`Not executed — research was advisory only`);
    }

    return lines.join('\n');
  }
}
