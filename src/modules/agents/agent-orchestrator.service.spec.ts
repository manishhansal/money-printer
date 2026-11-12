/**
 * agent-orchestrator.service.spec.ts
 *
 * Unit tests for AgentOrchestratorService — the 6-phase multi-agent
 * research workflow.
 *
 * Coverage (16 tests):
 *
 *  LLM disabled / unavailable (default deployment mode):
 *   1.  Returns a ResearchDecision when LLM is disabled (rule-based fallback)
 *   2.  ResearchDecision contains all required structural fields
 *   3.  portfolioManager is never null (always has a fallback decision)
 *   4.  workflowId is a non-empty UUID string on every run
 *   5.  completedAt time is at or after the workflow start (monotonic)
 *   6.  timedOutAgents count is 0 when all phases use rule-based fallback
 *
 *  Rule-based analyst output:
 *   7.  At least one analyst is BULLISH when LTP > VWAP and MACD is BULLISH
 *   8.  At least one analyst is BEARISH when LTP < VWAP and MACD is BEARISH
 *   9.  At least one analyst has HIGH confidence when all 4 bullish signals align
 *  10.  At least one analyst has LOW confidence when signals are fully mixed
 *
 *  Portfolio decision structure:
 *  11.  portfolioManager.finalVerdict is one of EXECUTE | SKIP | PAPER_ONLY
 *  12.  portfolioManager.verdictReason is a non-empty string
 *
 *  Safety invariants:
 *  13.  ResearchDecision is advisory only — no broker order fields present
 *  14.  Workflow completes without throwing when LLM throws LlmUnavailableError
 *  15.  Workflow completes without throwing when every LLM call times out
 *  16.  portfolioManager verdict is structurally valid in a bearish / high-vix context
 *
 * All tests use in-memory stubs — no real LLM API calls are made.
 *
 * Requirements: DEFECT-006, Phase 3/4 agent coverage
 */

import { AgentOrchestratorService } from './agent-orchestrator.service';
import { LlmClientService, LlmUnavailableError, LlmTimeoutError } from './llm-client.service';
import { MarketContext } from './agent.types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a minimal valid MarketContext matching the actual type definition. */
function makeContext(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    snapshotAt: new Date(),
    underlying: 'NIFTY',
    currentLtp: 22500,
    vwap: 22400,
    ema9: 22480,
    ema21: 22350,
    ema50: 22100,
    rsi14: 55,
    macdSignal: 'BULLISH',
    atr14: 120,
    openingRange: { high: 22600, low: 22200 },
    dayOpen: 22300,
    dayHigh: 22650,
    dayLow: 22150,
    marketRegime: 'STRONG_BULL',
    vix: 14.5,
    pcr: 0.9,
    ivAtm: 15.5,
    ivRegime: 'NEUTRAL',
    relativeVolume: 1.2,
    netOiChange: 50000,
    sessionPhase: 'MORNING_MOMENTUM',
    ...overrides,
  };
}

/** Builds a fully disabled LLM client stub. */
function makeDisabledLlm(): LlmClientService {
  return {
    call: jest.fn().mockRejectedValue(new LlmUnavailableError('LLM provider is set to disabled')),
    isAvailable: jest.fn().mockReturnValue(false),
    getProvider: jest.fn().mockReturnValue('disabled'),
    getAvailabilityStatus: jest.fn().mockResolvedValue('DISABLED'),
  } as unknown as LlmClientService;
}

const VALID_VERDICTS = new Set(['EXECUTE', 'SKIP', 'PAPER_ONLY']);

// ─────────────────────────────────────────────────────────────────────────────
// 1–6. LLM disabled / unavailable — rule-based fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentOrchestratorService — LLM disabled (rule-based fallback)', () => {
  it('returns a ResearchDecision (not null/undefined) when LLM is disabled', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(makeContext());
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
  });

  it('ResearchDecision contains all required structural fields', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(makeContext());

    expect(typeof result.workflowId).toBe('string');
    expect(result.workflowId.length).toBeGreaterThan(0);
    expect(result.completedAt).toBeInstanceOf(Date);
    expect(result.portfolioManager).not.toBeNull();
    expect(typeof result.portfolioManager.finalVerdict).toBe('string');
    expect(typeof result.portfolioManager.verdictReason).toBe('string');
    expect(Array.isArray(result.analystOutputs)).toBe(true);
  });

  it('portfolioManager is never null — always has a fallback decision', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(makeContext());
    expect(result.portfolioManager).not.toBeNull();
  });

  it('workflowId is a non-empty UUID string', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(makeContext());
    expect(result.workflowId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('completedAt time is at or after workflow snapshotAt (monotonic)', async () => {
    const before = new Date();
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(makeContext({ snapshotAt: before }));
    expect(result.completedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('timedOutAgents count is 0 when all phases use rule-based fallback', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(makeContext());
    // Rule-based fallbacks are synchronous; no actual timeouts occur.
    expect(result.timedOutAgents).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7–10. Rule-based analyst output correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentOrchestratorService — rule-based analyst output', () => {
  it('at least one analyst opinion is BULLISH when LTP > VWAP and MACD is BULLISH', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(
      makeContext({
        currentLtp: 22600, // above VWAP 22400
        vwap: 22400,
        ema21: 22300, // LTP above EMA21
        macdSignal: 'BULLISH',
        rsi14: 55,
      }),
    );

    const bullishCount = result.analystOutputs.filter((a) => a.opinion === 'BULLISH').length;
    expect(bullishCount).toBeGreaterThan(0);
  });

  it('at least one analyst opinion is BEARISH when LTP < VWAP and MACD is BEARISH', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(
      makeContext({
        currentLtp: 22200, // below VWAP 22400
        vwap: 22400,
        ema21: 22450, // LTP below EMA21
        macdSignal: 'BEARISH',
        rsi14: 68,
      }),
    );

    const bearishCount = result.analystOutputs.filter((a) => a.opinion === 'BEARISH').length;
    expect(bearishCount).toBeGreaterThan(0);
  });

  it('at least one analyst has HIGH confidence when all 4 bullish signals align', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(
      makeContext({
        currentLtp: 22800, // above VWAP
        vwap: 22400,
        ema21: 22300, // LTP above EMA21
        macdSignal: 'BULLISH',
        rsi14: 35, // oversold → bullish signal
      }),
    );

    const highConfidence = result.analystOutputs.filter((a) => a.confidence === 'HIGH').length;
    expect(highConfidence).toBeGreaterThan(0);
  });

  it('at least one analyst has LOW confidence when signals are mixed/neutral', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(
      makeContext({
        // Rule-based scoring: bullScore = ltpAboveVwap(1) + ltpAboveEma21(1) = 2
        //                     bearScore = !macdBullish(1) + rsiOverbought(1) = 2
        // |bullScore - bearScore| = 0 → confidence = 'LOW'
        currentLtp: 22450, // slightly above VWAP → ltpAboveVwap = true
        vwap: 22400,
        ema21: 22420, // slightly below LTP → ltpAboveEma21 = true
        macdSignal: 'NEUTRAL', // macdBullish = false → 1 bear point
        rsi14: 61, // rsiOverbought (>60) = true → 1 bear point
      }),
    );

    const lowConfidence = result.analystOutputs.filter((a) => a.confidence === 'LOW').length;
    expect(lowConfidence).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11–12. Portfolio decision structure
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentOrchestratorService — portfolio decision structure', () => {
  it('portfolioManager.finalVerdict is one of EXECUTE | SKIP | PAPER_ONLY', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(makeContext());

    expect(VALID_VERDICTS.has(result.portfolioManager.finalVerdict)).toBe(true);
  });

  it('portfolioManager.verdictReason is a non-empty string', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(makeContext());

    expect(typeof result.portfolioManager.verdictReason).toBe('string');
    expect(result.portfolioManager.verdictReason.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13–16. Safety invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentOrchestratorService — safety invariants', () => {
  it('ResearchDecision is advisory only — no broker order fields present', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(makeContext());

    // The result must NOT contain broker order fields — it is research output only
    expect(result).not.toHaveProperty('dhanOrderId');
    expect(result).not.toHaveProperty('quantity');
    expect(result).not.toHaveProperty('price');
    expect(result).not.toHaveProperty('transactionType');
  });

  it('workflow completes without throwing when LLM throws LlmUnavailableError on every call', async () => {
    const llm = {
      call: jest.fn().mockRejectedValue(new LlmUnavailableError('API key missing')),
      isAvailable: jest.fn().mockReturnValue(false),
      getProvider: jest.fn().mockReturnValue('openai'),
      getAvailabilityStatus: jest.fn().mockResolvedValue('CREDENTIALS_MISSING'),
    } as unknown as LlmClientService;

    const service = new AgentOrchestratorService(llm);

    // Must NOT throw — workflow must complete with fallback decision
    await expect(service.runWorkflow(makeContext())).resolves.toBeDefined();
  });

  it('workflow completes without throwing when every LLM call times out', async () => {
    const llm = {
      call: jest.fn().mockRejectedValue(new LlmTimeoutError('openai', 5000)),
      isAvailable: jest.fn().mockReturnValue(true),
      getProvider: jest.fn().mockReturnValue('openai'),
      getAvailabilityStatus: jest.fn().mockResolvedValue('CONFIGURED'),
    } as unknown as LlmClientService;

    const service = new AgentOrchestratorService(llm);

    await expect(service.runWorkflow(makeContext())).resolves.toBeDefined();
  });

  it('portfolioManager verdict is structurally valid in a bearish / high-vix context', async () => {
    const service = new AgentOrchestratorService(makeDisabledLlm());
    const result = await service.runWorkflow(
      makeContext({
        currentLtp: 21000, // deep below VWAP
        vwap: 22400,
        ema21: 22500,
        macdSignal: 'BEARISH',
        rsi14: 72,
        marketRegime: 'STRONG_BEAR',
        vix: 22,
        ivRegime: 'EXPANDING',
      }),
    );

    expect(result.portfolioManager).not.toBeNull();
    expect(VALID_VERDICTS.has(result.portfolioManager.finalVerdict)).toBe(true);
    expect(result.portfolioManager.verdictReason.length).toBeGreaterThan(0);
  });
});
