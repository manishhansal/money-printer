/**
 * target-and-runner.service.spec.ts
 *
 * Unit tests for TargetAndRunnerService — post-target continuation and runner mode.
 *
 * Requirements: Phase 7 — Target and Runner Engine
 */

import { Test, TestingModule } from '@nestjs/testing';
import { TargetAndRunnerService, PositionState, TradePhase } from './target-and-runner.service';
import { GreedyTrailService } from './greedy-trail.service';
import { TrailingStopMechanism } from '../trailing-stop/trailing-stop.types';

// ---------------------------------------------------------------------------
// Mock GreedyTrailService
// ---------------------------------------------------------------------------

function makeGreedyTrailService() {
  return {
    decide: jest.fn(),
    firstTargetFraction: 0.5,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePosition(overrides: Partial<PositionState> = {}): PositionState {
  return {
    positionId: 'pos-001',
    direction: 'LONG',
    entryPrice: '100.00',
    currentStopLoss: '95.00',
    target1Price: '110.00',
    quantityUnits: 150, // 2 lots × 75
    lotSize: 75,
    instrumentId: 'instr-001',
    entryVolume: 50000,
    atr: 5,
    currentPhase: 'ENTRY' as TradePhase,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TargetAndRunnerService', () => {
  let service: TargetAndRunnerService;
  let greedyTrailService: ReturnType<typeof makeGreedyTrailService>;

  beforeEach(async () => {
    greedyTrailService = makeGreedyTrailService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TargetAndRunnerService,
        { provide: GreedyTrailService, useValue: greedyTrailService },
      ],
    }).compile();

    service = module.get<TargetAndRunnerService>(TargetAndRunnerService);
  });

  // ── ENTRY phase: watching for Target 1 ───────────────────────────────────

  describe('ENTRY phase', () => {
    it('returns HOLD when price has not reached Target 1', async () => {
      const position = makePosition({ currentPhase: 'ENTRY' });
      const result = await service.evaluatePosition(position, 105); // below target of 110

      expect(result.action).toBe('HOLD');
      expect(result.newPhase).toBe('ENTRY');
    });

    it('returns FULL_EXIT when SL is hit', async () => {
      const position = makePosition({ currentPhase: 'ENTRY' });
      const result = await service.evaluatePosition(position, 94); // below SL of 95

      expect(result.action).toBe('FULL_EXIT');
      expect(result.exitUnits).toBe(150);
    });

    it('transitions to TARGET1_REACHED when price reaches target', async () => {
      const position = makePosition({ currentPhase: 'ENTRY' });

      // Mock greedy to say "do not trail" (take full profit)
      greedyTrailService.decide.mockResolvedValue({
        shouldTrail: false,
        passedConditions: 1,
        reason: 'Only 1/3 conditions met',
      });

      const result = await service.evaluatePosition(position, 110); // at target
      expect(result.action).toBe('FULL_EXIT');
    });
  });

  // ── Target 1 evaluation ───────────────────────────────────────────────────

  describe('Target 1 evaluation', () => {
    it('recommends FULL_EXIT when greedy conditions not met (< 2/3)', async () => {
      const position = makePosition({ currentPhase: 'ENTRY' });

      greedyTrailService.decide.mockResolvedValue({
        shouldTrail: false,
        passedConditions: 1,
        reason: 'Volume condition failed',
      });

      const result = await service.evaluatePosition(position, 110);
      expect(result.action).toBe('FULL_EXIT');
      expect(result.exitUnits).toBe(150);
    });

    it('activates RUNNER mode when greedy conditions met (2/3)', async () => {
      const position = makePosition({ currentPhase: 'ENTRY' });

      greedyTrailService.decide.mockResolvedValue({
        shouldTrail: true,
        passedConditions: 2,
        reason: '2/3 conditions met',
        mechanism: TrailingStopMechanism.ATR_BASED,
        config: { mechanism: TrailingStopMechanism.ATR_BASED, multiplier: 2.0 },
      });

      const result = await service.evaluatePosition(position, 110);
      expect(result.action).toBe('ACTIVATE_RUNNER');
      expect(result.newPhase).toBe('RUNNER');
      expect(result.trailingMechanism).toBe(TrailingStopMechanism.ATR_BASED);
    });

    it('partial exit is whole-lot-aware (never fractional lots)', async () => {
      const position = makePosition({ currentPhase: 'ENTRY', quantityUnits: 150, lotSize: 75 });

      greedyTrailService.decide.mockResolvedValue({
        shouldTrail: true,
        passedConditions: 3,
        reason: 'All conditions met',
        mechanism: TrailingStopMechanism.CHANDELIER_EXIT,
        config: { mechanism: TrailingStopMechanism.CHANDELIER_EXIT, period: 14, multiplier: 3.0 },
      });

      const result = await service.evaluatePosition(position, 110);
      expect(result.action).toBe('ACTIVATE_RUNNER');
      // exitUnits must be a multiple of lotSize=75
      expect(result.exitUnits! % 75).toBe(0);
    });

    it('single lot (75 units): takes full profit instead of partial exit', async () => {
      const position = makePosition({ currentPhase: 'ENTRY', quantityUnits: 75, lotSize: 75 });

      greedyTrailService.decide.mockResolvedValue({
        shouldTrail: true,
        passedConditions: 3,
        reason: 'All conditions met',
        mechanism: TrailingStopMechanism.CHANDELIER_EXIT,
        config: { mechanism: TrailingStopMechanism.CHANDELIER_EXIT, period: 14, multiplier: 3.0 },
      });

      const result = await service.evaluatePosition(position, 110);
      // Cannot do partial exit on single lot — full exit
      expect(result.action).toBe('FULL_EXIT');
    });

    it('sets new SL to entry price (break-even) on RUNNER activation', async () => {
      const position = makePosition({ currentPhase: 'ENTRY' });

      greedyTrailService.decide.mockResolvedValue({
        shouldTrail: true,
        passedConditions: 2,
        reason: '2/3 met',
        mechanism: TrailingStopMechanism.ATR_BASED,
        config: { mechanism: TrailingStopMechanism.ATR_BASED, multiplier: 2.0 },
      });

      const result = await service.evaluatePosition(position, 110);
      expect(result.newStopLoss).toBe('100.00'); // entry price = break-even
    });
  });

  // ── RUNNER phase ──────────────────────────────────────────────────────────

  describe('RUNNER phase', () => {
    it('holds when trailing SL not hit', async () => {
      const position = makePosition({
        currentPhase: 'RUNNER',
        currentStopLoss: '102.00', // SL at 102, price at 115 → not hit
      });
      const result = await service.evaluatePosition(position, 115);
      expect(result.action).toBe('HOLD');
      expect(result.newPhase).toBe('RUNNER');
    });

    it('exits when trailing SL is hit in RUNNER phase', async () => {
      const position = makePosition({
        currentPhase: 'RUNNER',
        currentStopLoss: '108.00',
        quantityUnits: 75, // 1 lot remaining after partial
        lotSize: 75,
      });
      const result = await service.evaluatePosition(position, 107); // below SL

      expect(result.action).toBe('FULL_EXIT');
      expect(result.newPhase).toBe('FULL_EXIT');
      expect(result.exitUnits).toBe(75);
    });
  });

  // ── Greedy trail failure fallback ─────────────────────────────────────────

  describe('Greedy trail failure fallback', () => {
    it('defaults to FULL_EXIT when GreedyTrailService throws', async () => {
      const position = makePosition({ currentPhase: 'ENTRY' });
      greedyTrailService.decide.mockRejectedValue(new Error('Redis unavailable'));

      const result = await service.evaluatePosition(position, 110);
      expect(result.action).toBe('FULL_EXIT');
      expect(result.reason).toContain('Could not evaluate');
    });
  });
});
