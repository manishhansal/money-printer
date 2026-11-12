/**
 * agent-orchestrator.service.ts
 *
 * AgentOrchestratorService — coordinates the full 6-phase multi-agent
 * research workflow adapted from the TradingAgents architecture.
 *
 * Phase 1: 7 specialist analysts run in parallel (bounded by Promise.allSettled)
 * Phase 2: Bull/Bear researchers debate the opportunity (parallel)
 * Phase 3: Research Manager synthesizes the debate
 * Phase 4: Trader Proposal Agent proposes the trade setup
 * Phase 5: 3 Risk Analysts evaluate the proposal (parallel)
 * Phase 6: Portfolio Manager makes the final go/no-go decision
 *
 * When LLM is unavailable, each agent falls back to rule-based analysis
 * using verified MoneyPrinter data.  The workflow NEVER blocks market
 * execution — it runs asynchronously and results are stored in Decision Memory.
 *
 * Requirements: Phase 3, 4
 */

import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  MarketContext,
  ResearchDecision,
  WorkflowState,
  AnalystOutput,
  BullResearchOutput,
  BearResearchOutput,
  ResearchManagerOutput,
  TraderProposalOutput,
  RiskAnalystOutput,
  PortfolioManagerDecision,
  DirectionOpinion,
  ConfidenceLevel,
} from './agent.types';
import { LlmClientService, LlmUnavailableError, LlmTimeoutError } from './llm-client.service';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Timeout per individual phase (ms). */
const PHASE_TIMEOUT_MS = 25_000;

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(private readonly llm: LlmClientService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run the full 6-phase multi-agent research workflow for the given market context.
   *
   * Returns a ResearchDecision — not a broker order.
   * Caller (SignalDispatcherService) uses the decision as advisory input only.
   * RiskManagementService retains final authority.
   *
   * Requirements: Phase 3, 4
   */
  async runWorkflow(context: MarketContext): Promise<ResearchDecision> {
    const workflowId = uuidv4();
    const startedAt = new Date();

    this.logger.log(
      `[${workflowId}] Starting research workflow for ${context.underlying} ` +
        `(regime: ${context.marketRegime}, LTP: ${context.currentLtp})`,
    );

    const state: WorkflowState = {
      workflowId,
      phase: 'PENDING',
      underlying: context.underlying,
      startedAt,
      marketContext: context,
      analystOutputs: [],
      bullResearch: null,
      bearResearch: null,
      researchManager: null,
      traderProposal: null,
      riskAnalystOutputs: [],
      portfolioManager: null,
      error: null,
    };

    try {
      // Phase 1: Parallel specialist analysts
      state.phase = 'ANALYST_PHASE';
      state.analystOutputs = await this.runAnalystPhase(context, workflowId);

      // Phase 2: Bull/Bear debate (parallel)
      state.phase = 'DEBATE_PHASE';
      const [bull, bear] = await this.runDebatePhase(context, state.analystOutputs, workflowId);
      state.bullResearch = bull;
      state.bearResearch = bear;

      // Phase 3: Research Manager
      state.phase = 'RESEARCH_PHASE';
      state.researchManager = await this.runResearchPhase(context, bull, bear, workflowId);

      // Skip to portfolio manager if research says don't proceed
      if (state.researchManager.proceedToTrader) {
        // Phase 4: Trader Proposal
        state.phase = 'PROPOSAL_PHASE';
        state.traderProposal = await this.runProposalPhase(
          context,
          state.researchManager,
          workflowId,
        );

        // Phase 5: Risk Analysts (parallel)
        state.phase = 'RISK_PHASE';
        state.riskAnalystOutputs = await this.runRiskPhase(
          context,
          state.traderProposal,
          workflowId,
        );
      }

      // Phase 6: Portfolio Manager (always runs)
      state.phase = 'PORTFOLIO_PHASE';
      state.portfolioManager = await this.runPortfolioPhase(context, state, workflowId);

      state.phase = 'COMPLETED';
    } catch (err) {
      state.phase = 'FAILED';
      state.error = (err as Error).message;
      this.logger.error(`[${workflowId}] Workflow failed: ${state.error}`);

      // Ensure we always have a portfolio manager decision (conservative default)
      if (!state.portfolioManager) {
        state.portfolioManager = this.buildFallbackPortfolioDecision(
          workflowId,
          `Workflow failed: ${state.error}`,
        );
      }
    }

    const completedAt = new Date();

    // Count timeouts across ALL phases, not just Phase 1 analysts.
    // A phase-level fallback (source === 'TIMEOUT_FALLBACK') is counted once
    // per agent role that did not complete within its budget.
    const analystTimeouts = state.analystOutputs.filter(
      (a) => a.source === 'TIMEOUT_FALLBACK',
    ).length;
    const bullTimeout = state.bullResearch?.source === 'TIMEOUT_FALLBACK' ? 1 : 0;
    const bearTimeout = state.bearResearch?.source === 'TIMEOUT_FALLBACK' ? 1 : 0;
    const researchManagerTimeout = state.researchManager?.source === 'TIMEOUT_FALLBACK' ? 1 : 0;
    const traderProposalTimeout = state.traderProposal?.source === 'TIMEOUT_FALLBACK' ? 1 : 0;
    const riskAnalystTimeouts = state.riskAnalystOutputs.filter(
      (r) => r.source === 'TIMEOUT_FALLBACK',
    ).length;
    const portfolioManagerTimeout = state.portfolioManager?.source === 'TIMEOUT_FALLBACK' ? 1 : 0;

    const timedOut =
      analystTimeouts +
      bullTimeout +
      bearTimeout +
      researchManagerTimeout +
      traderProposalTimeout +
      riskAnalystTimeouts +
      portfolioManagerTimeout;

    const decision: ResearchDecision = {
      workflowId,
      underlying: context.underlying,
      snapshotAt: context.snapshotAt,
      completedAt,
      workflowDurationMs: completedAt.getTime() - startedAt.getTime(),
      marketContext: context,
      analystOutputs: state.analystOutputs,
      bullResearch: state.bullResearch ?? this.buildFallbackBullResearch(workflowId),
      bearResearch: state.bearResearch ?? this.buildFallbackBearResearch(workflowId),
      researchManager:
        state.researchManager ?? this.buildFallbackResearchManager(workflowId, 'ABSTAIN'),
      traderProposal: state.traderProposal,
      riskAnalystOutputs: state.riskAnalystOutputs,
      portfolioManager:
        state.portfolioManager ??
        this.buildFallbackPortfolioDecision(workflowId, 'Workflow incomplete'),
      allAgentsCompleted: timedOut === 0 && state.phase === 'COMPLETED',
      timedOutAgents: timedOut,
    };

    this.logger.log(
      `[${workflowId}] Workflow complete: verdict=${decision.portfolioManager.finalVerdict} ` +
        `duration=${decision.workflowDurationMs}ms timedOut=${timedOut}`,
    );

    return decision;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1: Specialist Analysts (7 parallel agents)
  // ─────────────────────────────────────────────────────────────────────────

  private async runAnalystPhase(
    context: MarketContext,
    workflowId: string,
  ): Promise<AnalystOutput[]> {
    const analysts = [
      { id: 'market-structure', role: 'Market Structure Analyst' },
      { id: 'technical-analysis', role: 'Technical Analysis Analyst' },
      { id: 'derivatives', role: 'Derivatives Intelligence Analyst' },
      { id: 'options-flow', role: 'Options Flow Analyst' },
      { id: 'news', role: 'News Intelligence Analyst' },
      { id: 'sentiment', role: 'Sentiment Analyst' },
      { id: 'event-risk', role: 'Event & Volatility Risk Analyst' },
    ];

    const results = await Promise.allSettled(
      analysts.map((a) => this.runSingleAnalyst(context, a.id, a.role, workflowId)),
    );

    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : this.buildTimeoutAnalystOutput(analysts[i].id, analysts[i].role),
    );
  }

  private async runSingleAnalyst(
    context: MarketContext,
    agentId: string,
    agentRole: string,
    workflowId: string,
  ): Promise<AnalystOutput> {
    // Rule-based fallback (used when LLM unavailable or on timeout)
    const ruleBasedOutput = this.ruleBasedAnalystOutput(context, agentId, agentRole);

    if (!this.llm.isAvailable()) return ruleBasedOutput;

    try {
      const systemPrompt = this.buildAnalystSystemPrompt(agentRole);
      const userPrompt = this.buildAnalystUserPrompt(context, agentRole);

      const response = await Promise.race([
        this.llm.call({ systemPrompt, userPrompt, maxTokens: 600, temperature: 0.3 }),
        this.phaseTimeout(PHASE_TIMEOUT_MS),
      ]);

      return this.parseAnalystOutput(response.content, agentId, agentRole, 'LLM');
    } catch (err) {
      if (err instanceof LlmTimeoutError) {
        this.logger.warn(`[${workflowId}] ${agentRole} timed out — using rule-based fallback`);
        return { ...ruleBasedOutput, source: 'TIMEOUT_FALLBACK' };
      }
      if (err instanceof LlmUnavailableError) return ruleBasedOutput;
      return ruleBasedOutput;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2: Bull/Bear Debate (parallel)
  // ─────────────────────────────────────────────────────────────────────────

  private async runDebatePhase(
    context: MarketContext,
    analystOutputs: AnalystOutput[],
    workflowId: string,
  ): Promise<[BullResearchOutput, BearResearchOutput]> {
    const bullishCount = analystOutputs.filter((a) => a.opinion === 'BULLISH').length;
    const bearishCount = analystOutputs.filter((a) => a.opinion === 'BEARISH').length;
    this.logger.debug(
      `[${workflowId}] Debate phase: ${bullishCount} bullish, ${bearishCount} bearish analysts`,
    );

    const [bull, bear] = await Promise.allSettled([
      this.runBullResearcher(context, analystOutputs, workflowId),
      this.runBearResearcher(context, analystOutputs, workflowId),
    ]);

    return [
      bull.status === 'fulfilled' ? bull.value : this.buildFallbackBullResearch(workflowId),
      bear.status === 'fulfilled' ? bear.value : this.buildFallbackBearResearch(workflowId),
    ];
  }

  private async runBullResearcher(
    context: MarketContext,
    analystOutputs: AnalystOutput[],
    workflowId: string,
  ): Promise<BullResearchOutput> {
    const bullishReasons = analystOutputs
      .filter((a) => a.opinion === 'BULLISH')
      .flatMap((a) => a.reasons)
      .slice(0, 5);

    const base = this.ruleBasedAnalystOutput(context, 'bull-researcher', 'Bull Researcher');
    const bullBase: BullResearchOutput = {
      ...base,
      bullCase:
        `${context.underlying} shows ${bullishReasons.length} bullish signals. ` +
        `Regime: ${context.marketRegime}. VWAP relation: LTP ${context.currentLtp > context.vwap ? 'above' : 'below'} VWAP ${context.vwap}.`,
      keyBullCatalysts: bullishReasons.length > 0 ? bullishReasons : ['Momentum analysis pending'],
      targetPriceZone: `+${(context.atr14 * 1.5).toFixed(0)} to +${(context.atr14 * 2.5).toFixed(0)} from entry`,
      timeHorizon: 'Intraday — 30 to 90 minutes',
    };

    if (!this.llm.isAvailable()) return bullBase;

    try {
      const analystSummary = analystOutputs
        .map(
          (a) => `${a.agentRole}: ${a.opinion} (${a.confidence}) - ${a.reasons[0] ?? 'no reason'}`,
        )
        .join('\n');

      const response = await Promise.race([
        this.llm.call({
          systemPrompt: `You are the Bull Researcher for ${context.underlying} options trading. 
Build the strongest possible bullish case for buying a CALL option based on verified market data.
Be specific about catalysts. Do not invent prices or use numbers not in the provided data.
Respond in 150 words or less.`,
          userPrompt: `Market context:
LTP: ${context.currentLtp}, VWAP: ${context.vwap}, ATR14: ${context.atr14}
Regime: ${context.marketRegime}, VIX: ${context.vix}, RSI: ${context.rsi14}
PCR: ${context.pcr}, IV ATM: ${context.ivAtm}%, IV Regime: ${context.ivRegime}

Analyst signals:
${analystSummary}

Build the bull case in this exact format:
BULL_CASE: <one sentence summary>
CATALYSTS: <catalyst1>|<catalyst2>|<catalyst3>
TARGET_ZONE: <descriptive zone>
CONFIDENCE: HIGH|MEDIUM|LOW`,
          maxTokens: 300,
          temperature: 0.4,
        }),
        this.phaseTimeout(PHASE_TIMEOUT_MS),
      ]);

      return this.parseBullResearch(response.content, workflowId);
    } catch {
      return bullBase;
    }
  }

  private async runBearResearcher(
    context: MarketContext,
    analystOutputs: AnalystOutput[],
    workflowId: string,
  ): Promise<BearResearchOutput> {
    const bearishReasons = analystOutputs
      .filter((a) => a.opinion === 'BEARISH')
      .flatMap((a) => a.reasons)
      .slice(0, 5);

    const base = this.ruleBasedAnalystOutput(context, 'bear-researcher', 'Bear Researcher');
    const bearBase: BearResearchOutput = {
      ...base,
      opinion: 'BEARISH',
      bearCase:
        `Devil's advocate: ${bearishReasons.length} bearish signals detected. ` +
        `IV Regime: ${context.ivRegime}. PCR: ${context.pcr.toFixed(2)}.`,
      keyRisks:
        bearishReasons.length > 0
          ? bearishReasons
          : ['High IV may erode premium', 'Theta decay accelerating', 'Market regime uncertainty'],
      invalidationLevel: `Break above/below ${(context.atr14 * 1.0).toFixed(0)} from entry`,
    };

    if (!this.llm.isAvailable()) return bearBase;

    try {
      const response = await Promise.race([
        this.llm.call({
          systemPrompt: `You are the Bear Researcher / Devil's Advocate for ${context.underlying} options trading.
Your job is to identify every risk and reason NOT to trade. Be constructively critical.
Do not invent prices. Respond in 150 words or less.`,
          userPrompt: `Market context:
LTP: ${context.currentLtp}, VWAP: ${context.vwap}, VIX: ${context.vix}
Regime: ${context.marketRegime}, IV: ${context.ivAtm}%, PCR: ${context.pcr}
RSI: ${context.rsi14}, MACD: ${context.macdSignal}

Identify the top 3 risks:
BEAR_CASE: <one sentence summary>
RISKS: <risk1>|<risk2>|<risk3>
INVALIDATION: <level description>
CONFIDENCE: HIGH|MEDIUM|LOW`,
          maxTokens: 250,
          temperature: 0.4,
        }),
        this.phaseTimeout(PHASE_TIMEOUT_MS),
      ]);

      return this.parseBearResearch(response.content, workflowId);
    } catch {
      return bearBase;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3: Research Manager
  // ─────────────────────────────────────────────────────────────────────────

  private async runResearchPhase(
    context: MarketContext,
    bull: BullResearchOutput,
    bear: BearResearchOutput,
    workflowId: string,
  ): Promise<ResearchManagerOutput> {
    // Rule-based: count bullish vs bearish signals
    const analystsBullish = bull.reasons.length;
    const analystsBearish = bear.keyRisks.length;
    const ruleDirection: DirectionOpinion =
      analystsBullish > analystsBearish
        ? 'BULLISH'
        : analystsBearish > analystsBullish
          ? 'BEARISH'
          : 'NEUTRAL';

    const ruleBase: ResearchManagerOutput = {
      agentId: `research-manager-${workflowId}`,
      debateSummary: `Bull case: ${bull.bullCase}. Bear case: ${bear.bearCase}.`,
      consensusDirection: ruleDirection,
      consensusConfidence: 'MEDIUM',
      keyAgreements: ['Intraday risk management required'],
      keyDisagreements: ['Direction uncertainty'],
      overallRisk: context.vix > 20 ? 'HIGH' : 'MEDIUM',
      proceedToTrader: ruleDirection !== 'NEUTRAL' && context.marketRegime !== 'UNSTABLE',
      producedAt: new Date(),
      source: 'RULE_BASED',
    };

    if (!this.llm.isAvailable()) return ruleBase;

    try {
      const response = await Promise.race([
        this.llm.call({
          systemPrompt: `You are the Research Manager for ${context.underlying} intraday options trading.
Synthesize the bull/bear debate and decide if there is a tradeable opportunity.
Make a clear consensus decision. Respond in 100 words or less.`,
          userPrompt: `Regime: ${context.marketRegime}, VIX: ${context.vix}, Session: ${context.sessionPhase}

Bull Case: ${bull.bullCase}
Key bull catalysts: ${bull.keyBullCatalysts.join(', ')}
Bull confidence: ${bull.confidence}

Bear Case: ${bear.bearCase}
Key risks: ${bear.keyRisks.join(', ')}
Bear confidence: ${bear.confidence}

Respond in this format:
DIRECTION: BULLISH|BEARISH|NEUTRAL
CONFIDENCE: HIGH|MEDIUM|LOW
PROCEED: YES|NO
REASON: <one sentence>
RISK: HIGH|MEDIUM|LOW`,
          maxTokens: 200,
          temperature: 0.2,
        }),
        this.phaseTimeout(PHASE_TIMEOUT_MS),
      ]);

      return this.parseResearchManagerOutput(response.content, bull, bear, workflowId);
    } catch {
      return ruleBase;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 4: Trader Proposal
  // ─────────────────────────────────────────────────────────────────────────

  private async runProposalPhase(
    context: MarketContext,
    research: ResearchManagerOutput,
    workflowId: string,
  ): Promise<TraderProposalOutput> {
    const direction = research.consensusDirection;
    const optionType = direction === 'BULLISH' ? 'CE' : direction === 'BEARISH' ? 'PE' : 'SKIP';

    const ruleBase: TraderProposalOutput = {
      agentId: `trader-proposal-${workflowId}`,
      proposedDirection: optionType === 'SKIP' ? 'SKIP' : optionType,
      setupDescription: `${context.underlying} ${optionType} — ${direction} setup per research consensus`,
      entryLogic: `Entry on ${context.underlying} confirmation above/below key level. VWAP: ${context.vwap.toFixed(0)}`,
      exitLogic: 'Target 1 at 1.5× risk, runner to 2.5× risk with ATR trail',
      stopLossLogic: `1.0× ATR (${context.atr14.toFixed(0)}) below/above entry candle`,
      targetLogic: 'Scale out at Target 1 (50% of position), trail remaining with structure',
      rewardToRiskAssessment: `Minimum 1.5:1 R:R required. IV at ${context.ivAtm.toFixed(1)}%.`,
      keyAssumptions: [
        `Regime ${context.marketRegime} supports directional bias`,
        `IV ${context.ivRegime} — ${context.ivRegime === 'CONTRACTING' ? 'favorable for buying' : 'monitor premium decay'}`,
        `Volume confirmation required`,
      ],
      producedAt: new Date(),
      source: 'RULE_BASED',
    };

    if (!this.llm.isAvailable()) return ruleBase;

    try {
      const response = await Promise.race([
        this.llm.call({
          systemPrompt: `You are the Trader Proposal Agent for ${context.underlying} intraday options.
Propose a specific options trade setup. Use ONLY the provided market data for prices and levels.
Do NOT invent security IDs, lot sizes, or specific entry prices.
Respond in 120 words or less.`,
          userPrompt: `Consensus: ${direction} (${research.consensusConfidence})
Market: LTP ${context.currentLtp}, VWAP ${context.vwap}, ATR ${context.atr14}
IV: ${context.ivAtm}% (${context.ivRegime}), VIX: ${context.vix}
Session: ${context.sessionPhase}, ORB: H=${context.openingRange.high} L=${context.openingRange.low}

Propose:
OPTION_TYPE: CE|PE|SKIP
SETUP: <description>
ENTRY_LOGIC: <logic>
STOP_LOGIC: <logic>
TARGET_LOGIC: <logic>
RR_ASSESSMENT: <assessment>`,
          maxTokens: 250,
          temperature: 0.3,
        }),
        this.phaseTimeout(PHASE_TIMEOUT_MS),
      ]);

      return this.parseTraderProposal(response.content, workflowId);
    } catch {
      return ruleBase;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 5: Risk Analysts (parallel)
  // ─────────────────────────────────────────────────────────────────────────

  private async runRiskPhase(
    context: MarketContext,
    proposal: TraderProposalOutput,
    workflowId: string,
  ): Promise<RiskAnalystOutput[]> {
    const profiles: Array<{ profile: 'AGGRESSIVE' | 'CONSERVATIVE' | 'NEUTRAL'; id: string }> = [
      { profile: 'AGGRESSIVE', id: 'aggressive-risk' },
      { profile: 'CONSERVATIVE', id: 'conservative-risk' },
      { profile: 'NEUTRAL', id: 'neutral-risk' },
    ];

    const results = await Promise.allSettled(
      profiles.map((p) =>
        this.runSingleRiskAnalyst(context, proposal, p.profile, p.id, workflowId),
      ),
    );

    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : this.buildFallbackRiskAnalyst(profiles[i].profile, profiles[i].id, workflowId),
    );
  }

  private async runSingleRiskAnalyst(
    context: MarketContext,
    proposal: TraderProposalOutput,
    profile: 'AGGRESSIVE' | 'CONSERVATIVE' | 'NEUTRAL',
    agentId: string,
    workflowId: string,
  ): Promise<RiskAnalystOutput> {
    const ruleVerdicts = {
      AGGRESSIVE: 'APPROVE',
      CONSERVATIVE: context.vix > 18 ? 'CONDITIONAL_APPROVE' : 'APPROVE',
      NEUTRAL: 'APPROVE',
    } as const;

    const ruleBase: RiskAnalystOutput = {
      agentId: `${agentId}-${workflowId}`,
      agentRole: `${profile} Risk Analyst`,
      opinion: 'NEUTRAL',
      confidence: 'MEDIUM',
      riskProfile: profile,
      riskVerdict: ruleVerdicts[profile],
      conditions:
        profile === 'CONSERVATIVE'
          ? ['Confirm volume before entry', 'Verify stop-loss placement']
          : undefined,
      maxPositionSizeRecommendation:
        profile === 'CONSERVATIVE' ? 'HALF' : profile === 'AGGRESSIVE' ? 'FULL' : 'FULL',
      reasons: [
        `${profile} risk assessment based on VIX ${context.vix} and regime ${context.marketRegime}`,
      ],
      invalidatingConditions: ['Adverse move > 1 ATR before entry'],
      riskWarnings: context.vix > 20 ? ['High VIX environment — elevated option premiums'] : [],
      dataQualityNotes: [],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source: 'RULE_BASED',
    };

    if (!this.llm.isAvailable()) return ruleBase;

    try {
      const response = await Promise.race([
        this.llm.call({
          systemPrompt: `You are the ${profile} Risk Analyst for ${context.underlying} options trading.
Evaluate the proposed trade from a ${profile.toLowerCase()} risk perspective.
Conservative = protect capital first. Aggressive = maximize opportunity. Neutral = balanced.
Respond in 80 words or less.`,
          userPrompt: `Proposal: ${proposal.setupDescription}
VIX: ${context.vix}, IV: ${context.ivAtm}%, Regime: ${context.marketRegime}
IV Regime: ${context.ivRegime}, Session: ${context.sessionPhase}

Respond:
VERDICT: APPROVE|REJECT|CONDITIONAL_APPROVE
SIZE: FULL|HALF|QUARTER
CONDITIONS: <conditions if conditional, else NONE>
WARNINGS: <key risk warning>`,
          maxTokens: 150,
          temperature: 0.2,
        }),
        this.phaseTimeout(PHASE_TIMEOUT_MS),
      ]);

      return this.parseRiskAnalystOutput(response.content, profile, agentId, workflowId);
    } catch {
      return ruleBase;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 6: Portfolio Manager
  // ─────────────────────────────────────────────────────────────────────────

  private async runPortfolioPhase(
    context: MarketContext,
    state: WorkflowState,
    workflowId: string,
  ): Promise<PortfolioManagerDecision> {
    const riskApprovals = state.riskAnalystOutputs.filter((r) => r.riskVerdict !== 'REJECT').length;

    const proceedDecision = state.researchManager?.proceedToTrader ?? false;
    const consensusDirection = state.researchManager?.consensusDirection ?? 'NEUTRAL';

    // Conservative rule: approve only if research says proceed AND at least 2/3 risk analysts approve
    const ruleVerdict: 'EXECUTE' | 'SKIP' | 'PAPER_ONLY' =
      proceedDecision && riskApprovals >= 2 && consensusDirection !== 'NEUTRAL'
        ? 'PAPER_ONLY' // Default to paper-only until live authorization
        : 'SKIP';

    const ruleBase: PortfolioManagerDecision = {
      agentId: `portfolio-manager-${workflowId}`,
      finalVerdict: ruleVerdict,
      verdictReason:
        ruleVerdict === 'PAPER_ONLY'
          ? `Research consensus ${consensusDirection} with ${riskApprovals}/3 risk approvals. Paper-only pending live auth.`
          : `Skipped: ${!proceedDecision ? 'Research says no proceed' : `Only ${riskApprovals}/3 risk analysts approve`}`,
      advisoryRiskBudgetPct: 1.0, // advisory only — RiskManagementService has authority
      confidenceScore: Math.min(100, riskApprovals * 25 + (proceedDecision ? 25 : 0)),
      keyRisksAcknowledged: state.riskAnalystOutputs.flatMap((r) => r.riskWarnings).slice(0, 3),
      producedAt: new Date(),
      source: 'RULE_BASED',
    };

    if (!this.llm.isAvailable()) return ruleBase;

    try {
      const riskSummary = state.riskAnalystOutputs
        .map((r) => `${r.riskProfile}: ${r.riskVerdict} (${r.maxPositionSizeRecommendation} size)`)
        .join(', ');

      const response = await Promise.race([
        this.llm.call({
          systemPrompt: `You are the Portfolio Manager for ${context.underlying} options trading.
Make the final go/no-go decision. This is advisory only — the risk engine has final authority.
Default to PAPER_ONLY over EXECUTE when uncertain. Never recommend EXECUTE for risky setups.
Respond in 80 words or less.`,
          userPrompt: `Research: ${consensusDirection} (proceed: ${proceedDecision ? 'YES' : 'NO'})
Risk analysts: ${riskSummary}
Regime: ${context.marketRegime}, VIX: ${context.vix}, Session: ${context.sessionPhase}
${state.traderProposal ? `Setup: ${state.traderProposal.setupDescription}` : 'No proposal generated'}

Respond:
VERDICT: EXECUTE|PAPER_ONLY|SKIP
REASON: <one sentence>
CONFIDENCE_SCORE: 0-100
RISK_BUDGET_PCT: 0.5|1.0|1.5|2.0`,
          maxTokens: 150,
          temperature: 0.1,
        }),
        this.phaseTimeout(PHASE_TIMEOUT_MS),
      ]);

      return this.parsePortfolioDecision(response.content, workflowId);
    } catch {
      return ruleBase;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rule-based fallbacks
  // ─────────────────────────────────────────────────────────────────────────

  private ruleBasedAnalystOutput(
    context: MarketContext,
    agentId: string,
    agentRole: string,
  ): AnalystOutput {
    const ltpAboveVwap = context.currentLtp > context.vwap;
    const ltpAboveEma21 = context.currentLtp > context.ema21;
    const macdBullish = context.macdSignal === 'BULLISH';
    const rsiOversold = context.rsi14 < 40;
    const rsiOverbought = context.rsi14 > 60;

    const bullScore =
      (ltpAboveVwap ? 1 : 0) +
      (ltpAboveEma21 ? 1 : 0) +
      (macdBullish ? 1 : 0) +
      (rsiOversold ? 1 : 0);
    const bearScore =
      (!ltpAboveVwap ? 1 : 0) +
      (!ltpAboveEma21 ? 1 : 0) +
      (!macdBullish ? 1 : 0) +
      (rsiOverbought ? 1 : 0);

    const opinion: DirectionOpinion =
      bullScore > bearScore ? 'BULLISH' : bearScore > bullScore ? 'BEARISH' : 'NEUTRAL';
    const confidence: ConfidenceLevel =
      Math.abs(bullScore - bearScore) >= 3
        ? 'HIGH'
        : Math.abs(bullScore - bearScore) >= 2
          ? 'MEDIUM'
          : 'LOW';

    return {
      agentId: `${agentId}-rule`,
      agentRole,
      opinion,
      confidence,
      reasons: [
        `LTP ${ltpAboveVwap ? 'above' : 'below'} VWAP ${context.vwap.toFixed(0)}`,
        `MACD signal: ${context.macdSignal}`,
        `RSI(14): ${context.rsi14.toFixed(1)}`,
        `Regime: ${context.marketRegime}`,
      ],
      invalidatingConditions: [`VIX spike above ${(context.vix * 1.2).toFixed(0)}`],
      riskWarnings:
        context.ivRegime === 'EXPANDING' ? ['IV expanding — premium risk elevated'] : [],
      dataQualityNotes: [],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source: 'RULE_BASED',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Output parsers
  // ─────────────────────────────────────────────────────────────────────────

  private parseAnalystOutput(
    content: string,
    agentId: string,
    agentRole: string,
    source: 'LLM',
  ): AnalystOutput {
    const lines = content.split('\n');
    const get = (key: string) =>
      lines
        .find((l) => l.startsWith(`${key}:`))
        ?.replace(`${key}:`, '')
        .trim() ?? '';

    const opinion = this.parseDirection(get('OPINION'));
    const confidence = this.parseConfidence(get('CONFIDENCE'));
    const reasons = get('REASONS')
      .split('|')
      .map((r) => r.trim())
      .filter(Boolean);

    return {
      agentId: `${agentId}-llm`,
      agentRole,
      opinion,
      confidence,
      reasons: reasons.length > 0 ? reasons : [`LLM analysis for ${agentRole}`],
      invalidatingConditions: [get('INVALIDATION') || 'Adverse price action'],
      riskWarnings: [get('RISKS') || ''].filter(Boolean),
      dataQualityNotes: [],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source,
    };
  }

  private parseBullResearch(content: string, workflowId: string): BullResearchOutput {
    const lines = content.split('\n');
    const get = (key: string) =>
      lines
        .find((l) => l.startsWith(`${key}:`))
        ?.replace(`${key}:`, '')
        .trim() ?? '';

    return {
      agentId: `bull-researcher-${workflowId}`,
      agentRole: 'Bull Researcher',
      opinion: 'BULLISH',
      confidence: this.parseConfidence(get('CONFIDENCE')),
      reasons: [get('BULL_CASE') || 'Bullish case from LLM analysis'],
      invalidatingConditions: [],
      riskWarnings: [],
      dataQualityNotes: [],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source: 'LLM',
      bullCase: get('BULL_CASE') || 'Bullish case',
      keyBullCatalysts: get('CATALYSTS')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean),
      targetPriceZone: get('TARGET_ZONE') || 'ATR-based target zone',
      timeHorizon: 'Intraday',
    };
  }

  private parseBearResearch(content: string, workflowId: string): BearResearchOutput {
    const lines = content.split('\n');
    const get = (key: string) =>
      lines
        .find((l) => l.startsWith(`${key}:`))
        ?.replace(`${key}:`, '')
        .trim() ?? '';

    return {
      agentId: `bear-researcher-${workflowId}`,
      agentRole: 'Bear Researcher',
      opinion: 'BEARISH',
      confidence: this.parseConfidence(get('CONFIDENCE')),
      reasons: [get('BEAR_CASE') || 'Bearish case from LLM analysis'],
      invalidatingConditions: [],
      riskWarnings: [],
      dataQualityNotes: [],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source: 'LLM',
      bearCase: get('BEAR_CASE') || 'Bear case',
      keyRisks: get('RISKS')
        .split('|')
        .map((r) => r.trim())
        .filter(Boolean),
      invalidationLevel: get('INVALIDATION') || 'Key support/resistance level',
    };
  }

  private parseResearchManagerOutput(
    content: string,
    bull: BullResearchOutput,
    bear: BearResearchOutput,
    workflowId: string,
  ): ResearchManagerOutput {
    const lines = content.split('\n');
    const get = (key: string) =>
      lines
        .find((l) => l.startsWith(`${key}:`))
        ?.replace(`${key}:`, '')
        .trim() ?? '';

    return {
      agentId: `research-manager-${workflowId}`,
      debateSummary: `Bull: ${bull.bullCase}. Bear: ${bear.bearCase}.`,
      consensusDirection: this.parseDirection(get('DIRECTION')),
      consensusConfidence: this.parseConfidence(get('CONFIDENCE')),
      keyAgreements: [get('REASON') || 'Research consensus'],
      keyDisagreements: [],
      overallRisk: (get('RISK') as 'HIGH' | 'MEDIUM' | 'LOW') || 'MEDIUM',
      proceedToTrader: get('PROCEED') === 'YES',
      producedAt: new Date(),
      source: 'LLM',
    };
  }

  private parseTraderProposal(content: string, workflowId: string): TraderProposalOutput {
    const lines = content.split('\n');
    const get = (key: string) =>
      lines
        .find((l) => l.startsWith(`${key}:`))
        ?.replace(`${key}:`, '')
        .trim() ?? '';

    const optType = get('OPTION_TYPE').toUpperCase();
    const direction: 'CE' | 'PE' | 'SKIP' =
      optType === 'CE' ? 'CE' : optType === 'PE' ? 'PE' : 'SKIP';

    return {
      agentId: `trader-proposal-${workflowId}`,
      proposedDirection: direction,
      setupDescription: get('SETUP') || 'Trade setup from LLM analysis',
      entryLogic: get('ENTRY_LOGIC') || 'Entry on confirmation',
      exitLogic: 'Target-and-runner with ATR trail',
      stopLossLogic: get('STOP_LOGIC') || '1× ATR stop',
      targetLogic: get('TARGET_LOGIC') || '1.5× risk target',
      rewardToRiskAssessment: get('RR_ASSESSMENT') || 'Minimum 1.5:1 R:R',
      keyAssumptions: ['LLM-generated proposal — verify with signal scoring'],
      producedAt: new Date(),
      source: 'LLM',
    };
  }

  private parseRiskAnalystOutput(
    content: string,
    profile: 'AGGRESSIVE' | 'CONSERVATIVE' | 'NEUTRAL',
    agentId: string,
    workflowId: string,
  ): RiskAnalystOutput {
    const lines = content.split('\n');
    const get = (key: string) =>
      lines
        .find((l) => l.startsWith(`${key}:`))
        ?.replace(`${key}:`, '')
        .trim() ?? '';

    const verdictRaw = get('VERDICT').toUpperCase();
    const verdict: 'APPROVE' | 'REJECT' | 'CONDITIONAL_APPROVE' =
      verdictRaw === 'APPROVE'
        ? 'APPROVE'
        : verdictRaw === 'REJECT'
          ? 'REJECT'
          : 'CONDITIONAL_APPROVE';

    const sizeRaw = get('SIZE').toUpperCase();
    const size: 'FULL' | 'HALF' | 'QUARTER' =
      sizeRaw === 'FULL' ? 'FULL' : sizeRaw === 'HALF' ? 'HALF' : 'QUARTER';

    return {
      agentId: `${agentId}-${workflowId}`,
      agentRole: `${profile} Risk Analyst`,
      opinion: 'NEUTRAL',
      confidence: 'MEDIUM',
      riskProfile: profile,
      riskVerdict: verdict,
      conditions: get('CONDITIONS') !== 'NONE' ? [get('CONDITIONS')] : undefined,
      maxPositionSizeRecommendation: size,
      reasons: [get('WARNINGS') || `${profile} risk evaluation`],
      invalidatingConditions: [],
      riskWarnings: get('WARNINGS') ? [get('WARNINGS')] : [],
      dataQualityNotes: [],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source: 'LLM',
    };
  }

  private parsePortfolioDecision(content: string, workflowId: string): PortfolioManagerDecision {
    const lines = content.split('\n');
    const get = (key: string) =>
      lines
        .find((l) => l.startsWith(`${key}:`))
        ?.replace(`${key}:`, '')
        .trim() ?? '';

    const verdictRaw = get('VERDICT').toUpperCase();
    const verdict: 'EXECUTE' | 'SKIP' | 'PAPER_ONLY' =
      verdictRaw === 'EXECUTE' ? 'EXECUTE' : verdictRaw === 'PAPER_ONLY' ? 'PAPER_ONLY' : 'SKIP';

    const score = parseInt(get('CONFIDENCE_SCORE'), 10);
    const budget = parseFloat(get('RISK_BUDGET_PCT'));

    return {
      agentId: `portfolio-manager-${workflowId}`,
      finalVerdict: verdict,
      verdictReason: get('REASON') || 'Portfolio manager decision',
      advisoryRiskBudgetPct: isNaN(budget) ? 1.0 : Math.min(2.0, Math.max(0.5, budget)),
      confidenceScore: isNaN(score) ? 50 : Math.min(100, Math.max(0, score)),
      keyRisksAcknowledged: [],
      producedAt: new Date(),
      source: 'LLM',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private parseDirection(raw: string): DirectionOpinion {
    const u = raw.toUpperCase();
    if (u === 'BULLISH') return 'BULLISH';
    if (u === 'BEARISH') return 'BEARISH';
    if (u === 'ABSTAIN') return 'ABSTAIN';
    return 'NEUTRAL';
  }

  private parseConfidence(raw: string): ConfidenceLevel {
    if (raw.toUpperCase() === 'HIGH') return 'HIGH';
    if (raw.toUpperCase() === 'LOW') return 'LOW';
    return 'MEDIUM';
  }

  private buildTimeoutAnalystOutput(agentId: string, agentRole: string): AnalystOutput {
    return {
      agentId: `${agentId}-timeout`,
      agentRole,
      opinion: 'NEUTRAL',
      confidence: 'LOW',
      reasons: ['Agent timed out — using neutral fallback'],
      invalidatingConditions: [],
      riskWarnings: ['Agent response not received — treat as uncertain'],
      dataQualityNotes: ['Timeout fallback used'],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source: 'TIMEOUT_FALLBACK',
    };
  }

  private buildFallbackBullResearch(workflowId: string): BullResearchOutput {
    return {
      agentId: `bull-researcher-fallback-${workflowId}`,
      agentRole: 'Bull Researcher',
      opinion: 'NEUTRAL',
      confidence: 'LOW',
      reasons: ['Bull research unavailable'],
      invalidatingConditions: [],
      riskWarnings: ['Bull research not completed'],
      dataQualityNotes: ['Fallback used'],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source: 'TIMEOUT_FALLBACK',
      bullCase: 'Bull case unavailable',
      keyBullCatalysts: [],
      targetPriceZone: 'Unknown',
      timeHorizon: 'Unknown',
    };
  }

  private buildFallbackBearResearch(workflowId: string): BearResearchOutput {
    return {
      agentId: `bear-researcher-fallback-${workflowId}`,
      agentRole: 'Bear Researcher',
      opinion: 'NEUTRAL',
      confidence: 'LOW',
      reasons: ['Bear research unavailable'],
      invalidatingConditions: [],
      riskWarnings: ['Bear research not completed'],
      dataQualityNotes: ['Fallback used'],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source: 'TIMEOUT_FALLBACK',
      bearCase: 'Bear case unavailable',
      keyRisks: ['Risks not assessed'],
      invalidationLevel: 'Unknown',
    };
  }

  private buildFallbackResearchManager(
    workflowId: string,
    direction: DirectionOpinion,
  ): ResearchManagerOutput {
    return {
      agentId: `research-manager-fallback-${workflowId}`,
      debateSummary: 'Research phase incomplete',
      consensusDirection: direction,
      consensusConfidence: 'LOW',
      keyAgreements: [],
      keyDisagreements: [],
      overallRisk: 'HIGH',
      proceedToTrader: false,
      skipReason: 'Research phase did not complete',
      producedAt: new Date(),
      source: 'TIMEOUT_FALLBACK',
    };
  }

  private buildFallbackRiskAnalyst(
    profile: 'AGGRESSIVE' | 'CONSERVATIVE' | 'NEUTRAL',
    agentId: string,
    workflowId: string,
  ): RiskAnalystOutput {
    return {
      agentId: `${agentId}-fallback-${workflowId}`,
      agentRole: `${profile} Risk Analyst`,
      opinion: 'NEUTRAL',
      confidence: 'LOW',
      riskProfile: profile,
      riskVerdict: 'CONDITIONAL_APPROVE',
      maxPositionSizeRecommendation: 'HALF',
      reasons: ['Risk analysis timed out — conservative fallback'],
      invalidatingConditions: [],
      riskWarnings: ['Risk analysis incomplete'],
      dataQualityNotes: ['Fallback used'],
      producedAt: new Date(),
      timeoutMs: PHASE_TIMEOUT_MS,
      source: 'TIMEOUT_FALLBACK',
    };
  }

  private buildFallbackPortfolioDecision(
    workflowId: string,
    reason: string,
  ): PortfolioManagerDecision {
    return {
      agentId: `portfolio-manager-fallback-${workflowId}`,
      finalVerdict: 'SKIP',
      verdictReason: reason,
      advisoryRiskBudgetPct: 1.0,
      confidenceScore: 0,
      keyRisksAcknowledged: ['Workflow incomplete — skipping as safety measure'],
      producedAt: new Date(),
      source: 'TIMEOUT_FALLBACK',
    };
  }

  private buildAnalystSystemPrompt(agentRole: string): string {
    return `You are the ${agentRole} for Indian NSE intraday options trading.
Analyze ONLY the verified market data provided. Do NOT invent prices, security IDs, lot sizes or Greeks.
Your opinion influences research decisions — it does NOT directly trigger orders.
Be concise and evidence-based. Respond in under 100 words.`;
  }

  private buildAnalystUserPrompt(context: MarketContext, agentRole: string): string {
    return `${agentRole} analysis for ${context.underlying}:

LTP: ${context.currentLtp}, VWAP: ${context.vwap}, ATR(14): ${context.atr14}
Regime: ${context.marketRegime}, VIX: ${context.vix}
RSI(14): ${context.rsi14}, MACD: ${context.macdSignal}
EMA9: ${context.ema9}, EMA21: ${context.ema21}
ORB: H=${context.openingRange.high} L=${context.openingRange.low}
IV ATM: ${context.ivAtm}% (${context.ivRegime})
PCR: ${context.pcr}, Net OI Change: ${context.netOiChange}
Session: ${context.sessionPhase}

Respond in this format:
OPINION: BULLISH|BEARISH|NEUTRAL|ABSTAIN
CONFIDENCE: HIGH|MEDIUM|LOW
REASONS: <reason1>|<reason2>|<reason3>
INVALIDATION: <condition>
RISKS: <main risk>`;
  }

  private phaseTimeout(ms: number): Promise<never> {
    return new Promise<never>((_, reject) =>
      setTimeout(() => reject(new LlmTimeoutError('phase', ms)), ms),
    );
  }
}
