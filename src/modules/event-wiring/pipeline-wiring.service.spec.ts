/**
 * PipelineWiringService unit tests.
 *
 * Coverage:
 *   1. strategy.signal.candidate event triggers signal scoring
 *   2. risk.unrealized_pnl_updated event passes unrealized P&L to risk engine
 *   3. Malformed event payload handled gracefully (no crash)
 *   4. Service initializes with all required dependencies
 *   5. Event subscription registered on module init
 *
 * All tests use in-memory stubs — no real PostgreSQL or Redis connection required.
 *
 * Requirements: 9.1, 9.2, 11.3
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PipelineWiringService } from './pipeline-wiring.service';
import { SignalScoringService } from '../signal-scoring/signal-scoring.service';
import { DailyLossStateMachineService } from '../risk-management/daily-loss-state-machine.service';
import { SignalCandidateEventPayload } from '../strategy/strategy.types';
import { PersistedScoredSignal } from '../signal-scoring/signal-scoring.types';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildMockSignalScoringService() {
  return {
    scoreAndPersistSignal: jest.fn<Promise<PersistedScoredSignal>, [unknown]>(),
  };
}

function buildMockDailyLossStateMachineService() {
  return {
    onIntradayLossUpdate: jest.fn<Promise<void>, [string, number]>(),
  };
}

/** Builds a fully valid SignalCandidateEventPayload. */
function buildValidCandidatePayload(
  overrides: Partial<SignalCandidateEventPayload> = {},
): SignalCandidateEventPayload {
  return {
    strategyId: 'strategy-uuid-001',
    evaluationId: 'evaluation-uuid-001',
    instrumentId: 'instrument-uuid-001',
    engine: 'LIVE',
    direction: 'BUY',
    entryPrice: '19500.00',
    stopLossPrice: '19400.00',
    targetPrice: '19700.00',
    positionSize: 1,
    componentScores: {
      regimeAlignment: 15,
      priceStructure: 15,
      volumeConfirmation: 15,
      momentum: 10,
      vwapTrendAlignment: 10,
      optionsFuturesConfirmation: 15,
      liquidityExecution: 10,
      rrQuality: 10,
    },
    measuredInputs: { vix: 14.5 },
    currentRrRatio: 2.0,
    minRrRatio: 1.5,
    regime: 'STRONG_BULL',
    ...overrides,
  };
}

async function buildService(
  signalScoringMock = buildMockSignalScoringService(),
  dailyLossMock = buildMockDailyLossStateMachineService(),
): Promise<{
  service: PipelineWiringService;
  signalScoring: ReturnType<typeof buildMockSignalScoringService>;
  dailyLoss: ReturnType<typeof buildMockDailyLossStateMachineService>;
}> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PipelineWiringService,
      { provide: SignalScoringService, useValue: signalScoringMock },
      { provide: DailyLossStateMachineService, useValue: dailyLossMock },
    ],
  }).compile();

  return {
    service: module.get(PipelineWiringService),
    signalScoring: signalScoringMock,
    dailyLoss: dailyLossMock,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. strategy.signal.candidate event triggers signal scoring
// ─────────────────────────────────────────────────────────────────────────────

describe('PipelineWiringService — strategy.signal.candidate triggers signal scoring', () => {
  it('calls SignalScoringService.scoreAndPersistSignal with the correct SignalInput derived from the event payload', async () => {
    const { service, signalScoring } = await buildService();

    const persistedResult: PersistedScoredSignal = {
      compositeScore: 100,
      componentScores: buildValidCandidatePayload().componentScores,
      status: 'active',
      approved: true,
      signalId: 'signal-uuid-001',
    };
    signalScoring.scoreAndPersistSignal.mockResolvedValue(persistedResult);

    const payload = buildValidCandidatePayload();
    await service.handleSignalCandidate(payload);

    expect(signalScoring.scoreAndPersistSignal).toHaveBeenCalledTimes(1);
    const calledWith = signalScoring.scoreAndPersistSignal.mock.calls[0][0] as Record<
      string,
      unknown
    >;

    // All required fields must be forwarded from the event payload to SignalInput.
    expect(calledWith.strategyId).toBe(payload.strategyId);
    expect(calledWith.instrumentId).toBe(payload.instrumentId);
    expect(calledWith.engine).toBe(payload.engine);
    expect(calledWith.direction).toBe(payload.direction);
    expect(calledWith.entryPrice).toBe(payload.entryPrice);
    expect(calledWith.stopLossPrice).toBe(payload.stopLossPrice);
    expect(calledWith.targetPrice).toBe(payload.targetPrice);
    expect(calledWith.positionSize).toBe(payload.positionSize);
    expect(calledWith.componentScores).toEqual(payload.componentScores);
    expect(calledWith.measuredInputs).toEqual(payload.measuredInputs);
    expect(calledWith.minRrRatio).toBe(payload.minRrRatio);
    expect(calledWith.currentRrRatio).toBe(payload.currentRrRatio);
    expect(calledWith.regime).toBe(payload.regime);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. risk.unrealized_pnl_updated event passes unrealized P&L to risk engine
// ─────────────────────────────────────────────────────────────────────────────

describe('PipelineWiringService — risk.unrealized_pnl_updated passes P&L to risk engine', () => {
  it('converts a negative unrealized P&L to a positive loss value and calls onIntradayLossUpdate for the LIVE engine', async () => {
    const { service, dailyLoss } = await buildService();
    dailyLoss.onIntradayLossUpdate.mockResolvedValue(undefined);

    // Negative P&L = unrealized loss of ₹5,000
    await service.handleUnrealizedPnlUpdated({ totalUnrealizedPnl: -5000 });

    expect(dailyLoss.onIntradayLossUpdate).toHaveBeenCalledTimes(1);
    expect(dailyLoss.onIntradayLossUpdate).toHaveBeenCalledWith('LIVE', 5000);
  });

  it('clamps positive unrealized P&L (open profit) to zero loss so EMERGENCY_HALT is not triggered', async () => {
    const { service, dailyLoss } = await buildService();
    dailyLoss.onIntradayLossUpdate.mockResolvedValue(undefined);

    // Positive P&L = unrealized profit of ₹2,000 → no loss
    await service.handleUnrealizedPnlUpdated({ totalUnrealizedPnl: 2000 });

    expect(dailyLoss.onIntradayLossUpdate).toHaveBeenCalledWith('LIVE', 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Malformed event payload handled gracefully (no crash)
// ─────────────────────────────────────────────────────────────────────────────

describe('PipelineWiringService — malformed payloads handled gracefully', () => {
  it('does not throw and does not call scoreAndPersistSignal when strategy.signal.candidate payload is null', async () => {
    const { service, signalScoring } = await buildService();

    await expect(service.handleSignalCandidate(null)).resolves.toBeUndefined();
    expect(signalScoring.scoreAndPersistSignal).not.toHaveBeenCalled();
  });

  it('does not throw and does not call scoreAndPersistSignal when payload is missing required fields', async () => {
    const { service, signalScoring } = await buildService();

    // Missing strategyId, engine, componentScores, etc.
    const incomplete = { direction: 'BUY', entryPrice: '100.00' };
    await expect(service.handleSignalCandidate(incomplete)).resolves.toBeUndefined();
    expect(signalScoring.scoreAndPersistSignal).not.toHaveBeenCalled();
  });

  it('does not throw and does not call onIntradayLossUpdate when risk.unrealized_pnl_updated payload is null', async () => {
    const { service, dailyLoss } = await buildService();

    await expect(service.handleUnrealizedPnlUpdated(null)).resolves.toBeUndefined();
    expect(dailyLoss.onIntradayLossUpdate).not.toHaveBeenCalled();
  });

  it('does not throw and does not call onIntradayLossUpdate when totalUnrealizedPnl is not a number', async () => {
    const { service, dailyLoss } = await buildService();

    await expect(
      service.handleUnrealizedPnlUpdated({ totalUnrealizedPnl: 'not-a-number' }),
    ).resolves.toBeUndefined();
    expect(dailyLoss.onIntradayLossUpdate).not.toHaveBeenCalled();
  });

  it('does not throw when scoreAndPersistSignal rejects (service error)', async () => {
    const { service, signalScoring } = await buildService();
    signalScoring.scoreAndPersistSignal.mockRejectedValue(new Error('DB connection lost'));

    const payload = buildValidCandidatePayload();
    await expect(service.handleSignalCandidate(payload)).resolves.toBeUndefined();
    expect(signalScoring.scoreAndPersistSignal).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Service initializes with all required dependencies
// ─────────────────────────────────────────────────────────────────────────────

describe('PipelineWiringService — initializes with all required dependencies', () => {
  it('is created successfully when SignalScoringService and DailyLossStateMachineService are provided', async () => {
    const { service } = await buildService();
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(PipelineWiringService);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Event subscription registered on module init
// ─────────────────────────────────────────────────────────────────────────────

describe('PipelineWiringService — event subscription registered on module init', () => {
  it('calls onModuleInit without throwing and both event handlers remain callable', async () => {
    const { service, signalScoring, dailyLoss } = await buildService();

    // onModuleInit must complete without error.
    expect(() => service.onModuleInit()).not.toThrow();

    // After init, event handlers remain functional.
    const result: PersistedScoredSignal = {
      compositeScore: 90,
      componentScores: buildValidCandidatePayload().componentScores,
      status: 'active',
      approved: true,
      signalId: 'signal-post-init',
    };
    signalScoring.scoreAndPersistSignal.mockResolvedValue(result);
    dailyLoss.onIntradayLossUpdate.mockResolvedValue(undefined);

    await service.handleSignalCandidate(buildValidCandidatePayload());
    await service.handleUnrealizedPnlUpdated({ totalUnrealizedPnl: -1000 });

    expect(signalScoring.scoreAndPersistSignal).toHaveBeenCalledTimes(1);
    expect(dailyLoss.onIntradayLossUpdate).toHaveBeenCalledWith('LIVE', 1000);
  });
});
