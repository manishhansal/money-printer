/**
 * session-manager.service.spec.ts
 *
 * Unit tests for SessionManagerService.
 *
 * Covers:
 *  - Phase determination at each IST boundary time
 *  - MARKET_CLOSED outside trading hours
 *  - Phase transition triggers Redis set + Redis publish
 *  - Opening Volatility detection accuracy at 09:15 and 09:20
 *  - isWithinMarketHours() and isOpeningVolatilityPhase() helpers
 *
 * All boundary times are expressed in UTC and converted to IST (UTC+05:30)
 * by the service internally. For clarity each test comment also states the
 * equivalent IST time.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SessionManagerService } from './session-manager.service';
import { RedisService } from '../redis/redis.service';
import {
  SessionPhase,
  SESSION_PHASE_KEY,
  SESSION_PHASE_CHANNEL,
  SESSION_PHASE_CHANGED_EVENT,
} from './session-manager.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a UTC Date that corresponds to the given IST hh:mm on an arbitrary day. */
function istToUtc(hours: number, minutes: number): Date {
  // IST = UTC+05:30, so UTC = IST - 05:30
  const totalUtcMinutes = hours * 60 + minutes - (5 * 60 + 30);
  // Use a fixed reference date (2024-01-15) to avoid DST / date-rollover edge cases.
  const date = new Date(Date.UTC(2024, 0, 15, 0, 0, 0, 0));
  date.setUTCMinutes(date.getUTCMinutes() + totalUtcMinutes);
  return date;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRedisSet = jest.fn().mockResolvedValue(undefined);
const mockPublish = jest.fn().mockResolvedValue(1);

const mockRedisService = {
  set: mockRedisSet,
  publish: mockPublish,
} as unknown as RedisService;

const mockEventEmitter = {
  emit: jest.fn(),
} as unknown as EventEmitter2;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SessionManagerService', () => {
  let service: SessionManagerService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionManagerService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<SessionManagerService>(SessionManagerService);
  });

  // -------------------------------------------------------------------------
  // Phase determination — boundary correctness
  // -------------------------------------------------------------------------

  describe('determinePhase() — phase boundaries', () => {
    it('returns MARKET_CLOSED before 09:00 IST (08:59 IST)', () => {
      expect(service.determinePhase(istToUtc(8, 59))).toBe(SessionPhase.MARKET_CLOSED);
    });

    it('returns PRE_MARKET at 09:00 IST (start of trading window)', () => {
      expect(service.determinePhase(istToUtc(9, 0))).toBe(SessionPhase.PRE_MARKET);
    });

    it('returns PRE_MARKET at 09:14 IST (last minute of PRE_MARKET)', () => {
      expect(service.determinePhase(istToUtc(9, 14))).toBe(SessionPhase.PRE_MARKET);
    });

    it('returns OPENING_VOLATILITY at exactly 09:15 IST', () => {
      expect(service.determinePhase(istToUtc(9, 15))).toBe(SessionPhase.OPENING_VOLATILITY);
    });

    it('returns OPENING_VOLATILITY at 09:19 IST (last minute of OPENING_VOLATILITY)', () => {
      expect(service.determinePhase(istToUtc(9, 19))).toBe(SessionPhase.OPENING_VOLATILITY);
    });

    it('returns ORB_FORMATION at exactly 09:20 IST (end of OPENING_VOLATILITY)', () => {
      expect(service.determinePhase(istToUtc(9, 20))).toBe(SessionPhase.ORB_FORMATION);
    });

    it('returns ORB_FORMATION at 09:29 IST (last minute of ORB window)', () => {
      expect(service.determinePhase(istToUtc(9, 29))).toBe(SessionPhase.ORB_FORMATION);
    });

    it('returns MORNING_MOMENTUM at 09:30 IST', () => {
      expect(service.determinePhase(istToUtc(9, 30))).toBe(SessionPhase.MORNING_MOMENTUM);
    });

    it('returns MORNING_MOMENTUM at 10:59 IST (last minute of morning window)', () => {
      expect(service.determinePhase(istToUtc(10, 59))).toBe(SessionPhase.MORNING_MOMENTUM);
    });

    it('returns MID_SESSION at 11:00 IST', () => {
      expect(service.determinePhase(istToUtc(11, 0))).toBe(SessionPhase.MID_SESSION);
    });

    it('returns MID_SESSION at 12:59 IST', () => {
      expect(service.determinePhase(istToUtc(12, 59))).toBe(SessionPhase.MID_SESSION);
    });

    it('returns AFTERNOON at 13:00 IST', () => {
      expect(service.determinePhase(istToUtc(13, 0))).toBe(SessionPhase.AFTERNOON);
    });

    it('returns AFTERNOON at 14:29 IST', () => {
      expect(service.determinePhase(istToUtc(14, 29))).toBe(SessionPhase.AFTERNOON);
    });

    it('returns CLOSING at 14:30 IST', () => {
      expect(service.determinePhase(istToUtc(14, 30))).toBe(SessionPhase.CLOSING);
    });

    it('returns CLOSING at 15:29 IST', () => {
      expect(service.determinePhase(istToUtc(15, 29))).toBe(SessionPhase.CLOSING);
    });

    it('returns EOD_RECONCILIATION at 15:30 IST', () => {
      expect(service.determinePhase(istToUtc(15, 30))).toBe(SessionPhase.EOD_RECONCILIATION);
    });

    it('returns EOD_RECONCILIATION at 15:59 IST', () => {
      expect(service.determinePhase(istToUtc(15, 59))).toBe(SessionPhase.EOD_RECONCILIATION);
    });

    it('returns MARKET_CLOSED at 16:00 IST (end of trading window)', () => {
      expect(service.determinePhase(istToUtc(16, 0))).toBe(SessionPhase.MARKET_CLOSED);
    });

    it('returns MARKET_CLOSED after 16:00 IST (17:00 IST)', () => {
      expect(service.determinePhase(istToUtc(17, 0))).toBe(SessionPhase.MARKET_CLOSED);
    });

    it('returns MARKET_CLOSED at midnight IST (00:00)', () => {
      expect(service.determinePhase(istToUtc(0, 0))).toBe(SessionPhase.MARKET_CLOSED);
    });
  });

  // -------------------------------------------------------------------------
  // Opening Volatility boundary accuracy (Requirement 17.2)
  // -------------------------------------------------------------------------

  describe('OPENING_VOLATILITY phase boundary — 09:15 and 09:20', () => {
    it('is NOT OPENING_VOLATILITY at 09:14 IST (one minute before)', () => {
      expect(service.determinePhase(istToUtc(9, 14))).not.toBe(SessionPhase.OPENING_VOLATILITY);
    });

    it('IS OPENING_VOLATILITY at 09:15 IST (exact start)', () => {
      expect(service.determinePhase(istToUtc(9, 15))).toBe(SessionPhase.OPENING_VOLATILITY);
    });

    it('IS OPENING_VOLATILITY at 09:19 IST (last minute)', () => {
      expect(service.determinePhase(istToUtc(9, 19))).toBe(SessionPhase.OPENING_VOLATILITY);
    });

    it('is NOT OPENING_VOLATILITY at 09:20 IST (exact end — now ORB_FORMATION)', () => {
      expect(service.determinePhase(istToUtc(9, 20))).not.toBe(SessionPhase.OPENING_VOLATILITY);
    });
  });

  // -------------------------------------------------------------------------
  // isOpeningVolatilityPhase()
  // -------------------------------------------------------------------------

  describe('isOpeningVolatilityPhase()', () => {
    it('returns true when currentPhase is OPENING_VOLATILITY', async () => {
      // Manually trigger init with a timestamp inside OPENING_VOLATILITY
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValue(SessionPhase.OPENING_VOLATILITY);
      await service.onModuleInit();
      expect(service.isOpeningVolatilityPhase()).toBe(true);
    });

    it('returns false when currentPhase is not OPENING_VOLATILITY', async () => {
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValue(SessionPhase.MORNING_MOMENTUM);
      await service.onModuleInit();
      expect(service.isOpeningVolatilityPhase()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isWithinMarketHours()
  // -------------------------------------------------------------------------

  describe('isWithinMarketHours()', () => {
    const tradingPhases: SessionPhase[] = [
      SessionPhase.PRE_MARKET,
      SessionPhase.OPENING_VOLATILITY,
      SessionPhase.ORB_FORMATION,
      SessionPhase.MORNING_MOMENTUM,
      SessionPhase.MID_SESSION,
      SessionPhase.AFTERNOON,
      SessionPhase.CLOSING,
      SessionPhase.EOD_RECONCILIATION,
    ];

    tradingPhases.forEach((phase) => {
      it(`returns true for ${phase}`, async () => {
        jest
          .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
          .mockReturnValue(phase);
        await service.onModuleInit();
        expect(service.isWithinMarketHours()).toBe(true);
      });
    });

    it('returns false for MARKET_CLOSED', async () => {
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValue(SessionPhase.MARKET_CLOSED);
      await service.onModuleInit();
      expect(service.isWithinMarketHours()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit — sets Redis key with initial phase
  // -------------------------------------------------------------------------

  describe('onModuleInit()', () => {
    it('sets the Redis key to the phase determined at init time', async () => {
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValue(SessionPhase.MID_SESSION);
      await service.onModuleInit();
      expect(mockRedisSet).toHaveBeenCalledWith(SESSION_PHASE_KEY, SessionPhase.MID_SESSION);
    });

    it('does NOT publish or emit an event on init (no transition yet)', async () => {
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValue(SessionPhase.MID_SESSION);
      await service.onModuleInit();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit as jest.Mock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // evaluatePhase() — phase transition triggers Redis + NestJS event
  // -------------------------------------------------------------------------

  describe('evaluatePhase() — phase transitions', () => {
    it('updates Redis key when phase changes', async () => {
      // Seed the service as if it started in PRE_MARKET
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.PRE_MARKET);
      await service.onModuleInit();
      jest.clearAllMocks();

      // Now the clock has moved into OPENING_VOLATILITY
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.OPENING_VOLATILITY);
      await service.evaluatePhase();

      expect(mockRedisSet).toHaveBeenCalledWith(SESSION_PHASE_KEY, SessionPhase.OPENING_VOLATILITY);
    });

    it('publishes to Redis channel when phase changes', async () => {
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.PRE_MARKET);
      await service.onModuleInit();
      jest.clearAllMocks();

      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.OPENING_VOLATILITY);
      await service.evaluatePhase();

      expect(mockPublish).toHaveBeenCalledWith(
        SESSION_PHASE_CHANNEL,
        expect.stringContaining('"phase":"OPENING_VOLATILITY"'),
      );
    });

    it('includes previousPhase and timestamp in the published event', async () => {
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.MORNING_MOMENTUM);
      await service.onModuleInit();
      jest.clearAllMocks();

      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.MID_SESSION);
      await service.evaluatePhase();

      const publishedPayload = JSON.parse((mockPublish as jest.Mock).mock.calls[0][1] as string);
      expect(publishedPayload.phase).toBe(SessionPhase.MID_SESSION);
      expect(publishedPayload.previousPhase).toBe(SessionPhase.MORNING_MOMENTUM);
      expect(publishedPayload.timestamp).toBeDefined();
    });

    it('emits NestJS event session.phase.changed when phase changes', async () => {
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.MORNING_MOMENTUM);
      await service.onModuleInit();
      jest.clearAllMocks();

      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.MID_SESSION);
      await service.evaluatePhase();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SESSION_PHASE_CHANGED_EVENT,
        expect.objectContaining({
          phase: SessionPhase.MID_SESSION,
          previousPhase: SessionPhase.MORNING_MOMENTUM,
        }),
      );
    });

    it('does NOT publish or emit when phase remains the same', async () => {
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValue(SessionPhase.MID_SESSION);
      await service.onModuleInit();
      jest.clearAllMocks();

      // Same phase on next tick
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValue(SessionPhase.MID_SESSION);
      await service.evaluatePhase();

      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('updates getCurrentPhase() after a transition', async () => {
      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.AFTERNOON);
      await service.onModuleInit();

      jest
        .spyOn<SessionManagerService, 'determinePhase'>(service, 'determinePhase')
        .mockReturnValueOnce(SessionPhase.CLOSING);
      await service.evaluatePhase();

      expect(service.getCurrentPhase()).toBe(SessionPhase.CLOSING);
    });
  });

  // -------------------------------------------------------------------------
  // Full phase sequence walkthrough
  // -------------------------------------------------------------------------

  describe('full NSE trading-day phase sequence', () => {
    const sequence: [SessionPhase, number, number][] = [
      [SessionPhase.MARKET_CLOSED, 8, 59],
      [SessionPhase.PRE_MARKET, 9, 0],
      [SessionPhase.PRE_MARKET, 9, 14],
      [SessionPhase.OPENING_VOLATILITY, 9, 15],
      [SessionPhase.OPENING_VOLATILITY, 9, 19],
      [SessionPhase.ORB_FORMATION, 9, 20],
      [SessionPhase.ORB_FORMATION, 9, 29],
      [SessionPhase.MORNING_MOMENTUM, 9, 30],
      [SessionPhase.MORNING_MOMENTUM, 10, 59],
      [SessionPhase.MID_SESSION, 11, 0],
      [SessionPhase.MID_SESSION, 12, 59],
      [SessionPhase.AFTERNOON, 13, 0],
      [SessionPhase.AFTERNOON, 14, 29],
      [SessionPhase.CLOSING, 14, 30],
      [SessionPhase.CLOSING, 15, 29],
      [SessionPhase.EOD_RECONCILIATION, 15, 30],
      [SessionPhase.EOD_RECONCILIATION, 15, 59],
      [SessionPhase.MARKET_CLOSED, 16, 0],
    ];

    sequence.forEach(([expectedPhase, h, m]) => {
      it(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST → ${expectedPhase}`, () => {
        expect(service.determinePhase(istToUtc(h, m))).toBe(expectedPhase);
      });
    });
  });
});
