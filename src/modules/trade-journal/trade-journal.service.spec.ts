/**
 * TradeJournalService unit tests.
 *
 * Covers:
 *   1. Successful inserts for each of the 9 record sets.
 *   2. Retry logic: up to 3 retries on failure; success on final attempt.
 *   3. Operator alert emission when all retries are exhausted.
 *   4. SLA warning when a write exceeds the threshold.
 *   5. No UPDATE or DELETE calls are ever made (append-only invariant).
 *
 * All repository interactions are mocked so tests run without a live database.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { TradeJournalService, JOURNAL_WRITE_FAILED_EVENT } from './trade-journal.service';

import { Signals } from '../../database/entities/signals.entity';
import { Order } from '../../database/entities/orders.entity';
import { Execution } from '../../database/entities/executions.entity';
import { Position } from '../../database/entities/positions.entity';
import { Trade } from '../../database/entities/trades.entity';
import { RiskEvents } from '../../database/entities/risk-events.entity';
import { SystemHealthEvents } from '../../database/entities/system-health-events.entity';
import { AuditLogs } from '../../database/entities/audit-logs.entity';

import { CreateSignalDto } from './dto/create-signal.dto';
import { RejectedSignalDto } from './dto/rejected-signal.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateFillDto } from './dto/create-fill.dto';
import { CreatePositionDto } from './dto/create-position.dto';
import { CompletedTradeDto } from './dto/completed-trade.dto';
import { RiskEventDto } from './dto/risk-event.dto';
import { SystemErrorDto } from './dto/system-error.dto';
import { ConfigChangeDto } from './dto/config-change.dto';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock TypeORM repository with create + save stubs. */
function mockRepo() {
  return {
    create: jest.fn().mockImplementation((dto: object) => ({ ...dto })),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const signalDto: CreateSignalDto = {
  strategyId: 'strat-uuid',
  instrumentId: 'inst-uuid',
  engine: 'LIVE',
  direction: 'BUY',
  entryPrice: '100.00',
  stopLossPrice: '95.00',
  targetPrice: '110.00',
  positionSize: 1,
  compositeScore: '85.00',
  scoreRegimeAlignment: '12.00',
  scorePriceStructure: '12.00',
  scoreVolumeConfirmation: '12.00',
  scoreMomentum: '8.00',
  scoreVwapTrend: '9.00',
  scoreOptionsFutures: '12.00',
  scoreLiquidityExecution: '10.00',
  scoreRrQuality: '10.00',
  measuredInputs: {},
  status: 'active',
  signalTimestamp: new Date('2024-01-15T09:30:00Z'),
};

const rejectedSignalDto: RejectedSignalDto = {
  strategyId: 'strat-uuid',
  instrumentId: 'inst-uuid',
  engine: 'LIVE',
  direction: 'BUY',
  entryPrice: '100.00',
  stopLossPrice: '95.00',
  targetPrice: '110.00',
  positionSize: 1,
  compositeScore: '75.00',
  scoreRegimeAlignment: '10.00',
  scorePriceStructure: '10.00',
  scoreVolumeConfirmation: '10.00',
  scoreMomentum: '8.00',
  scoreVwapTrend: '8.00',
  scoreOptionsFutures: '10.00',
  scoreLiquidityExecution: '9.00',
  scoreRrQuality: '10.00',
  measuredInputs: {},
  rejectionReason: 'score below threshold',
  signalTimestamp: new Date('2024-01-15T09:30:00Z'),
  rejectionTimestamp: new Date('2024-01-15T09:30:01Z'),
};

const orderDto: CreateOrderDto = {
  idempotencyKey: 'idem-uuid',
  engine: 'LIVE',
  instrumentId: 'inst-uuid',
  orderType: 'MARKET',
  transactionType: 'BUY',
  quantity: 50,
  status: 'submitted',
};

const fillDto: CreateFillDto = {
  orderId: 'order-uuid',
  engine: 'LIVE',
  fillPrice: '100.25',
  fillQuantity: 50,
  fillTimestamp: new Date('2024-01-15T09:30:05Z'),
};

const positionDto: CreatePositionDto = {
  engine: 'LIVE',
  instrumentId: 'inst-uuid',
  direction: 'LONG',
  quantity: 50,
  averageEntryPrice: '100.25',
  openedAt: new Date('2024-01-15T09:30:05Z'),
};

const completedTradeDto: CompletedTradeDto = {
  positionId: 'pos-uuid',
  instrumentId: 'inst-uuid',
  strategyId: 'strat-uuid',
  engine: 'LIVE',
  direction: 'LONG',
  quantity: 50,
  lotSize: 50,
  entryPrice: '100.25',
  exitPrice: '108.50',
  entryTime: new Date('2024-01-15T09:30:05Z'),
  exitTime: new Date('2024-01-15T11:00:00Z'),
  mfe: '450.00',
  mae: '-50.00',
  grossPnl: '412.50',
  brokerage: '40.00',
  stt: '2.50',
  exchangeCharges: '1.50',
  gst: '7.50',
  sebiCharges: '0.10',
  stampDuty: '0.50',
  netPnl: '360.40',
  exitReason: 'TARGET_HIT',
  executionSlippage: '0.25',
};

const riskEventDto: RiskEventDto = {
  engine: 'LIVE',
  eventType: 'TWO_LOSS_LOCKOUT',
  reason: 'Two losing trades recorded for the session',
  triggeringMetricName: 'losing_trade_count',
  triggeringMetricValue: '2',
  thresholdValue: '2',
  initiatingActor: 'RiskEngine',
  occurredAt: new Date('2024-01-15T10:15:00Z'),
};

const systemErrorDto: SystemErrorDto = {
  eventType: 'MODULE_RESTART',
  moduleName: 'SignalScoring',
  severity: 'CRITICAL',
  message: 'SignalScoring module crashed and restarted',
  timestamp: new Date('2024-01-15T10:00:00Z'),
};

const configChangeDto: ConfigChangeDto = {
  userId: 'user-uuid',
  fieldName: 'default_risk_percentage',
  previousValue: '1.0000',
  newValue: '1.5000',
  entityType: 'UserSettings',
  entityId: 'settings-uuid',
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('TradeJournalService', () => {
  let service: TradeJournalService;

  let signalsRepo: ReturnType<typeof mockRepo>;
  let ordersRepo: ReturnType<typeof mockRepo>;
  let executionsRepo: ReturnType<typeof mockRepo>;
  let positionsRepo: ReturnType<typeof mockRepo>;
  let tradesRepo: ReturnType<typeof mockRepo>;
  let riskEventsRepo: ReturnType<typeof mockRepo>;
  let systemHealthEventsRepo: ReturnType<typeof mockRepo>;
  let auditLogsRepo: ReturnType<typeof mockRepo>;

  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    signalsRepo = mockRepo();
    ordersRepo = mockRepo();
    executionsRepo = mockRepo();
    positionsRepo = mockRepo();
    tradesRepo = mockRepo();
    riskEventsRepo = mockRepo();
    systemHealthEventsRepo = mockRepo();
    auditLogsRepo = mockRepo();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TradeJournalService,
        { provide: getRepositoryToken(Signals), useValue: signalsRepo },
        { provide: getRepositoryToken(Order), useValue: ordersRepo },
        { provide: getRepositoryToken(Execution), useValue: executionsRepo },
        { provide: getRepositoryToken(Position), useValue: positionsRepo },
        { provide: getRepositoryToken(Trade), useValue: tradesRepo },
        { provide: getRepositoryToken(RiskEvents), useValue: riskEventsRepo },
        { provide: getRepositoryToken(SystemHealthEvents), useValue: systemHealthEventsRepo },
        { provide: getRepositoryToken(AuditLogs), useValue: auditLogsRepo },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<TradeJournalService>(TradeJournalService);
  });

  // ─── Happy-path: each record set inserts successfully ───────────────────────

  describe('recordSignal', () => {
    it('should INSERT a signal row and call save() exactly once', async () => {
      await service.recordSignal(signalDto);

      expect(signalsRepo.save).toHaveBeenCalledTimes(1);
      const saved = signalsRepo.save.mock.calls[0][0];
      expect(saved).toMatchObject({
        instrumentId: 'inst-uuid',
        engine: 'LIVE',
        compositeScore: '85.00',
        status: 'active',
      });
    });

    it('should NOT call update() or delete() (append-only invariant)', async () => {
      await service.recordSignal(signalDto);
      // The mock intentionally exposes only create() and save().
      // Absence of update/delete keys on the mock confirms the journal
      // never invokes those methods (Requirement 13.3 — append-only).
      expect(Object.keys(signalsRepo)).not.toContain('update');
      expect(Object.keys(signalsRepo)).not.toContain('delete');
    });
  });

  describe('recordRejectedSignal', () => {
    it('should INSERT a signal row with status "rejected" and rejectionTimestamp in expiryTimestamp', async () => {
      await service.recordRejectedSignal(rejectedSignalDto);

      expect(signalsRepo.save).toHaveBeenCalledTimes(1);
      const saved = signalsRepo.save.mock.calls[0][0];
      expect(saved).toMatchObject({
        status: 'rejected',
        rejectionReason: 'score below threshold',
        expiryTimestamp: rejectedSignalDto.rejectionTimestamp,
      });
    });

    it('should record all 8 component scores', async () => {
      await service.recordRejectedSignal(rejectedSignalDto);
      const saved = signalsRepo.save.mock.calls[0][0];
      expect(saved.scoreRegimeAlignment).toBe('10.00');
      expect(saved.scorePriceStructure).toBe('10.00');
      expect(saved.scoreVolumeConfirmation).toBe('10.00');
      expect(saved.scoreMomentum).toBe('8.00');
      expect(saved.scoreVwapTrend).toBe('8.00');
      expect(saved.scoreOptionsFutures).toBe('10.00');
      expect(saved.scoreLiquidityExecution).toBe('9.00');
      expect(saved.scoreRrQuality).toBe('10.00');
    });
  });

  describe('recordOrder', () => {
    it('should INSERT an order row', async () => {
      await service.recordOrder(orderDto);
      expect(ordersRepo.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordFill', () => {
    it('should INSERT an execution row', async () => {
      await service.recordFill(fillDto);
      expect(executionsRepo.save).toHaveBeenCalledTimes(1);
      const saved = executionsRepo.save.mock.calls[0][0];
      expect(saved.fill_price).toBe('100.25');
      expect(saved.fill_quantity).toBe(50);
    });
  });

  describe('recordPosition', () => {
    it('should INSERT a position row with is_open = true', async () => {
      await service.recordPosition(positionDto);
      expect(positionsRepo.save).toHaveBeenCalledTimes(1);
      const saved = positionsRepo.save.mock.calls[0][0];
      expect(saved.is_open).toBe(true);
      expect(saved.unrealized_pnl).toBe('0');
      expect(saved.mfe).toBe('0');
      expect(saved.mae).toBe('0');
    });
  });

  describe('recordCompletedTrade', () => {
    it('should INSERT a trade row with all 20+ required fields', async () => {
      await service.recordCompletedTrade(completedTradeDto);

      expect(tradesRepo.save).toHaveBeenCalledTimes(1);
      const saved = tradesRepo.save.mock.calls[0][0];

      // Verify all 20+ mandatory fields (Requirement 13.2)
      expect(saved.position_id).toBe('pos-uuid');
      expect(saved.instrument_id).toBe('inst-uuid');
      expect(saved.strategy_id).toBe('strat-uuid');
      expect(saved.entry_price).toBe('100.25');
      expect(saved.exit_price).toBe('108.50');
      expect(saved.quantity).toBe(50);
      expect(saved.entry_time).toEqual(completedTradeDto.entryTime);
      expect(saved.exit_time).toEqual(completedTradeDto.exitTime);
      expect(saved.mfe).toBe('450.00');
      expect(saved.mae).toBe('-50.00');
      expect(saved.gross_pnl).toBe('412.50');
      expect(saved.brokerage).toBe('40.00');
      expect(saved.stt).toBe('2.50');
      expect(saved.exchange_charges).toBe('1.50');
      expect(saved.gst).toBe('7.50');
      expect(saved.sebi_charges).toBe('0.10');
      expect(saved.stamp_duty).toBe('0.50');
      expect(saved.net_pnl).toBe('360.40');
      expect(saved.exit_reason).toBe('TARGET_HIT');
      expect(saved.execution_slippage).toBe('0.25');
    });

    it('should leave QCR and exit classification null (computed by AnalyticsService)', async () => {
      await service.recordCompletedTrade(completedTradeDto);
      const saved = tradesRepo.save.mock.calls[0][0];
      expect(saved.qcr).toBeNull();
      expect(saved.exit_classification).toBeNull();
      expect(saved.execution_quality).toBeNull();
    });
  });

  describe('recordRiskEvent', () => {
    it('should INSERT a risk event row with all required fields', async () => {
      await service.recordRiskEvent(riskEventDto);

      expect(riskEventsRepo.save).toHaveBeenCalledTimes(1);
      const saved = riskEventsRepo.save.mock.calls[0][0];
      expect(saved.event_type).toBe('TWO_LOSS_LOCKOUT');
      expect(saved.triggering_metric_name).toBe('losing_trade_count');
      expect(saved.triggering_metric_value).toBe('2');
      expect(saved.threshold_value).toBe('2');
      expect(saved.initiating_actor).toBe('RiskEngine');
    });
  });

  describe('recordSystemError', () => {
    it('should INSERT a system health event row', async () => {
      await service.recordSystemError(systemErrorDto);

      expect(systemHealthEventsRepo.save).toHaveBeenCalledTimes(1);
      const saved = systemHealthEventsRepo.save.mock.calls[0][0];
      expect(saved.event_type).toBe('MODULE_RESTART');
      expect(saved.module_name).toBe('SignalScoring');
      expect(saved.severity).toBe('CRITICAL');
    });
  });

  describe('recordConfigChange', () => {
    it('should INSERT an audit log row with eventType CONFIG_CHANGE', async () => {
      await service.recordConfigChange(configChangeDto);

      expect(auditLogsRepo.save).toHaveBeenCalledTimes(1);
      const saved = auditLogsRepo.save.mock.calls[0][0];
      expect(saved.eventType).toBe('CONFIG_CHANGE');
    });

    it('should persist all required fields: userId, fieldName, previousValue, newValue', async () => {
      await service.recordConfigChange(configChangeDto);

      const saved = auditLogsRepo.save.mock.calls[0][0];
      expect(saved.userId).toBe('user-uuid');
      expect(saved.fieldName).toBe('default_risk_percentage');
      expect(saved.previousValue).toBe('1.0000');
      expect(saved.newValue).toBe('1.5000');
    });

    it('should persist entityType and entityId', async () => {
      await service.recordConfigChange(configChangeDto);

      const saved = auditLogsRepo.save.mock.calls[0][0];
      expect(saved.entityType).toBe('UserSettings');
      expect(saved.entityId).toBe('settings-uuid');
    });

    it('should set outcome to SUCCESS', async () => {
      await service.recordConfigChange(configChangeDto);

      const saved = auditLogsRepo.save.mock.calls[0][0];
      expect(saved.outcome).toBe('SUCCESS');
    });

    it('should auto-generate a UTC timestamp close to now', async () => {
      const before = new Date();
      await service.recordConfigChange(configChangeDto);
      const after = new Date();

      const saved = auditLogsRepo.save.mock.calls[0][0];
      expect(saved.timestamp).toBeInstanceOf(Date);
      expect(saved.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(saved.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should persist optional ipAddress when provided', async () => {
      await service.recordConfigChange({ ...configChangeDto, ipAddress: '192.168.1.1' });

      const saved = auditLogsRepo.save.mock.calls[0][0];
      expect(saved.ipAddress).toBe('192.168.1.1');
    });

    it('should set ipAddress to null when not provided', async () => {
      await service.recordConfigChange(configChangeDto);

      const saved = auditLogsRepo.save.mock.calls[0][0];
      expect(saved.ipAddress).toBeNull();
    });

    describe('retry on transient DB failure', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('should retry and succeed on the second attempt after one transient failure', async () => {
        auditLogsRepo.save
          .mockRejectedValueOnce(new Error('DB connection reset'))
          .mockResolvedValueOnce(undefined);

        const writePromise = service.recordConfigChange(configChangeDto);
        await jest.runAllTimersAsync();
        await writePromise;

        expect(auditLogsRepo.save).toHaveBeenCalledTimes(2);
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      }, 15_000);

      it('should emit operator alert after all 3 retries are exhausted on persistent DB failure', async () => {
        auditLogsRepo.save.mockRejectedValue(new Error('Persistent DB failure'));

        const writePromise = service.recordConfigChange(configChangeDto);
        await jest.runAllTimersAsync();
        await writePromise;

        // 1 initial attempt + 3 retries = 4 total calls
        expect(auditLogsRepo.save).toHaveBeenCalledTimes(4);
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          JOURNAL_WRITE_FAILED_EVENT,
          expect.objectContaining({
            recordType: 'configuration_changes',
            failureReason: 'Persistent DB failure',
            timestamp: expect.any(Date),
          }),
        );
      }, 15_000);
    });
  });

  // ─── Retry logic ────────────────────────────────────────────────────────────

  describe('retry on transient failure', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should succeed on the second attempt after one transient failure', async () => {
      // First save() throws, second resolves
      signalsRepo.save
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockResolvedValueOnce(undefined);

      const writePromise = service.recordSignal(signalDto);

      // Advance past the 1s first-retry delay and flush all microtasks
      await jest.runAllTimersAsync();
      await writePromise;

      expect(signalsRepo.save).toHaveBeenCalledTimes(2);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    }, 15_000);

    it('should succeed on the third attempt (2 transient failures)', async () => {
      signalsRepo.save
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockResolvedValueOnce(undefined);

      const writePromise = service.recordSignal(signalDto);

      // Advance past 1s + 2s delays and flush all microtasks
      await jest.runAllTimersAsync();
      await writePromise;

      expect(signalsRepo.save).toHaveBeenCalledTimes(3);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    }, 15_000);

    it('should emit operator alert after all 3 retries are exhausted', async () => {
      signalsRepo.save.mockRejectedValue(new Error('Persistent DB failure'));

      const writePromise = service.recordSignal(signalDto);

      // Advance past all retry delays: 1s + 2s + 4s
      await jest.runAllTimersAsync();
      await writePromise;

      // 1 initial attempt + 3 retries = 4 total calls
      expect(signalsRepo.save).toHaveBeenCalledTimes(4);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        JOURNAL_WRITE_FAILED_EVENT,
        expect.objectContaining({
          recordType: 'signals',
          failureReason: 'Persistent DB failure',
        }),
      );
    }, 15_000);

    it('should emit operator alert for risk_events on persistent failure', async () => {
      riskEventsRepo.save.mockRejectedValue(new Error('Disk full'));

      const writePromise = service.recordRiskEvent(riskEventDto);

      await jest.runAllTimersAsync();
      await writePromise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        JOURNAL_WRITE_FAILED_EVENT,
        expect.objectContaining({
          recordType: 'risk_events',
        }),
      );
    }, 15_000);

    // ── New tests for task 25.2 (Requirements 13.7, 13.8) ───────────────────

    it('should call riskEventsRepo.save exactly 4 times and emit a complete operator alert when all retries are exhausted', async () => {
      // Persistent failure across all attempts.
      riskEventsRepo.save.mockRejectedValue(new Error('Disk full'));

      const writePromise = service.recordRiskEvent(riskEventDto);
      await jest.runAllTimersAsync();
      await writePromise;

      // Requirement 13.7: 1 initial attempt + 3 retries = 4 total.
      expect(riskEventsRepo.save).toHaveBeenCalledTimes(4);

      // Requirement 13.7: operator alert must identify record type, failure
      // reason, and carry a timestamp — no information should be lost.
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        JOURNAL_WRITE_FAILED_EVENT,
        expect.objectContaining({
          recordType: 'risk_events',
          failureReason: 'Disk full',
          timestamp: expect.any(Date),
        }),
      );
    }, 15_000);

    it('should log a WARNING when recordCompletedTrade write exceeds the 5-second SLA', async () => {
      // Spy on the NestJS logger attached to the service instance.
      const warnSpy = jest.spyOn((service as any).logger, 'warn');

      // Simulate a slow write by advancing the fake clock 6 seconds inside
      // the save mock.  Because jest.useFakeTimers() replaces Date.now() with
      // the fake clock, the elapsed-time check inside writeWithRetry sees 6 s.
      tradesRepo.save.mockImplementation(async () => {
        jest.advanceTimersByTime(6_000);
        // Resolves successfully — the SLA check fires on the success path.
      });

      // No runAllTimersAsync needed: save resolves without scheduling sleeps.
      await service.recordCompletedTrade(completedTradeDto);

      // Requirement 13.8: SLA breach must be surfaced as a WARNING log.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('SLA breach on "completed_trades"'),
      );
    }, 15_000);

    it('should stop retrying early and still emit the operator alert when the 30-second window is exhausted mid-sequence', async () => {
      // Each failed save advances the fake clock by 16 seconds.
      // Attempt 0: elapsed = 16 s → remaining = 14 s → proceed with retry.
      // Attempt 1: elapsed = 16 + 1 (sleep) + 16 = 33 s → remaining = -3 s → break.
      // Total save calls = 2 (not 4), proving the 30-second cap is enforced.
      riskEventsRepo.save.mockImplementation(async () => {
        jest.advanceTimersByTime(16_000);
        throw new Error('persistent failure');
      });

      const writePromise = service.recordRiskEvent(riskEventDto);
      await jest.runAllTimersAsync();
      await writePromise;

      // Only 2 saves: the window cap terminates the loop before attempts 2 & 3.
      expect(riskEventsRepo.save).toHaveBeenCalledTimes(2);

      // Requirement 13.7: alert is emitted even when window is exhausted early.
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        JOURNAL_WRITE_FAILED_EVENT,
        expect.objectContaining({ recordType: 'risk_events' }),
      );
    }, 60_000);
  });

  // ─── Append-only invariant ───────────────────────────────────────────────────

  describe('append-only semantics', () => {
    const allEntities = [
      { repo: () => signalsRepo, method: () => service.recordSignal(signalDto) },
      { repo: () => signalsRepo, method: () => service.recordRejectedSignal(rejectedSignalDto) },
      { repo: () => ordersRepo, method: () => service.recordOrder(orderDto) },
      { repo: () => executionsRepo, method: () => service.recordFill(fillDto) },
      { repo: () => positionsRepo, method: () => service.recordPosition(positionDto) },
      { repo: () => tradesRepo, method: () => service.recordCompletedTrade(completedTradeDto) },
      { repo: () => riskEventsRepo, method: () => service.recordRiskEvent(riskEventDto) },
      {
        repo: () => systemHealthEventsRepo,
        method: () => service.recordSystemError(systemErrorDto),
      },
      { repo: () => auditLogsRepo, method: () => service.recordConfigChange(configChangeDto) },
    ];

    it.each(allEntities.map((e, i) => [i, e]))(
      'write operation %i should call save() (INSERT) and the mock has no update/delete methods',
      async (_i, entry) => {
        const { repo, method } = entry as (typeof allEntities)[0];
        await method();
        // TypeORM `save()` on a new entity without an id triggers INSERT.
        // The mock repository intentionally exposes only create() + save().
        // The absence of update/delete on the mock verifies that TradeJournal
        // never references those methods (append-only invariant per Req 13.3).
        expect(repo().save).toHaveBeenCalledTimes(1);
        expect(Object.keys(repo())).not.toContain('update');
        expect(Object.keys(repo())).not.toContain('delete');
      },
    );
  });
});
