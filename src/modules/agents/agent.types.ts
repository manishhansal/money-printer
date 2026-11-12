/**
 * agent.types.ts
 *
 * Type definitions for the multi-agent intelligence engine.
 *
 * Architecture:
 *   Phase 1: 7 parallel specialist analysts produce evidence-backed opinions
 *   Phase 2: Bull/Bear researchers debate the opportunity
 *   Phase 3: Research Manager produces a research decision
 *   Phase 4: Trader Proposal Agent proposes the specific trade
 *   Phase 5: 3 Risk Analysts evaluate the proposal
 *   Phase 6: Portfolio Manager makes the final go/no-go decision
 *
 * The final output is a ResearchDecision — NOT a broker order.
 * All market data, Greeks, lot sizes, and prices come from verified
 * MoneyPrinter services, never from LLM-generated values.
 *
 * Requirements: Phase 3, 4, 5
 */

// ─────────────────────────────────────────────────────────────────────────────
// LLM Provider
// ─────────────────────────────────────────────────────────────────────────────

export type LlmProvider = 'openai' | 'anthropic' | 'disabled';

/**
 * Fine-grained provider availability status.
 *
 * Separates "configured" from "credentials present" so the dashboard can
 * surface actionable information rather than a single boolean.
 *
 *  DISABLED            — LLM_PROVIDER=disabled; deterministic rule-based mode
 *  CREDENTIALS_MISSING — provider set but API key absent/empty
 *  CONFIGURED          — provider set and key present (connectivity not verified)
 */
export type LlmAvailabilityStatus = 'DISABLED' | 'CREDENTIALS_MISSING' | 'CONFIGURED';

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Market Context (from verified MoneyPrinter data only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot of verified market data passed to all agents.
 * ALL values come from MoneyPrinter services — NEVER from LLM output.
 */
export interface MarketContext {
  /** Timestamp of this snapshot. */
  snapshotAt: Date;

  /** Underlying instrument (e.g. "NIFTY", "BANKNIFTY"). */
  underlying: string;

  /** Current LTP from Redis. */
  currentLtp: number;

  /** VWAP from TechnicalAnalysisService. */
  vwap: number;

  /** ATR(14) from TechnicalAnalysisService. */
  atr14: number;

  /** Opening range (high, low) from TechnicalAnalysisService. */
  openingRange: { high: number; low: number };

  /** Current day open price. */
  dayOpen: number;

  /** Day high/low. */
  dayHigh: number;
  dayLow: number;

  /** Market regime from MarketRegimeService. */
  marketRegime: string;

  /** VIX level. */
  vix: number;

  /** PCR from OptionsFlowService. */
  pcr: number;

  /** IV ATM from OptionsIntelligenceService. */
  ivAtm: number;

  /** IV regime classification. */
  ivRegime: 'EXPANDING' | 'CONTRACTING' | 'NEUTRAL';

  /** Relative volume (current vol / 20-day avg vol). */
  relativeVolume: number;

  /** EMA values from TechnicalAnalysisService. */
  ema9: number;
  ema21: number;
  ema50: number;

  /** RSI(14). */
  rsi14: number;

  /** MACD signal. */
  macdSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';

  /** Net OI change (call - put) from OptionsFlowService. */
  netOiChange: number;

  /** Session phase from SessionManagerService. */
  sessionPhase: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

export type DirectionOpinion = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'ABSTAIN';
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/** Base schema for all analyst outputs. */
export interface AnalystOutput {
  agentId: string;
  agentRole: string;
  opinion: DirectionOpinion;
  confidence: ConfidenceLevel;
  /** Key reasons for the opinion — 1 to 5 points. */
  reasons: string[];
  /** Invalidating conditions — what would change the opinion. */
  invalidatingConditions: string[];
  /** Risk warnings specific to this analysis. */
  riskWarnings: string[];
  /** Data quality issues observed. */
  dataQualityNotes: string[];
  producedAt: Date;
  timeoutMs: number;
  /** Whether this was produced by a live LLM or a fallback rule engine. */
  source: 'LLM' | 'RULE_BASED' | 'TIMEOUT_FALLBACK';
}

/** Bull researcher output — the affirmative case for a trade. */
export interface BullResearchOutput extends AnalystOutput {
  bullCase: string;
  keyBullCatalysts: string[];
  targetPriceZone: string; // descriptive only, not a broker price
  timeHorizon: string;
}

/** Bear researcher output — the negative case / devil's advocate. */
export interface BearResearchOutput extends AnalystOutput {
  bearCase: string;
  keyRisks: string[];
  invalidationLevel: string; // descriptive only
}

/** Research Manager decision. */
export interface ResearchManagerOutput {
  agentId: string;
  debateSummary: string;
  consensusDirection: DirectionOpinion;
  consensusConfidence: ConfidenceLevel;
  keyAgreements: string[];
  keyDisagreements: string[];
  overallRisk: 'HIGH' | 'MEDIUM' | 'LOW';
  proceedToTrader: boolean;
  skipReason?: string;
  producedAt: Date;
  source: 'LLM' | 'RULE_BASED' | 'TIMEOUT_FALLBACK';
}

/** Trader Proposal Agent output — describes the trade setup. */
export interface TraderProposalOutput {
  agentId: string;
  proposedDirection: 'CE' | 'PE' | 'SKIP';
  /**
   * Descriptive setup description — instrument selection is validated
   * by MoneyPrinter services, NOT by this output.
   */
  setupDescription: string;
  entryLogic: string;
  exitLogic: string;
  stopLossLogic: string;
  targetLogic: string;
  rewardToRiskAssessment: string;
  keyAssumptions: string[];
  producedAt: Date;
  source: 'LLM' | 'RULE_BASED' | 'TIMEOUT_FALLBACK';
}

/** Risk analyst output — one per risk analyst (Agg/Cons/Neutral). */
export interface RiskAnalystOutput extends AnalystOutput {
  riskProfile: 'AGGRESSIVE' | 'CONSERVATIVE' | 'NEUTRAL';
  riskVerdict: 'APPROVE' | 'REJECT' | 'CONDITIONAL_APPROVE';
  conditions?: string[];
  maxPositionSizeRecommendation: 'FULL' | 'HALF' | 'QUARTER';
}

/** Portfolio Manager final decision. */
export interface PortfolioManagerDecision {
  agentId: string;
  finalVerdict: 'EXECUTE' | 'SKIP' | 'PAPER_ONLY';
  verdictReason: string;
  /**
   * Risk budget percentage override — capped at the RiskEngine's configured max.
   * This is advisory only; RiskManagementService has final authority.
   */
  advisoryRiskBudgetPct: number;
  /**
   * Confidence score (0–100) — does NOT affect execution risk limits.
   */
  confidenceScore: number;
  keyRisksAcknowledged: string[];
  producedAt: Date;
  source: 'LLM' | 'RULE_BASED' | 'TIMEOUT_FALLBACK';
}

// ─────────────────────────────────────────────────────────────────────────────
// Complete Research Decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete output of the multi-agent workflow.
 *
 * This is a RESEARCH DECISION — not a broker order.
 * The SignalDispatcherService consumes this alongside its own signal evaluation.
 * The RiskManagementService retains final authority over execution.
 */
export interface ResearchDecision {
  /** Unique workflow ID for correlation and decision memory. */
  workflowId: string;

  underlying: string;
  snapshotAt: Date;
  completedAt: Date;
  workflowDurationMs: number;

  marketContext: MarketContext;

  /** Outputs from the 7 specialist analysts. */
  analystOutputs: AnalystOutput[];

  bullResearch: BullResearchOutput;
  bearResearch: BearResearchOutput;
  researchManager: ResearchManagerOutput;
  traderProposal: TraderProposalOutput | null;

  /** Outputs from the 3 risk analysts. */
  riskAnalystOutputs: RiskAnalystOutput[];

  /** Final portfolio manager decision. */
  portfolioManager: PortfolioManagerDecision;

  /** Whether all agents completed within their timeout budgets. */
  allAgentsCompleted: boolean;

  /** Number of agents that timed out and used fallback output. */
  timedOutAgents: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Workflow State
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowPhase =
  | 'PENDING'
  | 'ANALYST_PHASE'
  | 'DEBATE_PHASE'
  | 'RESEARCH_PHASE'
  | 'PROPOSAL_PHASE'
  | 'RISK_PHASE'
  | 'PORTFOLIO_PHASE'
  | 'COMPLETED'
  | 'FAILED';

export interface WorkflowState {
  workflowId: string;
  phase: WorkflowPhase;
  underlying: string;
  startedAt: Date;
  marketContext: MarketContext | null;
  analystOutputs: AnalystOutput[];
  bullResearch: BullResearchOutput | null;
  bearResearch: BearResearchOutput | null;
  researchManager: ResearchManagerOutput | null;
  traderProposal: TraderProposalOutput | null;
  riskAnalystOutputs: RiskAnalystOutput[];
  portfolioManager: PortfolioManagerDecision | null;
  error: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Request / Response
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

export interface LlmResponse {
  content: string;
  tokensUsed: number;
  durationMs: number;
  provider: LlmProvider;
}
