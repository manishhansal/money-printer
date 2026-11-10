/**
 * instrument-discovery.service.spec.ts
 *
 * Unit tests for InstrumentDiscoveryService.
 *
 * Covers:
 *  1. classifyInstrument() — INDEX instruments get classification='UNDERLYING'
 *     and isTradable=false (hard constraint, Requirement 4.6).
 *  2. classifyInstrument() — INDEX_OPTION instruments pass eligibility and
 *     get isTradable=true.
 *  3. classifyInstrument() — STOCK_OPTION instruments get isTradable=true
 *     when thresholds are zero (unconfigured).
 *  4. classifyInstrument() — STOCK_OPTION with non-zero thresholds and
 *     zero OI/ADV gets isTradable=false (Requirement 4.8).
 *  5. passesEligibilityCheck() — all instrument type branches including
 *     direct OI/ADV field comparisons (Requirement 4.8).
 *  6. getActiveUniverse() — queries with is_active=true AND is_tradable=true.
 *  7. isInstrumentTradable() — synchronous cache lookup.
 *  8. scanInstruments() — full scan: classifies, persists, emits event,
 *     and populates the tradable cache.
 *  9. scanInstruments() — scan failure fallback (Requirement 4.7):
 *     tradableCache unchanged, CRITICAL notification published,
 *     'instruments.scan.failed' emitted.
 * 10. scanInstruments() — scan timeout: same fallback triggered after 5 minutes.
 * 11. passesEligibilityCheck() — OI/ADV invariants (task 8.5): direct field
 *     comparisons for STOCK_OPTION; Property 3 property-based test.
 *
 * Requirements: 4.1, 4.6, 4.7, 4.8
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import * as fc from 'fast-check';
import {
  InstrumentDiscoveryService,
  INSTRUMENTS_UNIVERSE_UPDATED_EVENT,
  INSTRUMENTS_SCAN_FAILED_EVENT,
  InstrumentsUniverseUpdatedEvent,
} from './instrument-discovery.service';
import { Instruments, InstrumentType } from '../../database/entities/instruments.entity';
import { SystemHealthEvents } from '../../database/entities/system-health-events.entity';
import { NotificationService } from '../notification/notification.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Instruments entity with sensible defaults.
 * Individual tests override only the fields relevant to their assertions.
 */
function buildInstrument(overrides: Partial<Instruments> = {}): Instruments {
  return {
    id: uuidv4(),
    securityId: `sec-${uuidv4()}`,
    tradingSymbol: 'TEST',
    exchange: 'NSE',
    segment: 'NSE_FNO',
    instrumentType: 'INDEX_OPTION' as InstrumentType,
    underlying: 'NIFTY',
    expiryDate: '2025-01-30',
    strikePrice: '23000.00',
    optionType: 'CE',
    lotSize: 50,
    tickSize: '0.05',
    freezeQuantity: 1800,
    isActive: true,
    liquidityScore: '75.00',
    openInterest: 0,
    avgDailyVolume: 0,
    isTradable: false,
    lastScannedAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  } as Instruments;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function buildMockRepo() {
  return {
    find: jest.fn(),
    // Use `jest.fn()` typed as `any` to bypass TypeORM's save() overload narrowing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    save: jest.fn() as jest.MockedFunction<(...args: any[]) => any>,
    findOne: jest.fn(),
  };
}

function buildMockSystemHealthEventsRepo() {
  return {
    create: jest.fn().mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data: any) => ({ ...data }),
    ),
    save: jest.fn().mockResolvedValue({}),
  };
}

function buildMockEventEmitter() {
  return {
    emit: jest.fn(),
  };
}

function buildMockConfigService(minOi = 0, minAdv = 0) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: jest.fn().mockImplementation((key: string, defaultVal?: any): any => {
      if (key === 'MIN_OI_THRESHOLD') return minOi;
      if (key === 'MIN_ADV_THRESHOLD') return minAdv;
      return defaultVal ?? 0;
    }),
  };
}

function buildMockNotificationService() {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('InstrumentDiscoveryService', () => {
  let service: InstrumentDiscoveryService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRepo: ReturnType<typeof buildMockRepo>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSystemHealthEventsRepo: ReturnType<typeof buildMockSystemHealthEventsRepo>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEventEmitter: ReturnType<typeof buildMockEventEmitter>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockConfigService: ReturnType<typeof buildMockConfigService>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockNotificationService: ReturnType<typeof buildMockNotificationService>;

  beforeEach(async () => {
    mockRepo = buildMockRepo();
    mockSystemHealthEventsRepo = buildMockSystemHealthEventsRepo();
    mockEventEmitter = buildMockEventEmitter();
    mockConfigService = buildMockConfigService(); // thresholds = 0 by default
    mockNotificationService = buildMockNotificationService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InstrumentDiscoveryService,
        { provide: getRepositoryToken(Instruments), useValue: mockRepo },
        {
          provide: getRepositoryToken(SystemHealthEvents),
          useValue: mockSystemHealthEventsRepo,
        },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();

    service = module.get<InstrumentDiscoveryService>(InstrumentDiscoveryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. classifyInstrument() — INDEX → UNDERLYING, isTradable = false
  // ─────────────────────────────────────────────────────────────────────────

  describe('classifyInstrument() — INDEX instruments', () => {
    it('classifies INDEX as UNDERLYING with isTradable = false', () => {
      const index = buildInstrument({ instrumentType: 'INDEX', segment: 'IDX_I' });

      const result = service.classifyInstrument(index, 0, 0);

      expect(result.classification).toBe('UNDERLYING');
      expect(result.isTradable).toBe(false);
    });

    it('keeps INDEX instruments isActive = true (needed for signal computation)', () => {
      const index = buildInstrument({ instrumentType: 'INDEX', segment: 'IDX_I' });

      const result = service.classifyInstrument(index, 0, 0);

      expect(result.isActive).toBe(true);
    });

    it('classifies INDEX as UNDERLYING regardless of liquidity score', () => {
      const highScore = buildInstrument({
        instrumentType: 'INDEX',
        liquidityScore: '99.99',
      });
      const lowScore = buildInstrument({
        instrumentType: 'INDEX',
        liquidityScore: '0.00',
      });

      expect(service.classifyInstrument(highScore, 0, 0).isTradable).toBe(false);
      expect(service.classifyInstrument(lowScore, 0, 0).isTradable).toBe(false);
    });

    it('classifies INDEX as UNDERLYING regardless of configured OI/ADV thresholds', () => {
      const index = buildInstrument({
        instrumentType: 'INDEX',
        liquidityScore: '100.00',
      });

      // Even with zero thresholds (no restriction), INDEX stays non-tradable.
      expect(service.classifyInstrument(index, 0, 0).isTradable).toBe(false);
      // Even if the caller passes large thresholds, INDEX stays non-tradable.
      expect(service.classifyInstrument(index, 100_000, 100_000).isTradable).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. classifyInstrument() — OPTIONS pass eligibility → isTradable = true
  // ─────────────────────────────────────────────────────────────────────────

  describe('classifyInstrument() — OPTIONS instruments', () => {
    it('classifies INDEX_OPTION as TRADABLE_OPTION with isTradable = true (zero thresholds)', () => {
      const option = buildInstrument({ instrumentType: 'INDEX_OPTION' });

      const result = service.classifyInstrument(option, 0, 0);

      expect(result.classification).toBe('TRADABLE_OPTION');
      expect(result.isTradable).toBe(true);
    });

    it('classifies INDEX_OPTION as isTradable = true regardless of threshold values', () => {
      const option = buildInstrument({
        instrumentType: 'INDEX_OPTION',
        liquidityScore: '0.00', // zero score should NOT exclude index options
      });

      // Index options bypass the OI/ADV check.
      const result = service.classifyInstrument(option, 999_999, 999_999);

      expect(result.isTradable).toBe(true);
    });

    it('classifies STOCK_OPTION as isTradable = true when both thresholds are 0', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        liquidityScore: '50.00',
      });

      const result = service.classifyInstrument(option, 0, 0);

      expect(result.classification).toBe('TRADABLE_OPTION');
      expect(result.isTradable).toBe(true);
    });

    it('classifies STOCK_OPTION as isTradable = true when OI and ADV are above thresholds', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 5_000,
        avgDailyVolume: 1_000,
      });

      const result = service.classifyInstrument(option, 1_000, 500);

      expect(result.isTradable).toBe(true);
    });

    it('classifies STOCK_OPTION as isTradable = false when OI is below threshold', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 0,
        avgDailyVolume: 0,
      });

      const result = service.classifyInstrument(option, 1_000, 500);

      expect(result.isTradable).toBe(false);
    });

    it('classifies INDEX_FUTURE as isTradable = true', () => {
      const future = buildInstrument({ instrumentType: 'INDEX_FUTURE' });

      const result = service.classifyInstrument(future, 0, 0);

      expect(result.isTradable).toBe(true);
    });

    it('classifies STOCK_FUTURE as isTradable = true', () => {
      const future = buildInstrument({ instrumentType: 'STOCK_FUTURE' });

      const result = service.classifyInstrument(future, 0, 0);

      expect(result.isTradable).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. passesEligibilityCheck()
  // ─────────────────────────────────────────────────────────────────────────

  describe('passesEligibilityCheck()', () => {
    it('returns true for INDEX_OPTION regardless of threshold values', () => {
      const option = buildInstrument({
        instrumentType: 'INDEX_OPTION',
        liquidityScore: '0.00',
      });
      expect(service.passesEligibilityCheck(option, 999_999, 999_999)).toBe(true);
    });

    it('returns true for INDEX_FUTURE', () => {
      const future = buildInstrument({ instrumentType: 'INDEX_FUTURE' });
      expect(service.passesEligibilityCheck(future, 0, 0)).toBe(true);
    });

    it('returns true for STOCK_FUTURE', () => {
      const future = buildInstrument({ instrumentType: 'STOCK_FUTURE' });
      expect(service.passesEligibilityCheck(future, 0, 0)).toBe(true);
    });

    it('returns true for STOCK_OPTION when both thresholds are 0', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        liquidityScore: '0.00',
      });
      expect(service.passesEligibilityCheck(option, 0, 0)).toBe(true);
    });

    it('returns true for STOCK_OPTION with OI and ADV above configured thresholds', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 5_000,
        avgDailyVolume: 1_000,
      });
      expect(service.passesEligibilityCheck(option, 1_000, 200)).toBe(true);
    });

    it('returns false for STOCK_OPTION with OI = 0 and ADV = 0 when thresholds are configured', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 0,
        avgDailyVolume: 0,
      });
      expect(service.passesEligibilityCheck(option, 1_000, 200)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. getActiveUniverse() — only isTradable = true AND isActive = true
  // ─────────────────────────────────────────────────────────────────────────

  describe('getActiveUniverse()', () => {
    it('calls find() with is_active = true AND is_tradable = true where clause', async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      await service.getActiveUniverse();

      expect(mockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, isTradable: true },
        }),
      );
    });

    it('returns only tradable+active instruments from the repository', async () => {
      const tradableOption = buildInstrument({
        instrumentType: 'INDEX_OPTION',
        isActive: true,
        isTradable: true,
      });
      mockRepo.find.mockResolvedValueOnce([tradableOption]);

      const result = await service.getActiveUniverse();

      expect(result).toHaveLength(1);
      expect(result[0].isTradable).toBe(true);
      expect(result[0].isActive).toBe(true);
    });

    it('returns an empty array when no instruments are active and tradable', async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      const result = await service.getActiveUniverse();

      expect(result).toHaveLength(0);
    });

    it('does not return INDEX instruments (isTradable = false)', async () => {
      // The repository mock simulates the DB where clause: no INDEX instruments
      // are returned because their isTradable = false prevents matching
      // the where: { isTradable: true } filter.
      const onlyOptions: Instruments[] = [
        buildInstrument({ instrumentType: 'INDEX_OPTION', isActive: true, isTradable: true }),
        buildInstrument({ instrumentType: 'STOCK_OPTION', isActive: true, isTradable: true }),
      ];
      mockRepo.find.mockResolvedValueOnce(onlyOptions);

      const result = await service.getActiveUniverse();

      expect(result).toHaveLength(2);
      expect(result.every((i) => i.isTradable)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. isInstrumentTradable() — synchronous cache lookup
  // ─────────────────────────────────────────────────────────────────────────

  describe('isInstrumentTradable()', () => {
    it('returns false for an unknown securityId before any scan', () => {
      expect(service.isInstrumentTradable('unknown-sec-id')).toBe(false);
    });

    it('returns true for a tradable instrument after a scan', async () => {
      const option = buildInstrument({
        securityId: 'sec-option-001',
        instrumentType: 'INDEX_OPTION',
        liquidityScore: '80.00',
      });
      mockRepo.find.mockResolvedValueOnce([option]);
      mockRepo.save.mockResolvedValueOnce([option]);

      await service.scanInstruments();

      expect(service.isInstrumentTradable('sec-option-001')).toBe(true);
    });

    it('returns false for an INDEX instrument after a scan', async () => {
      const index = buildInstrument({
        securityId: 'sec-nifty-idx',
        instrumentType: 'INDEX',
        segment: 'IDX_I',
      });
      mockRepo.find.mockResolvedValueOnce([index]);
      mockRepo.save.mockResolvedValueOnce([index]);

      await service.scanInstruments();

      expect(service.isInstrumentTradable('sec-nifty-idx')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. scanInstruments() — successful scan: normal flow
  // ─────────────────────────────────────────────────────────────────────────

  describe('scanInstruments() — successful scan', () => {
    it('persists isTradable = false for INDEX and isTradable = true for INDEX_OPTION', async () => {
      const indexInstr = buildInstrument({
        securityId: 'sec-index',
        instrumentType: 'INDEX',
        isTradable: false,
      });
      const optionInstr = buildInstrument({
        securityId: 'sec-option',
        instrumentType: 'INDEX_OPTION',
        isTradable: false, // starts false, should flip to true
        liquidityScore: '70.00',
      });

      mockRepo.find.mockResolvedValueOnce([indexInstr, optionInstr]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRepo.save.mockImplementationOnce((items: any) => Promise.resolve(items));

      await service.scanInstruments();

      // The mutated entity objects passed to save() should reflect classification.
      const savedItems = (mockRepo.save as jest.Mock).mock.calls[0][0] as Instruments[];

      const savedIndex = savedItems.find((i) => i.securityId === 'sec-index')!;
      const savedOption = savedItems.find((i) => i.securityId === 'sec-option')!;

      expect(savedIndex.isTradable).toBe(false);
      expect(savedOption.isTradable).toBe(true);
    });

    it('sets lastScannedAt on every instrument', async () => {
      const instrument = buildInstrument({ lastScannedAt: null });
      mockRepo.find.mockResolvedValueOnce([instrument]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRepo.save.mockImplementationOnce((items: any) => Promise.resolve(items));

      await service.scanInstruments();

      const savedItems = (mockRepo.save as jest.Mock).mock.calls[0][0] as Instruments[];
      expect(savedItems[0].lastScannedAt).toBeInstanceOf(Date);
    });

    it('emits INSTRUMENTS_UNIVERSE_UPDATED_EVENT with correct payload', async () => {
      const indexInstr = buildInstrument({ securityId: 'sec-idx', instrumentType: 'INDEX' });
      const optionInstr = buildInstrument({
        securityId: 'sec-opt',
        instrumentType: 'INDEX_OPTION',
      });

      mockRepo.find.mockResolvedValueOnce([indexInstr, optionInstr]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRepo.save.mockImplementationOnce((items: any) => Promise.resolve(items));

      await service.scanInstruments();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        INSTRUMENTS_UNIVERSE_UPDATED_EVENT,
        expect.objectContaining<Partial<InstrumentsUniverseUpdatedEvent>>({
          total: 2,
          tradable: 1,
          underlying: 1,
          scannedAt: expect.any(Date),
        }),
      );
    });

    it('does NOT emit event and returns early when instrument master is empty', async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      await service.scanInstruments();

      expect(mockRepo.save).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('populates tradable cache so isInstrumentTradable() works after scan', async () => {
      const secId = 'sec-cache-test';
      const option = buildInstrument({ securityId: secId, instrumentType: 'INDEX_OPTION' });
      mockRepo.find.mockResolvedValueOnce([option]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRepo.save.mockImplementationOnce((items: any) => Promise.resolve(items));

      // Before scan: unknown → false
      expect(service.isInstrumentTradable(secId)).toBe(false);

      await service.scanInstruments();

      // After scan: should now be true
      expect(service.isInstrumentTradable(secId)).toBe(true);
    });

    it('applies OI/ADV thresholds from ConfigService to STOCK_OPTION', async () => {
      // ConfigService returns non-zero thresholds
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockConfigService.get.mockImplementation((key: any, def?: any): any => {
        if (key === 'MIN_OI_THRESHOLD') return 1_000;
        if (key === 'MIN_ADV_THRESHOLD') return 500;
        return def ?? 0;
      });

      const stockOptionAboveThresholds = buildInstrument({
        securityId: 'sec-stock-high',
        instrumentType: 'STOCK_OPTION',
        openInterest: 5_000,
        avgDailyVolume: 1_000,
      });
      const stockOptionBelowThresholds = buildInstrument({
        securityId: 'sec-stock-zero',
        instrumentType: 'STOCK_OPTION',
        openInterest: 0,
        avgDailyVolume: 0,
      });

      mockRepo.find.mockResolvedValueOnce([stockOptionAboveThresholds, stockOptionBelowThresholds]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRepo.save.mockImplementationOnce((items: any) => Promise.resolve(items));

      await service.scanInstruments();

      const savedItems = (mockRepo.save as jest.Mock).mock.calls[0][0] as Instruments[];

      const aboveThresholdItem = savedItems.find((i) => i.securityId === 'sec-stock-high')!;
      const belowThresholdItem = savedItems.find((i) => i.securityId === 'sec-stock-zero')!;

      expect(aboveThresholdItem.isTradable).toBe(true);
      expect(belowThresholdItem.isTradable).toBe(false);
    });

    it('does NOT publish a notification on a successful scan', async () => {
      const option = buildInstrument({ instrumentType: 'INDEX_OPTION' });
      mockRepo.find.mockResolvedValueOnce([option]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRepo.save.mockImplementationOnce((items: any) => Promise.resolve(items));

      await service.scanInstruments();

      expect(mockNotificationService.publish).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. scanInstruments() — scan failure fallback (Requirement 4.7)
  //    When the scan throws, the prior cache is retained, a CRITICAL
  //    notification is published, and instruments.scan.failed is emitted.
  // ─────────────────────────────────────────────────────────────────────────

  describe('scanInstruments() — scan failure fallback (Requirement 4.7)', () => {
    it('retains the prior tradable cache when the scan throws an error', async () => {
      // Establish a prior cache via a successful scan.
      const priorSecId = 'sec-prior-session';
      const priorOption = buildInstrument({
        securityId: priorSecId,
        instrumentType: 'INDEX_OPTION',
      });
      mockRepo.find.mockResolvedValueOnce([priorOption]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRepo.save.mockImplementationOnce((items: any) => Promise.resolve(items));
      await service.scanInstruments();
      expect(service.isInstrumentTradable(priorSecId)).toBe(true);

      // Now simulate a scan failure (e.g. DB connection dropped).
      mockRepo.find.mockRejectedValueOnce(new Error('DB connection lost'));
      await service.scanInstruments();

      // Cache must NOT have been cleared — prior session universe retained.
      expect(service.isInstrumentTradable(priorSecId)).toBe(true);
    });

    it('does NOT modify tradable cache entries introduced by prior scan on failure', async () => {
      // Start with a scan that marks one instrument tradable and one not.
      const tradableId = 'sec-tradable';
      const untradableId = 'sec-untradable';
      const tradable = buildInstrument({
        securityId: tradableId,
        instrumentType: 'INDEX_OPTION',
      });
      const untradable = buildInstrument({
        securityId: untradableId,
        instrumentType: 'STOCK_OPTION',
        liquidityScore: '0.00',
      });
      // Use non-zero thresholds so untradable stays false.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockConfigService.get.mockImplementation((key: any, def?: any): any => {
        if (key === 'MIN_OI_THRESHOLD') return 1_000;
        if (key === 'MIN_ADV_THRESHOLD') return 500;
        return def ?? 0;
      });
      mockRepo.find.mockResolvedValueOnce([tradable, untradable]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRepo.save.mockImplementationOnce((items: any) => Promise.resolve(items));
      await service.scanInstruments();

      // Confirm baseline state.
      expect(service.isInstrumentTradable(tradableId)).toBe(true);
      expect(service.isInstrumentTradable(untradableId)).toBe(false);

      // Failing scan should leave both values unchanged.
      mockRepo.find.mockRejectedValueOnce(new Error('timeout'));
      await service.scanInstruments();

      expect(service.isInstrumentTradable(tradableId)).toBe(true);
      expect(service.isInstrumentTradable(untradableId)).toBe(false);
    });

    it('publishes a CRITICAL notification with the correct title on scan failure', async () => {
      mockRepo.find.mockRejectedValueOnce(new Error('DB connection lost'));

      await service.scanInstruments();

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'CRITICAL',
          title: 'Instrument Scan Failed — Using Prior Session Universe',
        }),
      );
    });

    it('emits INSTRUMENTS_SCAN_FAILED_EVENT on scan failure', async () => {
      mockRepo.find.mockRejectedValueOnce(new Error('DB connection lost'));

      await service.scanInstruments();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        INSTRUMENTS_SCAN_FAILED_EVENT,
        expect.objectContaining({
          failedAt: expect.any(Date),
          reason: expect.any(String),
        }),
      );
    });

    it('does NOT emit INSTRUMENTS_UNIVERSE_UPDATED_EVENT on scan failure', async () => {
      mockRepo.find.mockRejectedValueOnce(new Error('DB connection lost'));

      await service.scanInstruments();

      const updatedCalls = (mockEventEmitter.emit as jest.Mock).mock.calls.filter(
        ([event]) => event === INSTRUMENTS_UNIVERSE_UPDATED_EVENT,
      );
      expect(updatedCalls).toHaveLength(0);
    });

    it('records a SCAN_FAILURE entry in SystemHealthEvents on failure', async () => {
      mockRepo.find.mockRejectedValueOnce(new Error('DB connection lost'));

      await service.scanInstruments();

      // Allow the fire-and-forget save to settle.
      await Promise.resolve();

      expect(mockSystemHealthEventsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'SCAN_FAILURE',
          module_name: 'InstrumentDiscoveryService',
          severity: 'CRITICAL',
        }),
      );
      expect(mockSystemHealthEventsRepo.save).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. scanInstruments() — 5-minute timeout fallback (Requirement 4.7)
  //    When performScan() does not complete within 5 minutes the same
  //    failure path runs: cache unchanged, notification, event.
  // ─────────────────────────────────────────────────────────────────────────

  describe('scanInstruments() — scan timeout (Requirement 4.7)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('retains empty tradable cache when scan times out', async () => {
      // Repo find() hangs forever — simulates a stuck DB query.
      mockRepo.find.mockImplementation(() => new Promise<Instruments[]>(() => {}));

      const scanPromise = service.scanInstruments();

      // Advance fake clock past the 5-minute deadline.
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);

      await scanPromise;

      // Cache was never populated — must remain empty.
      expect(service.isInstrumentTradable('any-id')).toBe(false);
    });

    it('publishes CRITICAL notification after scan timeout', async () => {
      mockRepo.find.mockImplementation(() => new Promise<Instruments[]>(() => {}));

      const scanPromise = service.scanInstruments();
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
      await scanPromise;

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'CRITICAL',
          title: 'Instrument Scan Failed — Using Prior Session Universe',
        }),
      );
    });

    it('emits INSTRUMENTS_SCAN_FAILED_EVENT after scan timeout', async () => {
      mockRepo.find.mockImplementation(() => new Promise<Instruments[]>(() => {}));

      const scanPromise = service.scanInstruments();
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
      await scanPromise;

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        INSTRUMENTS_SCAN_FAILED_EVENT,
        expect.objectContaining({
          failedAt: expect.any(Date),
          reason: 'Scan timeout: exceeded 5 minutes',
        }),
      );
    });

    it('retains prior tradable cache (from an earlier scan) when scan times out', async () => {
      // Real timers for the first scan.
      jest.useRealTimers();
      const priorSecId = 'sec-prior';
      const priorOption = buildInstrument({
        securityId: priorSecId,
        instrumentType: 'INDEX_OPTION',
      });
      mockRepo.find.mockResolvedValueOnce([priorOption]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRepo.save.mockImplementationOnce((items: any) => Promise.resolve(items));
      await service.scanInstruments();
      expect(service.isInstrumentTradable(priorSecId)).toBe(true);

      // Switch to fake timers for the timeout scan.
      jest.useFakeTimers();
      mockRepo.find.mockImplementation(() => new Promise<Instruments[]>(() => {}));

      const scanPromise = service.scanInstruments();
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
      await scanPromise;

      // Prior session's cache entry must still be intact.
      expect(service.isInstrumentTradable(priorSecId)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. passesEligibilityCheck() — OI/ADV direct field invariants (task 8.5)
  //     Requirement 4.8: STOCK_OPTION admitted only when BOTH OI >= minOI
  //     AND ADV >= minADV simultaneously.
  // ─────────────────────────────────────────────────────────────────────────

  describe('passesEligibilityCheck() — OI/ADV direct invariants (Requirement 4.8)', () => {
    it('rejects STOCK_OPTION when openInterest < minOiThreshold (ADV above threshold)', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 500, // below minOiThreshold of 1_000
        avgDailyVolume: 2_000, // above minAdvThreshold of 500
      });
      expect(service.passesEligibilityCheck(option, 1_000, 500)).toBe(false);
    });

    it('rejects STOCK_OPTION when avgDailyVolume < minAdvThreshold (OI above threshold)', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 5_000, // above minOiThreshold of 1_000
        avgDailyVolume: 100, // below minAdvThreshold of 500
      });
      expect(service.passesEligibilityCheck(option, 1_000, 500)).toBe(false);
    });

    it('accepts STOCK_OPTION when both OI and ADV are above their thresholds', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 2_000,
        avgDailyVolume: 1_000,
      });
      expect(service.passesEligibilityCheck(option, 1_000, 500)).toBe(true);
    });

    it('accepts STOCK_OPTION when both thresholds are 0 (unconfigured), regardless of OI/ADV', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 0,
        avgDailyVolume: 0,
      });
      expect(service.passesEligibilityCheck(option, 0, 0)).toBe(true);
    });

    it('accepts INDEX_OPTION regardless of openInterest/avgDailyVolume values', () => {
      const option = buildInstrument({
        instrumentType: 'INDEX_OPTION',
        openInterest: 0,
        avgDailyVolume: 0,
      });
      // Even with high thresholds and zero OI/ADV, INDEX_OPTION always passes.
      expect(service.passesEligibilityCheck(option, 999_999, 999_999)).toBe(true);
    });

    it('rejects STOCK_OPTION when OI equals threshold exactly minus one (boundary)', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 999, // one below threshold of 1_000
        avgDailyVolume: 500, // exactly at threshold
      });
      expect(service.passesEligibilityCheck(option, 1_000, 500)).toBe(false);
    });

    it('accepts STOCK_OPTION when both OI and ADV are exactly at the threshold (boundary)', () => {
      const option = buildInstrument({
        instrumentType: 'STOCK_OPTION',
        openInterest: 1_000,
        avgDailyVolume: 500,
      });
      expect(service.passesEligibilityCheck(option, 1_000, 500)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 12. Property 3: Eligibility Threshold Uniform Enforcement
  //     **Validates: Requirements 4.8**
  //
  //     For any STOCK_OPTION: if OI < minOI OR ADV < minADV (and thresholds > 0):
  //       passesEligibilityCheck returns false.
  //     If OI >= minOI AND ADV >= minADV: returns true.
  //     For INDEX_OPTION/INDEX_FUTURE/STOCK_FUTURE: always true.
  // ─────────────────────────────────────────────────────────────────────────

  describe('Property 3: Eligibility Threshold Uniform Enforcement (Requirement 4.8)', () => {
    // **Validates: Requirements 4.8**
    it('Property 3a: STOCK_OPTION is rejected when OI below threshold (ADV above), for all inputs', () => {
      fc.assert(
        fc.property(
          // OI strictly below threshold: generate threshold in [1, 1_000_000], OI in [0, threshold-1]
          fc
            .integer({ min: 1, max: 1_000_000 })
            .chain((minOi) => fc.tuple(fc.constant(minOi), fc.integer({ min: 0, max: minOi - 1 }))),
          // ADV >= minAdv (ADV always satisfied so we isolate the OI failure)
          fc
            .integer({ min: 1, max: 1_000_000 })
            .chain((minAdv) =>
              fc.tuple(fc.constant(minAdv), fc.integer({ min: minAdv, max: minAdv + 1_000_000 })),
            ),
          ([minOi, oi], [minAdv, adv]) => {
            const option = buildInstrument({
              instrumentType: 'STOCK_OPTION',
              openInterest: oi,
              avgDailyVolume: adv,
            });
            return service.passesEligibilityCheck(option, minOi, minAdv) === false;
          },
        ),
        { numRuns: 200 },
      );
    });

    // **Validates: Requirements 4.8**
    it('Property 3b: STOCK_OPTION is rejected when ADV below threshold (OI above), for all inputs', () => {
      fc.assert(
        fc.property(
          // OI >= minOi (OI always satisfied so we isolate the ADV failure)
          fc
            .integer({ min: 1, max: 1_000_000 })
            .chain((minOi) =>
              fc.tuple(fc.constant(minOi), fc.integer({ min: minOi, max: minOi + 1_000_000 })),
            ),
          // ADV strictly below threshold
          fc
            .integer({ min: 1, max: 1_000_000 })
            .chain((minAdv) =>
              fc.tuple(fc.constant(minAdv), fc.integer({ min: 0, max: minAdv - 1 })),
            ),
          ([minOi, oi], [minAdv, adv]) => {
            const option = buildInstrument({
              instrumentType: 'STOCK_OPTION',
              openInterest: oi,
              avgDailyVolume: adv,
            });
            return service.passesEligibilityCheck(option, minOi, minAdv) === false;
          },
        ),
        { numRuns: 200 },
      );
    });

    // **Validates: Requirements 4.8**
    it('Property 3c: STOCK_OPTION is accepted when both OI and ADV meet their thresholds', () => {
      fc.assert(
        fc.property(
          // OI >= minOi
          fc
            .integer({ min: 0, max: 1_000_000 })
            .chain((minOi) =>
              fc.tuple(fc.constant(minOi), fc.integer({ min: minOi, max: minOi + 1_000_000 })),
            ),
          // ADV >= minAdv
          fc
            .integer({ min: 0, max: 1_000_000 })
            .chain((minAdv) =>
              fc.tuple(fc.constant(minAdv), fc.integer({ min: minAdv, max: minAdv + 1_000_000 })),
            ),
          ([minOi, oi], [minAdv, adv]) => {
            const option = buildInstrument({
              instrumentType: 'STOCK_OPTION',
              openInterest: oi,
              avgDailyVolume: adv,
            });
            return service.passesEligibilityCheck(option, minOi, minAdv) === true;
          },
        ),
        { numRuns: 200 },
      );
    });

    // **Validates: Requirements 4.8**
    it('Property 3d: INDEX_OPTION always passes regardless of OI, ADV, and threshold values', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 10_000_000 }), // openInterest
          fc.integer({ min: 0, max: 10_000_000 }), // avgDailyVolume
          fc.integer({ min: 0, max: 10_000_000 }), // minOiThreshold
          fc.integer({ min: 0, max: 10_000_000 }), // minAdvThreshold
          (oi, adv, minOi, minAdv) => {
            const option = buildInstrument({
              instrumentType: 'INDEX_OPTION',
              openInterest: oi,
              avgDailyVolume: adv,
            });
            return service.passesEligibilityCheck(option, minOi, minAdv) === true;
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
