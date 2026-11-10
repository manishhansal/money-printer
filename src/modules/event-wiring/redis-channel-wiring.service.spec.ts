/**
 * redis-channel-wiring.service.spec.ts
 *
 * Unit tests for RedisChannelWiringService.
 *
 * Covers:
 *   1. Service initialises without errors.
 *   2. Subscribes to `events:regime_change` channel.
 *   3. Subscribes to `events:session_phase` channel.
 *   4. Parsed regime-change message triggers LiveTradingService handler.
 *   5. Parsed session-phase message triggers LiveTradingService handler.
 *
 * Requirements: 2.1, 5.3, 17.5
 */

import { Test, TestingModule } from '@nestjs/testing';

import { RedisChannelWiringService } from './redis-channel-wiring.service';
import { RedisService } from '../redis/redis.service';
import { PositionMonitoringService } from '../position-monitoring/position-monitoring.service';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { LiveTradingService } from '../live-trading/live-trading.service';

import {
  REGIME_CHANGE_CHANNEL,
  RegimeChangeEvent,
  MarketRegime,
} from '../market-regime/market-regime.types';
import {
  SESSION_PHASE_CHANNEL,
  SessionPhase,
  SessionPhaseChangeEvent,
} from '../session-manager/session-manager.types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type RedisMessageHandler = (channel: string, message: string) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisChannelWiringService', () => {
  let service: RedisChannelWiringService;
  let redisService: jest.Mocked<Pick<RedisService, 'subscribe'>>;
  let sessionManagerService: jest.Mocked<Pick<SessionManagerService, 'getCurrentPhase'>>;
  let liveTradingService: jest.Mocked<Pick<LiveTradingService, 'onSessionPhaseChanged'>>;

  /**
   * Map of channel name → captured subscription callback.
   * Used in tests to simulate incoming Redis messages.
   */
  const capturedHandlers = new Map<string, RedisMessageHandler>();

  beforeEach(async () => {
    capturedHandlers.clear();

    // ── Mock RedisService ──────────────────────────────────────────────────
    // Capture the callback so tests can invoke it to simulate messages.
    const mockRedisService: jest.Mocked<Pick<RedisService, 'subscribe'>> = {
      subscribe: jest
        .fn()
        .mockImplementation(async (channel: string, handler: RedisMessageHandler) => {
          capturedHandlers.set(channel, handler);
        }),
    };

    // ── Mock PositionMonitoringService ─────────────────────────────────────
    // Only getTrackedPositionIds() is called in the startup log message.
    const mockPositionMonitoringService: Partial<PositionMonitoringService> = {
      getTrackedPositionIds: jest.fn().mockReturnValue([]),
    };

    // ── Mock SessionManagerService ─────────────────────────────────────────
    const mockSessionManagerService: jest.Mocked<Pick<SessionManagerService, 'getCurrentPhase'>> = {
      getCurrentPhase: jest.fn().mockReturnValue(SessionPhase.MORNING_MOMENTUM),
    };

    // ── Mock LiveTradingService ────────────────────────────────────────────
    const mockLiveTradingService: jest.Mocked<Pick<LiveTradingService, 'onSessionPhaseChanged'>> = {
      onSessionPhaseChanged: jest.fn(),
    };

    // ── Build testing module ───────────────────────────────────────────────
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisChannelWiringService,
        { provide: RedisService, useValue: mockRedisService },
        {
          provide: PositionMonitoringService,
          useValue: mockPositionMonitoringService,
        },
        {
          provide: SessionManagerService,
          useValue: mockSessionManagerService,
        },
        { provide: LiveTradingService, useValue: mockLiveTradingService },
      ],
    }).compile();

    service = module.get<RedisChannelWiringService>(RedisChannelWiringService);
    redisService = module.get(RedisService);
    sessionManagerService = module.get(SessionManagerService);
    liveTradingService = module.get(LiveTradingService);

    // Trigger the lifecycle hook so subscriptions are registered.
    await service.onModuleInit();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1 — initialises without errors
  // ─────────────────────────────────────────────────────────────────────────

  it('should initialise without errors', () => {
    expect(service).toBeDefined();
    // subscribe() should have been called exactly twice (regime + session phase).
    expect(redisService.subscribe).toHaveBeenCalledTimes(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2 — subscribes to events:regime_change
  // ─────────────────────────────────────────────────────────────────────────

  it('should subscribe to the events:regime_change channel', () => {
    expect(redisService.subscribe).toHaveBeenCalledWith(
      REGIME_CHANGE_CHANNEL,
      expect.any(Function),
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3 — subscribes to events:session_phase
  // ─────────────────────────────────────────────────────────────────────────

  it('should subscribe to the events:session_phase channel', () => {
    expect(redisService.subscribe).toHaveBeenCalledWith(
      SESSION_PHASE_CHANNEL,
      expect.any(Function),
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4 — regime-change message triggers LiveTradingService handler
  // ─────────────────────────────────────────────────────────────────────────

  it('should call LiveTradingService.onSessionPhaseChanged when a regime-change message arrives', () => {
    const handler = capturedHandlers.get(REGIME_CHANGE_CHANNEL);
    expect(handler).toBeDefined();

    const mockRegimeEvent: RegimeChangeEvent = {
      regime: MarketRegime.STRONG_BULL,
      previousRegime: MarketRegime.UNSTABLE,
      inputs: {
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'BULLISH',
        marketBreadth: 68,
        advanceDeclineRatio: 2.8,
        vwapDeviation: 0.4,
        indiaVix: 14.5,
        atr: 110,
        relativeVolume: 1.9,
        sectorStrength: null,
        futuresBasis: null,
      },
      rationale: 'Strong bull: NIFTY=BULLISH, BANKNIFTY=BULLISH, breadth=68.0%, relVol=1.90',
      classifiedAt: new Date('2024-01-15T04:00:00.000Z'),
    };

    handler!(REGIME_CHANGE_CHANNEL, JSON.stringify(mockRegimeEvent));

    // LiveTradingService handler must be called with the current session phase.
    expect(liveTradingService.onSessionPhaseChanged).toHaveBeenCalledTimes(1);
    expect(liveTradingService.onSessionPhaseChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: SessionPhase.MORNING_MOMENTUM,
        previousPhase: SessionPhase.MORNING_MOMENTUM,
        timestamp: expect.any(Date),
      }),
    );

    // Verify SessionManagerService was consulted for the current phase.
    expect(sessionManagerService.getCurrentPhase).toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5 — session-phase message triggers LiveTradingService handler
  // ─────────────────────────────────────────────────────────────────────────

  it('should call LiveTradingService.onSessionPhaseChanged when a session-phase message arrives', () => {
    const handler = capturedHandlers.get(SESSION_PHASE_CHANNEL);
    expect(handler).toBeDefined();

    const mockPhaseEvent: SessionPhaseChangeEvent = {
      phase: SessionPhase.CLOSING,
      previousPhase: SessionPhase.AFTERNOON,
      timestamp: new Date('2024-01-15T09:00:00.000Z'),
    };

    handler!(SESSION_PHASE_CHANNEL, JSON.stringify(mockPhaseEvent));

    // LiveTradingService handler must be called with the parsed phase event.
    expect(liveTradingService.onSessionPhaseChanged).toHaveBeenCalledTimes(1);
    expect(liveTradingService.onSessionPhaseChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: SessionPhase.CLOSING,
        previousPhase: SessionPhase.AFTERNOON,
        timestamp: expect.any(Date),
      }),
    );
  });
});
