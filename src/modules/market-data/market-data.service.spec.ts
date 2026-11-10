/**
 * market-data.service.spec.ts
 *
 * Unit tests for MarketDataService feed-staleness detector.
 *
 * Covers:
 *  1. isMarketDataStale() returns false when a fresh tick was received within
 *     the configured threshold.
 *  2. isMarketDataStale() returns true when no tick has been received for
 *     longer than max_allowed_data_age.
 *  3. checkFeedStaleness() emits MARKET_DATA_STALE_EVENT and publishes a
 *     WARNING notification when the threshold is exceeded.
 *  4. checkFeedStaleness() emits MARKET_DATA_FRESH_EVENT and publishes an
 *     INFO notification when freshness is restored after a stale period.
 *  5. Only the leading edge of each transition triggers an event (no duplicate
 *     emissions when the feed stays stale across multiple cron ticks).
 *  6. getDataAge() returns the elapsed milliseconds since lastTickReceivedAt.
 *
 * Time control: jest fake timers are used so Date.now() and new Date() can be
 * advanced deterministically without real-time delays.
 *
 * Requirements: 9.6
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MarketDataService, DEFAULT_MAX_ALLOWED_DATA_AGE_MS } from './market-data.service';
import { NotificationService } from '../notification/notification.service';
import {
  MARKET_DATA_FRESH_EVENT,
  MARKET_DATA_STALE_EVENT,
  MARKET_TICK_RECEIVED_EVENT,
} from './market-data.types';

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

const mockEventEmitter = {
  emit: jest.fn(),
} as unknown as EventEmitter2;

const mockNotificationService = {
  publish: jest.fn().mockResolvedValue(undefined),
} as unknown as NotificationService;

/** Returns a ConfigService mock that resolves MAX_MARKET_DATA_AGE_MS to the given value. */
function buildConfigService(maxAgeMs: number = DEFAULT_MAX_ALLOWED_DATA_AGE_MS) {
  return {
    get: jest
      .fn()
      .mockImplementation((_key: string, defaultVal?: number) => maxAgeMs ?? defaultVal),
  } as unknown as ConfigService;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('MarketDataService — feed-staleness detector', () => {
  let service: MarketDataService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Use fake timers so Date.now() / new Date() are fully controllable.
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketDataService,
        { provide: ConfigService, useValue: buildConfigService() },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();

    service = module.get<MarketDataService>(MarketDataService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1 & 2 — isMarketDataStale()
  // ─────────────────────────────────────────────────────────────────────────

  describe('isMarketDataStale()', () => {
    it('returns false immediately after a tick is received (age = 0 ms)', () => {
      service.onTickReceived();
      expect(service.isMarketDataStale()).toBe(false);
    });

    it('returns false when tick age is exactly at the threshold boundary (age = max_age)', () => {
      service.onTickReceived();
      // Advance by exactly maxAllowedDataAgeMs — NOT strictly greater than, so still fresh.
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS);
      expect(service.isMarketDataStale()).toBe(false);
    });

    it('returns false when a fresh tick was received within the allowed age window', () => {
      service.onTickReceived();
      // Advance by one millisecond less than the threshold — feed is still fresh.
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS - 1);
      expect(service.isMarketDataStale()).toBe(false);
    });

    it('returns true when no tick received for longer than max_allowed_data_age', () => {
      service.onTickReceived();
      // Advance past the threshold by 1 ms — now stale.
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 1);
      expect(service.isMarketDataStale()).toBe(true);
    });

    it('returns true when no tick received for significantly longer than max_age', () => {
      service.onTickReceived();
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS * 3);
      expect(service.isMarketDataStale()).toBe(true);
    });

    it('returns false again after a fresh tick resets the timestamp', () => {
      service.onTickReceived();
      // Go stale.
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 100);
      expect(service.isMarketDataStale()).toBe(true);

      // Receive a fresh tick — lastTickReceivedAt resets to current fake time.
      service.onTickReceived();
      expect(service.isMarketDataStale()).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getDataAge()
  // ─────────────────────────────────────────────────────────────────────────

  describe('getDataAge()', () => {
    it('returns approximately 0 ms immediately after onTickReceived()', () => {
      service.onTickReceived();
      expect(service.getDataAge()).toBe(0);
    });

    it('returns the elapsed ms since the last tick', () => {
      service.onTickReceived();
      const advanceMs = 2_500;
      jest.advanceTimersByTime(advanceMs);
      expect(service.getDataAge()).toBe(advanceMs);
    });

    it('resets after a new tick', () => {
      service.onTickReceived();
      jest.advanceTimersByTime(3_000);
      service.onTickReceived(); // Reset
      jest.advanceTimersByTime(500);
      expect(service.getDataAge()).toBe(500);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3 — Staleness event emitted and WARNING notification published
  // ─────────────────────────────────────────────────────────────────────────

  describe('checkFeedStaleness() — fresh → stale transition', () => {
    it('emits MARKET_DATA_STALE_EVENT with correct payload when threshold exceeded', async () => {
      service.onTickReceived();
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 1);

      await service.checkFeedStaleness();

      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        MARKET_DATA_STALE_EVENT,
        expect.objectContaining({
          dataAgeMs: expect.any(Number),
          maxAllowedMs: DEFAULT_MAX_ALLOWED_DATA_AGE_MS,
          detectedAt: expect.any(Date),
        }),
      );

      const [, payload] = (mockEventEmitter.emit as jest.Mock).mock.calls[0];
      expect(payload.dataAgeMs).toBeGreaterThan(DEFAULT_MAX_ALLOWED_DATA_AGE_MS);
    });

    it('publishes a WARNING priority alert when feed goes stale', async () => {
      service.onTickReceived();
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 1);

      await service.checkFeedStaleness();

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'WARNING',
          title: 'Market data feed is stale — order submissions blocked',
        }),
      );
    });

    it('publishes alert with a valid UUID id field', async () => {
      service.onTickReceived();
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 1);

      await service.checkFeedStaleness();

      const [alert] = (mockNotificationService.publish as jest.Mock).mock.calls[0];
      // UUID v4 pattern
      expect(alert.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('does NOT emit a second event when cron fires again while still stale', async () => {
      service.onTickReceived();
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 1);

      await service.checkFeedStaleness(); // leading edge — event emitted
      await service.checkFeedStaleness(); // still stale — no duplicate event

      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4 — Fresh event emitted when data resumes after staleness
  // ─────────────────────────────────────────────────────────────────────────

  describe('checkFeedStaleness() — stale → fresh transition', () => {
    it('emits MARKET_DATA_FRESH_EVENT after a tick arrives during a stale period', async () => {
      // Set up stale state.
      service.onTickReceived();
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 1);
      await service.checkFeedStaleness(); // wasStale = true

      // Receive a fresh tick.
      service.onTickReceived();
      await service.checkFeedStaleness(); // wasStale = false → freshness event

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        MARKET_DATA_FRESH_EVENT,
        expect.objectContaining({ detectedAt: expect.any(Date) }),
      );
    });

    it('publishes an INFO priority alert when freshness is restored', async () => {
      // Drive stale transition first.
      service.onTickReceived();
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 1);
      await service.checkFeedStaleness();

      jest.clearAllMocks(); // clear stale-transition calls for isolation

      // Now restore.
      service.onTickReceived();
      await service.checkFeedStaleness();

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'INFO',
          title: 'Market data feed restored',
        }),
      );
    });

    it('does NOT emit fresh event again if cron fires and feed is still fresh', async () => {
      // Drive stale → fresh.
      service.onTickReceived();
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 1);
      await service.checkFeedStaleness(); // stale

      service.onTickReceived();
      await service.checkFeedStaleness(); // stale → fresh (event #1)

      jest.clearAllMocks();

      // Another cron tick — still fresh, no event.
      service.onTickReceived();
      await service.checkFeedStaleness();

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('MARKET_DATA_STALE_EVENT is emitted before MARKET_DATA_FRESH_EVENT', async () => {
      const emittedEvents: string[] = [];
      (mockEventEmitter.emit as jest.Mock).mockImplementation((event: string) => {
        emittedEvents.push(event);
      });

      // stale
      service.onTickReceived();
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS + 1);
      await service.checkFeedStaleness();

      // fresh
      service.onTickReceived();
      await service.checkFeedStaleness();

      expect(emittedEvents).toEqual([MARKET_DATA_STALE_EVENT, MARKET_DATA_FRESH_EVENT]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge cases
  // ─────────────────────────────────────────────────────────────────────────

  describe('checkFeedStaleness() — no events when feed stays fresh', () => {
    it('does not emit any events when feed is always fresh', async () => {
      service.onTickReceived(); // freshly received tick
      // Advance well within threshold.
      jest.advanceTimersByTime(DEFAULT_MAX_ALLOWED_DATA_AGE_MS / 2);

      await service.checkFeedStaleness();
      await service.checkFeedStaleness();

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      expect(mockNotificationService.publish).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Configuration — custom max age via ConfigService
  // ─────────────────────────────────────────────────────────────────────────

  describe('custom maxAllowedDataAgeMs via ConfigService', () => {
    it('uses the configured value from ConfigService', async () => {
      const customMaxAge = 2_000;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MarketDataService,
          { provide: ConfigService, useValue: buildConfigService(customMaxAge) },
          { provide: EventEmitter2, useValue: mockEventEmitter },
          { provide: NotificationService, useValue: mockNotificationService },
        ],
      }).compile();

      const customService = module.get<MarketDataService>(MarketDataService);

      expect(customService.maxAllowedDataAgeMs).toBe(customMaxAge);

      // Should be fresh within 2 000 ms.
      customService.onTickReceived();
      jest.advanceTimersByTime(customMaxAge);
      expect(customService.isMarketDataStale()).toBe(false);

      // Should be stale after 2 001 ms.
      jest.advanceTimersByTime(1);
      expect(customService.isMarketDataStale()).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Event name constant exports
  // ─────────────────────────────────────────────────────────────────────────

  describe('exported event name constants', () => {
    it('MARKET_DATA_STALE_EVENT equals "market.data.stale"', () => {
      expect(MARKET_DATA_STALE_EVENT).toBe('market.data.stale');
    });

    it('MARKET_DATA_FRESH_EVENT equals "market.data.fresh"', () => {
      expect(MARKET_DATA_FRESH_EVENT).toBe('market.data.fresh');
    });

    it('MARKET_TICK_RECEIVED_EVENT equals "market.tick.received"', () => {
      expect(MARKET_TICK_RECEIVED_EVENT).toBe('market.tick.received');
    });
  });
});
