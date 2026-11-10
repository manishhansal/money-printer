/**
 * live-trading.service.spec.ts
 *
 * Unit tests for LiveTradingService — session-critical enforcement and
 * two-step arming state machine.
 *
 * Test coverage:
 *  1. isNewEntryBlocked() — returns true when session enters CLOSING phase
 *  2. Mandatory square-off (15:15 IST cron) — submits MARKET exit orders,
 *     records compliance event, and schedules confirmation check
 *  3. Two-step arming — cannot reach ARMED in a single action
 *  4. Mandatory-exit compliance event — correct fields in TradeJournal call
 *
 * Requirements: 17.3, 17.4, 17.7, 11.1, 11.2
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Position } from '../../database/entities/positions.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { SessionPhase } from '../session-manager/session-manager.types';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { TradeJournalService } from '../trade-journal/trade-journal.service';
import { NotificationService } from '../notification/notification.service';
import { SecretsService } from '../secrets/secrets.service';
import { RedisService } from '../redis/redis.service';

import {
  LiveTradingService,
  ArmedState,
  SQUARE_OFF_CONFIRMATION_TIMEOUT_MS,
  KILL_SWITCH_CONFIRMATION_TIMEOUT_MS,
} from './live-trading.service';

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

const mockPositionsRepo = {
  find: jest.fn(),
};

const mockInstrumentsRepo = {
  findOne: jest.fn(),
};

const mockDhanApiClient = {
  placeOrder: jest.fn(),
  getOrderbook: jest.fn(),
  cancelOrder: jest.fn(),
};

const mockTradeJournalService = {
  recordRiskEvent: jest.fn(),
};

const mockNotificationService = {
  publish: jest.fn(),
};

const mockSecretsService = {
  get: jest.fn(),
};

const mockRedisService = {
  set: jest.fn(),
  get: jest.fn(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-uuid-1',
    engine: 'LIVE',
    instrument_id: 'instr-uuid-1',
    signal_id: null,
    direction: 'LONG',
    quantity: 50,
    average_entry_price: '250.00',
    current_sl: null,
    target_price: null,
    trailing_stop_mechanism: null,
    unrealized_pnl: '0',
    mfe: '0',
    mae: '0',
    is_open: true,
    opened_at: new Date('2024-01-15T03:45:00Z'),
    closed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    trades: [],
    ...overrides,
  } as Position;
}

function buildInstrument(overrides: Partial<Instruments> = {}): Instruments {
  return {
    id: 'instr-uuid-1',
    securityId: '1333',
    tradingSymbol: 'NIFTY24JAN21000CE',
    exchange: 'NSE',
    segment: 'NSE_FNO',
    instrumentType: 'INDEX_OPTION',
    underlying: 'NIFTY',
    expiryDate: '2024-01-25',
    strikePrice: '21000.00',
    optionType: 'CE',
    lotSize: 50,
    tickSize: '0.0500',
    freezeQuantity: null,
    isActive: true,
    liquidityScore: '85.00',
    isTradable: true,
    lastScannedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Instruments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('LiveTradingService', () => {
  let service: LiveTradingService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default happy-path stubs
    mockRedisService.set.mockResolvedValue(undefined);
    mockRedisService.get.mockResolvedValue(null); // no key in Redis by default
    mockSecretsService.get.mockResolvedValue('test-dhan-client-id');
    mockDhanApiClient.placeOrder.mockResolvedValue({
      orderId: 'dhan-order-001',
      orderStatus: 'TRANSIT',
    });
    mockDhanApiClient.getOrderbook.mockResolvedValue([]);
    mockDhanApiClient.cancelOrder.mockResolvedValue({
      orderId: 'dhan-order-001',
      orderStatus: 'CANCELLED',
    });
    mockTradeJournalService.recordRiskEvent.mockResolvedValue(undefined);
    mockNotificationService.publish.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiveTradingService,
        { provide: getRepositoryToken(Position), useValue: mockPositionsRepo },
        { provide: getRepositoryToken(Instruments), useValue: mockInstrumentsRepo },
        { provide: DhanApiClient, useValue: mockDhanApiClient },
        { provide: TradeJournalService, useValue: mockTradeJournalService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: SecretsService, useValue: mockSecretsService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<LiveTradingService>(LiveTradingService);

    // Simulate onModuleInit (called automatically by NestJS at runtime)
    await service.onModuleInit();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. isNewEntryBlocked during CLOSING phase
  // ───────────────────────────────────────────────────────────────────────────

  describe('isNewEntryBlocked()', () => {
    it('returns false when session is in AFTERNOON phase and risk state is NORMAL', () => {
      service.onSessionPhaseChanged({
        phase: SessionPhase.AFTERNOON,
        previousPhase: SessionPhase.MID_SESSION,
        timestamp: new Date(),
      });

      expect(service.isNewEntryBlocked()).toBe(false);
    });

    it('returns true when session enters CLOSING phase (14:30 IST — Requirement 17.3)', () => {
      service.onSessionPhaseChanged({
        phase: SessionPhase.CLOSING,
        previousPhase: SessionPhase.AFTERNOON,
        timestamp: new Date(),
      });

      expect(service.isNewEntryBlocked()).toBe(true);
    });

    it('returns true when session is in EOD_RECONCILIATION phase', () => {
      service.onSessionPhaseChanged({
        phase: SessionPhase.EOD_RECONCILIATION,
        previousPhase: SessionPhase.CLOSING,
        timestamp: new Date(),
      });

      expect(service.isNewEntryBlocked()).toBe(true);
    });

    it('returns true when TWO_LOSS_LOCKOUT is active', () => {
      service.onSessionPhaseChanged({
        phase: SessionPhase.MID_SESSION,
        previousPhase: SessionPhase.MORNING_MOMENTUM,
        timestamp: new Date(),
      });

      service.onRiskStateChanged({
        state: 'TWO_LOSS_LOCKOUT',
        reason: 'Second losing trade closed',
        occurredAt: new Date(),
      });

      expect(service.isNewEntryBlocked()).toBe(true);
    });

    it('returns true when EMERGENCY_HALT is active', () => {
      service.onSessionPhaseChanged({
        phase: SessionPhase.MID_SESSION,
        previousPhase: SessionPhase.MORNING_MOMENTUM,
        timestamp: new Date(),
      });

      service.onRiskStateChanged({
        state: 'EMERGENCY_HALT',
        reason: 'Daily loss limit breached',
        occurredAt: new Date(),
      });

      expect(service.isNewEntryBlocked()).toBe(true);
    });

    it('remains true after transitioning from CLOSING to EOD_RECONCILIATION', () => {
      service.onSessionPhaseChanged({
        phase: SessionPhase.CLOSING,
        previousPhase: SessionPhase.AFTERNOON,
        timestamp: new Date(),
      });
      expect(service.isNewEntryBlocked()).toBe(true);

      service.onSessionPhaseChanged({
        phase: SessionPhase.EOD_RECONCILIATION,
        previousPhase: SessionPhase.CLOSING,
        timestamp: new Date(),
      });
      expect(service.isNewEntryBlocked()).toBe(true);
    });

    it('unblocks entries when risk state returns to NORMAL', () => {
      service.onSessionPhaseChanged({
        phase: SessionPhase.MID_SESSION,
        previousPhase: SessionPhase.MORNING_MOMENTUM,
        timestamp: new Date(),
      });

      service.onRiskStateChanged({
        state: 'TWO_LOSS_LOCKOUT',
        reason: 'Second losing trade',
        occurredAt: new Date(),
      });
      expect(service.isNewEntryBlocked()).toBe(true);

      service.onRiskStateChanged({
        state: 'NORMAL',
        reason: 'Next trading day reset',
        occurredAt: new Date(),
      });
      expect(service.isNewEntryBlocked()).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Mandatory square-off — 15:15 IST cron
  // ───────────────────────────────────────────────────────────────────────────

  describe('mandatorySquareOff()', () => {
    it('does nothing when there are no open LIVE positions', async () => {
      mockPositionsRepo.find.mockResolvedValue([]);

      await service.mandatorySquareOff();

      expect(mockDhanApiClient.placeOrder).not.toHaveBeenCalled();
      expect(mockTradeJournalService.recordRiskEvent).not.toHaveBeenCalled();
    });

    it('submits a MARKET SELL order for each open LONG LIVE position', async () => {
      const position = buildPosition({ direction: 'LONG', quantity: 50 });
      const instrument = buildInstrument({
        securityId: '1333',
        segment: 'NSE_FNO',
        tradingSymbol: 'NIFTY24JAN21000CE',
      });

      mockPositionsRepo.find.mockResolvedValue([position]);
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'dhan-order-001',
        orderStatus: 'TRANSIT',
      });

      await service.mandatorySquareOff();

      expect(mockDhanApiClient.placeOrder).toHaveBeenCalledTimes(1);
      expect(mockDhanApiClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'SELL',
          orderType: 'MARKET',
          validity: 'DAY',
          securityId: '1333',
          quantity: 50,
          exchangeSegment: 'NSE_FNO',
          productType: 'INTRADAY',
        }),
      );
    });

    it('submits a MARKET BUY order for a SHORT position (to close it)', async () => {
      const position = buildPosition({ direction: 'SHORT', quantity: 25 });
      const instrument = buildInstrument({ securityId: '999', segment: 'NSE_FNO' });

      mockPositionsRepo.find.mockResolvedValue([position]);
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);

      await service.mandatorySquareOff();

      expect(mockDhanApiClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'BUY',
          orderType: 'MARKET',
        }),
      );
    });

    it('submits orders for multiple open positions', async () => {
      const positions = [
        buildPosition({ id: 'pos-1', instrument_id: 'instr-1', direction: 'LONG' }),
        buildPosition({ id: 'pos-2', instrument_id: 'instr-2', direction: 'SHORT' }),
      ];
      const instruments = [
        buildInstrument({ id: 'instr-1', securityId: '111', tradingSymbol: 'NIFTY21000CE' }),
        buildInstrument({ id: 'instr-2', securityId: '222', tradingSymbol: 'BANKNIFTY48000PE' }),
      ];

      mockPositionsRepo.find.mockResolvedValue(positions);
      mockInstrumentsRepo.findOne
        .mockResolvedValueOnce(instruments[0])
        .mockResolvedValueOnce(instruments[1]);
      mockDhanApiClient.placeOrder
        .mockResolvedValueOnce({ orderId: 'order-1', orderStatus: 'TRANSIT' })
        .mockResolvedValueOnce({ orderId: 'order-2', orderStatus: 'TRANSIT' });

      await service.mandatorySquareOff();

      expect(mockDhanApiClient.placeOrder).toHaveBeenCalledTimes(2);
    });

    it('schedules a confirmation check that queries the orderbook after 5 minutes', async () => {
      jest.useFakeTimers();

      const position = buildPosition();
      const instrument = buildInstrument();

      mockPositionsRepo.find.mockResolvedValue([position]);
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'order-abc',
        orderStatus: 'TRANSIT',
      });
      mockDhanApiClient.getOrderbook.mockResolvedValue([
        { orderId: 'order-abc', orderStatus: 'FILLED' },
      ]);

      await service.mandatorySquareOff();

      // Before timer fires — no orderbook call yet
      expect(mockDhanApiClient.getOrderbook).not.toHaveBeenCalled();

      // Advance fake timer to fire the 5-minute confirmation check
      jest.advanceTimersByTime(SQUARE_OFF_CONFIRMATION_TIMEOUT_MS);
      // Flush all pending promises from the async confirmation check
      await new Promise((resolve) =>
        jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve),
      );

      expect(mockDhanApiClient.getOrderbook).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Two-step arming — cannot reach ARMED in a single action
  // ───────────────────────────────────────────────────────────────────────────

  describe('Two-step arming state machine', () => {
    it('starts in DISARMED state after onModuleInit', () => {
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('requestArm() transitions DISARMED → ARMED_PENDING', () => {
      service.requestArm();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.ARMED_PENDING);
    });

    it('confirmArm() transitions ARMED_PENDING → ARMED', () => {
      service.requestArm();
      service.confirmArm();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.ARMED);
    });

    it('CANNOT reach ARMED in a single action — confirmArm from DISARMED must throw', () => {
      expect(() => service.confirmArm()).toThrow();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('DISARMED state: confirmArm() throws and state remains DISARMED (not ARMED)', () => {
      expect(() => service.confirmArm()).toThrow(/confirmArm\(\) requires ARMED_PENDING state/);
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('ARMED state: requestArm() throws (invalid from ARMED)', () => {
      service.requestArm();
      service.confirmArm();
      expect(() => service.requestArm()).toThrow(/requestArm\(\) requires DISARMED state/);
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.ARMED);
    });

    it('throws when requestArm() is called from ARMED_PENDING', () => {
      service.requestArm();
      expect(() => service.requestArm()).toThrow(/requestArm\(\) requires DISARMED state/);
    });

    it('disarm() resets to DISARMED from ARMED_PENDING', () => {
      service.requestArm();
      service.disarm();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('disarm() resets to DISARMED from ARMED', () => {
      service.requestArm();
      service.confirmArm();
      service.disarm();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('disarm() is idempotent — calling from DISARMED stays DISARMED', () => {
      service.disarm();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('can re-arm after a full arm → disarm cycle', () => {
      service.requestArm();
      service.confirmArm();
      service.disarm();

      service.requestArm();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.ARMED_PENDING);
      service.confirmArm();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.ARMED);
    });

    it('persists ARMED_PENDING to Redis key "trading:armed_state" on requestArm()', () => {
      service.requestArm();
      expect(mockRedisService.set).toHaveBeenCalledWith('trading:armed_state', 'ARMED_PENDING');
    });

    it('persists ARMED to Redis key "trading:armed_state" on confirmArm()', () => {
      service.requestArm();
      service.confirmArm();
      expect(mockRedisService.set).toHaveBeenCalledWith('trading:armed_state', 'ARMED');
    });

    it('persists DISARMED to Redis key "trading:armed_state" on disarm()', () => {
      service.requestArm();
      service.disarm();
      expect(mockRedisService.set).toHaveBeenCalledWith('trading:armed_state', 'DISARMED');
    });

    it('always resets to DISARMED on onModuleInit — never auto-re-arms (Requirement 11.1)', async () => {
      // Simulate the service being ARMED before restart
      service.requestArm();
      service.confirmArm();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.ARMED);

      // Simulate CloudEngine restart — Redis returns ARMED
      mockRedisService.get.mockResolvedValue('ARMED');
      await service.onModuleInit();

      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
      expect(mockRedisService.set).toHaveBeenLastCalledWith('trading:armed_state', 'DISARMED');
    });

    it('on module init with ARMED_PENDING in Redis → reverts to DISARMED', async () => {
      mockRedisService.get.mockResolvedValue('ARMED_PENDING');
      await service.onModuleInit();

      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
      expect(mockRedisService.set).toHaveBeenLastCalledWith('trading:armed_state', 'DISARMED');
    });

    it('on module init with DISARMED in Redis → starts as DISARMED', async () => {
      mockRedisService.get.mockResolvedValue('DISARMED');
      await service.onModuleInit();

      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('on module init with no Redis key (null) → starts as DISARMED', async () => {
      mockRedisService.get.mockResolvedValue(null);
      await service.onModuleInit();

      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    // activateLiveMode() is a deprecated alias for requestArm() — existing tests
    // below ensure backward-compatibility is preserved.
    it('activateLiveMode() (alias) transitions DISARMED → ARMED_PENDING', () => {
      service.activateLiveMode();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.ARMED_PENDING);
    });

    it('activateLiveMode() (alias) throws when called from ARMED', () => {
      service.activateLiveMode();
      service.confirmArm();
      expect(() => service.activateLiveMode()).toThrow(/requestArm\(\) requires DISARMED state/);
    });

    it('persists ARMED_PENDING to Redis on activateLiveMode() (backward compat)', () => {
      service.activateLiveMode();
      expect(mockRedisService.set).toHaveBeenCalledWith('trading:armed_state', 'ARMED_PENDING');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. isArmed() — returns true only when state is ARMED
  // ───────────────────────────────────────────────────────────────────────────

  describe('isArmed()', () => {
    it('returns false when state is DISARMED', () => {
      expect(service.isArmed()).toBe(false);
    });

    it('returns false when state is ARMED_PENDING', () => {
      service.requestArm();
      expect(service.isArmed()).toBe(false);
    });

    it('returns true only when state is ARMED', () => {
      service.requestArm();
      service.confirmArm();
      expect(service.isArmed()).toBe(true);
    });

    it('returns false again after disarm() from ARMED', () => {
      service.requestArm();
      service.confirmArm();
      expect(service.isArmed()).toBe(true);
      service.disarm();
      expect(service.isArmed()).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. forceDisarm() — resets to DISARMED from any state and persists to Redis
  // ───────────────────────────────────────────────────────────────────────────

  describe('forceDisarm()', () => {
    it('resets state to DISARMED from ARMED and persists to Redis', () => {
      service.requestArm();
      service.confirmArm();
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.ARMED);

      service.forceDisarm('Dhan session token renewed');

      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
      expect(mockRedisService.set).toHaveBeenCalledWith('trading:armed_state', 'DISARMED');
    });

    it('resets state to DISARMED from ARMED_PENDING', () => {
      service.requestArm();
      service.forceDisarm('Browser update detected');
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('is idempotent — forceDisarm from DISARMED keeps state DISARMED', () => {
      service.forceDisarm('Precautionary reset');
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('persists DISARMED to Redis key "trading:armed_state"', () => {
      service.requestArm();
      jest.clearAllMocks();
      mockRedisService.set.mockResolvedValue(undefined);

      service.forceDisarm('Session renewal');

      expect(mockRedisService.set).toHaveBeenCalledWith('trading:armed_state', 'DISARMED');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Mandatory-exit compliance event — correct fields
  // ───────────────────────────────────────────────────────────────────────────

  describe('mandatory-exit compliance event recording', () => {
    it('records a MANDATORY_EXIT risk event with exit timestamp and position context', async () => {
      const position = buildPosition({ id: 'pos-uuid-compliance' });
      const instrument = buildInstrument({ tradingSymbol: 'NIFTY24JAN21000CE' });

      mockPositionsRepo.find.mockResolvedValue([position]);
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'order-compliance-001',
        orderStatus: 'TRANSIT',
      });

      await service.mandatorySquareOff();

      expect(mockTradeJournalService.recordRiskEvent).toHaveBeenCalledTimes(1);

      const callArg = mockTradeJournalService.recordRiskEvent.mock.calls[0][0] as {
        eventType: string;
        engine: string;
        initiatingActor: string;
        reason: string;
        occurredAt: unknown;
        triggeringMetricName: string;
        triggeringMetricValue: string;
      };

      // Verify event type is MANDATORY_EXIT (Requirement 17.4)
      expect(callArg.eventType).toBe('MANDATORY_EXIT');

      // Verify engine context
      expect(callArg.engine).toBe('LIVE');

      // Verify initiating actor for audit traceability
      expect(callArg.initiatingActor).toBe('LiveTradingService.mandatorySquareOff');

      // Verify the reason references the exit orders
      expect(callArg.reason).toContain('MARKET exit order');

      // Verify exit timestamp is a valid Date object
      expect(callArg.occurredAt).toBeInstanceOf(Date);

      // Verify triggering metric identifies the 15:15 IST session time
      expect(callArg.triggeringMetricName).toBe('session_time');
      expect(callArg.triggeringMetricValue).toBe('15:15');
    });

    it('does NOT record a compliance event when there are no open positions', async () => {
      mockPositionsRepo.find.mockResolvedValue([]);

      await service.mandatorySquareOff();

      expect(mockTradeJournalService.recordRiskEvent).not.toHaveBeenCalled();
    });

    it('publishes a CRITICAL alert when an exit order is REJECTED (Requirement 17.7)', async () => {
      jest.useFakeTimers();

      const position = buildPosition({ id: 'pos-rejected' });
      const instrument = buildInstrument({ tradingSymbol: 'BANKNIFTY48000PE' });

      mockPositionsRepo.find.mockResolvedValue([position]);
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'order-rejected-001',
        orderStatus: 'TRANSIT',
      });

      // Orderbook returns REJECTED status after 5 minutes
      mockDhanApiClient.getOrderbook.mockResolvedValue([
        { orderId: 'order-rejected-001', orderStatus: 'REJECTED' },
      ]);

      await service.mandatorySquareOff();

      // Advance to trigger the 5-minute confirmation check
      jest.advanceTimersByTime(SQUARE_OFF_CONFIRMATION_TIMEOUT_MS);
      await new Promise((resolve) =>
        jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve),
      );

      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'CRITICAL',
          metadata: expect.objectContaining({
            positionId: 'pos-rejected',
            orderId: 'order-rejected-001',
            orderStatus: 'REJECTED',
          }),
        }),
      );

      jest.useRealTimers();
    });

    it('does NOT publish a CRITICAL alert when the exit order is FILLED', async () => {
      jest.useFakeTimers();

      const position = buildPosition({ id: 'pos-filled' });
      const instrument = buildInstrument({ tradingSymbol: 'NIFTY24JAN21000CE' });

      mockPositionsRepo.find.mockResolvedValue([position]);
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'order-filled-001',
        orderStatus: 'TRANSIT',
      });
      mockDhanApiClient.getOrderbook.mockResolvedValue([
        { orderId: 'order-filled-001', orderStatus: 'FILLED' },
      ]);

      await service.mandatorySquareOff();

      jest.advanceTimersByTime(SQUARE_OFF_CONFIRMATION_TIMEOUT_MS);
      await new Promise((resolve) =>
        jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve),
      );

      // Verify no CRITICAL alert was published for this filled position
      const criticalWithPositionId = mockNotificationService.publish.mock.calls.filter(
        (args: unknown[]) => {
          const alert = args[0] as { priority: string; metadata?: { positionId?: string } };
          return alert.priority === 'CRITICAL' && alert.metadata?.positionId === 'pos-filled';
        },
      );
      expect(criticalWithPositionId).toHaveLength(0);

      jest.useRealTimers();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Kill switch — activateKillSwitch() (Requirements 9.8, 11.5, 11.6)
  // ───────────────────────────────────────────────────────────────────────────

  describe('activateKillSwitch()', () => {
    it('records a KILL_SWITCH event in TradeJournal on activation', async () => {
      mockPositionsRepo.find.mockResolvedValue([]);
      mockDhanApiClient.getOrderbook.mockResolvedValue([]);

      await service.activateKillSwitch();

      expect(mockTradeJournalService.recordRiskEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'KILL_SWITCH',
          engine: 'LIVE',
          initiatingActor: 'LiveTradingService.activateKillSwitch',
          triggeringMetricName: 'kill_switch',
          triggeringMetricValue: 'ACTIVATED',
        }),
      );
    });

    it('sets isKillSwitchActive() to true after activation', async () => {
      mockPositionsRepo.find.mockResolvedValue([]);
      mockDhanApiClient.getOrderbook.mockResolvedValue([]);

      expect(service.isKillSwitchActive()).toBe(false);
      await service.activateKillSwitch();
      expect(service.isKillSwitchActive()).toBe(true);
    });

    it('force-disarms the engine when kill switch is activated', async () => {
      service.requestArm();
      service.confirmArm();
      expect(service.isArmed()).toBe(true);

      mockPositionsRepo.find.mockResolvedValue([]);
      mockDhanApiClient.getOrderbook.mockResolvedValue([]);

      await service.activateKillSwitch();

      expect(service.isArmed()).toBe(false);
      expect(service.getArmedState()).toBe<ArmedState>(ArmedState.DISARMED);
    });

    it('cancels all TRANSIT and PENDING orders in the orderbook', async () => {
      mockDhanApiClient.getOrderbook.mockResolvedValue([
        { orderId: 'ord-transit', orderStatus: 'TRANSIT' },
        { orderId: 'ord-pending', orderStatus: 'PENDING' },
        { orderId: 'ord-filled', orderStatus: 'FILLED' },
      ]);
      mockPositionsRepo.find.mockResolvedValue([]);

      await service.activateKillSwitch();

      // Should cancel TRANSIT and PENDING — not FILLED
      expect(mockDhanApiClient.cancelOrder).toHaveBeenCalledTimes(2);
      expect(mockDhanApiClient.cancelOrder).toHaveBeenCalledWith('ord-transit');
      expect(mockDhanApiClient.cancelOrder).toHaveBeenCalledWith('ord-pending');
      expect(mockDhanApiClient.cancelOrder).not.toHaveBeenCalledWith('ord-filled');
    });

    it('cancels PARTIALLY_FILLED orders as well', async () => {
      mockDhanApiClient.getOrderbook.mockResolvedValue([
        { orderId: 'ord-partial', orderStatus: 'PARTIALLY_FILLED' },
      ]);
      mockPositionsRepo.find.mockResolvedValue([]);

      await service.activateKillSwitch();

      expect(mockDhanApiClient.cancelOrder).toHaveBeenCalledWith('ord-partial');
    });

    it('submits a MARKET SELL exit order for each open LONG LIVE position', async () => {
      const position = buildPosition({ id: 'pos-ks-1', direction: 'LONG', quantity: 50 });
      const instrument = buildInstrument({
        securityId: '1333',
        segment: 'NSE_FNO',
        tradingSymbol: 'NIFTY24JAN21000CE',
      });

      mockDhanApiClient.getOrderbook.mockResolvedValue([]);
      mockPositionsRepo.find.mockResolvedValue([position]);
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'ks-order-001',
        orderStatus: 'TRANSIT',
      });

      await service.activateKillSwitch();

      expect(mockDhanApiClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'SELL',
          orderType: 'MARKET',
          validity: 'DAY',
          securityId: '1333',
          quantity: 50,
          exchangeSegment: 'NSE_FNO',
          productType: 'INTRADAY',
        }),
      );
    });

    it('submits a MARKET BUY exit order for a SHORT position', async () => {
      const position = buildPosition({ id: 'pos-ks-2', direction: 'SHORT', quantity: 25 });
      const instrument = buildInstrument({ securityId: '999', segment: 'NSE_FNO' });

      mockDhanApiClient.getOrderbook.mockResolvedValue([]);
      mockPositionsRepo.find.mockResolvedValue([position]);
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'ks-order-002',
        orderStatus: 'TRANSIT',
      });

      await service.activateKillSwitch();

      expect(mockDhanApiClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'BUY',
          orderType: 'MARKET',
        }),
      );
    });

    it('is idempotent — second activation does nothing', async () => {
      mockDhanApiClient.getOrderbook.mockResolvedValue([]);
      mockPositionsRepo.find.mockResolvedValue([]);

      await service.activateKillSwitch();
      jest.clearAllMocks();
      mockTradeJournalService.recordRiskEvent.mockResolvedValue(undefined);

      await service.activateKillSwitch();

      // Should not record a second KILL_SWITCH event
      expect(mockTradeJournalService.recordRiskEvent).not.toHaveBeenCalled();
    });

    it('publishes a MAX alert for unconfirmed exit orders after 10 seconds (Requirement 11.5, 11.6)', async () => {
      jest.useFakeTimers();

      const position = buildPosition({ id: 'pos-ks-unconfirmed' });
      const instrument = buildInstrument({ tradingSymbol: 'NIFTY24JAN21000CE' });

      // First getOrderbook call: cancel step (no open orders to cancel)
      // Second getOrderbook call: confirmation step — order still TRANSIT
      mockDhanApiClient.getOrderbook
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ orderId: 'ks-order-unconfirmed', orderStatus: 'TRANSIT' }]);
      mockPositionsRepo.find
        .mockResolvedValueOnce([position]) // initial position query
        .mockResolvedValueOnce([]); // 10-second DB check — position closed
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'ks-order-unconfirmed',
        orderStatus: 'TRANSIT',
      });

      await service.activateKillSwitch();

      // No MAX alert before 10 seconds
      const maxAlertsBefore = mockNotificationService.publish.mock.calls.filter(
        (args: unknown[]) => (args[0] as { priority: string }).priority === 'MAX',
      );
      expect(maxAlertsBefore).toHaveLength(0);

      // Advance 10 seconds to fire the confirmation check
      jest.advanceTimersByTime(KILL_SWITCH_CONFIRMATION_TIMEOUT_MS);
      await new Promise((resolve) =>
        jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve),
      );

      const maxAlerts = mockNotificationService.publish.mock.calls.filter(
        (args: unknown[]) => (args[0] as { priority: string }).priority === 'MAX',
      );
      expect(maxAlerts.length).toBeGreaterThanOrEqual(1);
      expect(maxAlerts[0][0]).toEqual(
        expect.objectContaining({
          priority: 'MAX',
          metadata: expect.objectContaining({
            orderId: 'ks-order-unconfirmed',
            positionId: 'pos-ks-unconfirmed',
          }),
        }),
      );

      jest.useRealTimers();
    });

    it('publishes a MAX alert for positions still open in DB after 10 seconds (Requirement 11.6)', async () => {
      jest.useFakeTimers();

      const position = buildPosition({ id: 'pos-ks-still-open' });
      const instrument = buildInstrument({ tradingSymbol: 'BANKNIFTY48000PE' });

      mockDhanApiClient.getOrderbook
        .mockResolvedValueOnce([]) // cancel step
        .mockResolvedValueOnce([]); // confirmation step — empty orderbook
      mockPositionsRepo.find
        .mockResolvedValueOnce([position]) // initial position query for exit orders
        .mockResolvedValueOnce([position]); // 10-second DB check — still open
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'ks-order-still-open',
        orderStatus: 'TRANSIT',
      });

      await service.activateKillSwitch();

      jest.advanceTimersByTime(KILL_SWITCH_CONFIRMATION_TIMEOUT_MS);
      await new Promise((resolve) =>
        jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve),
      );

      const maxAlerts = mockNotificationService.publish.mock.calls.filter(
        (args: unknown[]) => (args[0] as { priority: string }).priority === 'MAX',
      );
      expect(maxAlerts.length).toBeGreaterThanOrEqual(1);

      const positionAlert = maxAlerts.find((args: unknown[]) => {
        const alert = args[0] as { priority: string; metadata?: { positionId?: string } };
        return alert.metadata?.positionId === 'pos-ks-still-open';
      });
      expect(positionAlert).toBeDefined();

      jest.useRealTimers();
    });

    it('does NOT publish MAX alerts if all exit orders are FILLED and no positions remain open', async () => {
      jest.useFakeTimers();

      const position = buildPosition({ id: 'pos-ks-all-filled' });
      const instrument = buildInstrument({ tradingSymbol: 'NIFTY24JAN21000CE' });

      mockDhanApiClient.getOrderbook
        .mockResolvedValueOnce([]) // cancel step
        .mockResolvedValueOnce([{ orderId: 'ks-order-all-filled', orderStatus: 'FILLED' }]);
      mockPositionsRepo.find
        .mockResolvedValueOnce([position]) // initial query
        .mockResolvedValueOnce([]); // 10-second check — all closed
      mockInstrumentsRepo.findOne.mockResolvedValue(instrument);
      mockDhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'ks-order-all-filled',
        orderStatus: 'TRANSIT',
      });

      await service.activateKillSwitch();

      jest.advanceTimersByTime(KILL_SWITCH_CONFIRMATION_TIMEOUT_MS);
      await new Promise((resolve) =>
        jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve),
      );

      const maxAlerts = mockNotificationService.publish.mock.calls.filter(
        (args: unknown[]) => (args[0] as { priority: string }).priority === 'MAX',
      );
      expect(maxAlerts).toHaveLength(0);

      jest.useRealTimers();
    });

    it('does nothing (no cancel, no exit orders) when orderbook is empty and no positions exist', async () => {
      mockDhanApiClient.getOrderbook.mockResolvedValue([]);
      mockPositionsRepo.find.mockResolvedValue([]);

      await service.activateKillSwitch();

      expect(mockDhanApiClient.cancelOrder).not.toHaveBeenCalled();
      expect(mockDhanApiClient.placeOrder).not.toHaveBeenCalled();
    });
  });
});
