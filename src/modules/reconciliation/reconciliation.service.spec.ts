/**
 * reconciliation.service.spec.ts
 *
 * Unit tests for ReconciliationService.
 *
 * Coverage:
 *
 *   EOD Reconciliation (runEodReconciliation):
 *     - No discrepancy → newOrdersHalted remains false
 *     - Discrepancy found (CloudEngine order not in Dhan) → newOrdersHalted = true,
 *       CRITICAL alert published, audit log recorded
 *
 *   Reconnection Reconciliation (triggerReconnectionReconciliation):
 *     - Completes within 30 s, no discrepancy → not halted
 *     - Completes within 30 s, discrepancy → halted, CRITICAL alert published
 *     - Timeout (exceeds 30 s) → newOrdersHalted = true, timeout CRITICAL alert published
 *
 *   SL Status Verification (verifySLStatusAfterReconnect):
 *     - Returns correct verified / inactive position lists
 *     - Empty positionIds → returns both lists empty immediately
 *     - Timeout → all positions returned as inactive
 *
 *   ACK / Auto-agreement (acknowledgeDiscrepancy):
 *     - Clears newOrdersHalted and haltReason
 *     - Persists acknowledgment to AuditLogs
 *
 *   isNewOrdersHalted / getHaltReason:
 *     - Returns false initially
 *     - Returns true after a discrepancy is found
 *     - Returns false again after acknowledgment
 *
 * Requirements: 12.4, 17.6, 19.1, 19.2, 19.3, 19.4
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ReconciliationService } from './reconciliation.service';
import {
  ReconciliationTimeoutError,
  DiscrepancyType,
  PnlAgreementResult,
} from './reconciliation.types';

import { Order } from '../../database/entities/orders.entity';
import { Execution } from '../../database/entities/executions.entity';
import { Position } from '../../database/entities/positions.entity';
import { AuditLogs, AuditEventType, AuditOutcome } from '../../database/entities/audit-logs.entity';

import { DhanApiClient } from '../dhan/dhan-api.client';
import { NotificationService } from '../notification/notification.service';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-uuid-1',
    idempotency_key: 'idem-1',
    engine: 'LIVE',
    signal_id: null,
    instrument_id: 'instr-1',
    order_type: 'LIMIT',
    transaction_type: 'BUY',
    quantity: 1,
    price: '100.00',
    trigger_price: null,
    dhan_order_id: 'dhan-order-1',
    dhan_correlation_id: null,
    status: 'open',
    rejection_reason: null,
    submitted_at: new Date('2024-01-15T10:00:00Z'),
    filled_quantity: 0,
    average_fill_price: null,
    created_at: new Date('2024-01-15T10:00:00Z'),
    updated_at: new Date('2024-01-15T10:00:00Z'),
    executions: [],
    ...overrides,
  } as Order;
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    engine: 'LIVE',
    instrument_id: 'instr-1',
    signal_id: null,
    direction: 'LONG',
    quantity: 1,
    average_entry_price: '100.00',
    current_sl: '95.00',
    target_price: null,
    trailing_stop_mechanism: null,
    unrealized_pnl: '0',
    mfe: '0',
    mae: '0',
    opened_at: new Date('2024-01-15T09:30:00Z'),
    closed_at: null,
    is_open: true,
    created_at: new Date('2024-01-15T09:30:00Z'),
    updated_at: new Date('2024-01-15T09:30:00Z'),
    trades: [],
    ...overrides,
  } as Position;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDhanOrder(orderId: string, orderStatus = 'PENDING'): any {
  return {
    dhanClientId: 'client-1',
    orderId,
    correlationId: '',
    orderStatus,
    transactionType: 'BUY',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    orderType: 'LIMIT',
    validity: 'DAY',
    tradingSymbol: 'NIFTY24JAN25000CE',
    securityId: '49081',
    quantity: 1,
    disclosedQuantity: 0,
    price: 100,
    triggerPrice: 0,
    afterMarketOrder: false,
    boProfitValue: 0,
    boStopLossValue: 0,
    averageTradedPrice: 0,
    filledQty: 0,
    pendingQuantity: 1,
    cancelledQuantity: 0,
    createTime: '2024-01-15T10:00:00',
    updateTime: '2024-01-15T10:00:00',
    exchangeTime: '2024-01-15T10:00:00',
    drvExpiryDate: '2024-01-25',
    drvOptionType: 'CALL',
    drvStrikePrice: 25000,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDhanTrade(orderId: string): any {
  return {
    dhanClientId: 'client-1',
    orderId,
    exchangeOrderId: 'exch-1',
    exchangeTradeId: 'trade-1',
    transactionType: 'BUY',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    orderType: 'LIMIT',
    tradingSymbol: 'NIFTY24JAN25000CE',
    securityId: '49081',
    tradedQuantity: 1,
    tradedPrice: 100,
    createTime: '2024-01-15T10:00:00',
    updateTime: '2024-01-15T10:00:00',
    exchangeTime: '2024-01-15T10:00:00',
    drvExpiryDate: '2024-01-25',
    drvOptionType: 'CALL',
    drvStrikePrice: 25000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

function makeOrdersRepo() {
  return {
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
}

function makeExecutionsRepo() {
  return {
    find: jest.fn(),
  };
}

function makePositionsRepo() {
  return {
    find: jest.fn(),
  };
}

function makeAuditLogsRepo() {
  return {
    create: jest.fn().mockReturnValue({}),
    save: jest.fn().mockResolvedValue({}),
  };
}

function makeDhanApiClient() {
  return {
    getOrderbook: jest.fn(),
    getTradebook: jest.fn(),
    getPositions: jest.fn(),
  };
}

function makeNotificationService() {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────────

interface BuildServiceResult {
  service: ReconciliationService;
  ordersRepo: ReturnType<typeof makeOrdersRepo>;
  executionsRepo: ReturnType<typeof makeExecutionsRepo>;
  positionsRepo: ReturnType<typeof makePositionsRepo>;
  auditLogsRepo: ReturnType<typeof makeAuditLogsRepo>;
  dhanApiClient: ReturnType<typeof makeDhanApiClient>;
  notificationService: ReturnType<typeof makeNotificationService>;
}

async function buildService(): Promise<BuildServiceResult> {
  const ordersRepo = makeOrdersRepo();
  const executionsRepo = makeExecutionsRepo();
  const positionsRepo = makePositionsRepo();
  const auditLogsRepo = makeAuditLogsRepo();
  const dhanApiClient = makeDhanApiClient();
  const notificationService = makeNotificationService();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ReconciliationService,
      { provide: getRepositoryToken(Order), useValue: ordersRepo },
      { provide: getRepositoryToken(Execution), useValue: executionsRepo },
      { provide: getRepositoryToken(Position), useValue: positionsRepo },
      { provide: getRepositoryToken(AuditLogs), useValue: auditLogsRepo },
      { provide: DhanApiClient, useValue: dhanApiClient },
      { provide: NotificationService, useValue: notificationService },
    ],
  }).compile();

  return {
    service: module.get<ReconciliationService>(ReconciliationService),
    ordersRepo,
    executionsRepo,
    positionsRepo,
    auditLogsRepo,
    dhanApiClient,
    notificationService,
  };
}

/**
 * Spy on a protected/private method on the service and make it return a
 * promise that never resolves (simulates an operation that hangs forever).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spyNeverResolves(service: ReconciliationService, method: string): jest.SpyInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest.spyOn(service as any, method).mockImplementation(() => new Promise(() => {}));
}

/**
 * Spy on createTimeoutPromise and make it reject immediately with a
 * ReconciliationTimeoutError so tests don't have to wait for real timers.
 */
function spyTimeoutImmediate(
  service: ReconciliationService,
  operationName: string,
  timeoutMs: number,
): jest.SpyInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest
    .spyOn(service as any, 'createTimeoutPromise')
    .mockImplementation(() =>
      Promise.reject(new ReconciliationTimeoutError(operationName, timeoutMs)),
    );
}

/**
 * Spy on createTimeoutPromise and make it never fire (so the actual operation
 * wins the Promise.race without being interrupted).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spyTimeoutNeverFires(service: ReconciliationService): jest.SpyInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest
    .spyOn(service as any, 'createTimeoutPromise')
    .mockImplementation(() => new Promise(() => {}));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ReconciliationService', () => {
  // ── isNewOrdersHalted / getHaltReason — initial state ───────────────────

  describe('isNewOrdersHalted()', () => {
    it('returns false initially (no reconciliation has run)', async () => {
      const { service } = await buildService();
      expect(service.isNewOrdersHalted()).toBe(false);
    });

    it('returns null halt reason initially', async () => {
      const { service } = await buildService();
      expect(service.getHaltReason()).toBeNull();
    });
  });

  // ── EOD Reconciliation — no discrepancy ─────────────────────────────────

  describe('runEodReconciliation() — no discrepancy', () => {
    it('does NOT halt new orders when every CloudEngine order is found in Dhan', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient } = await buildService();

      // CloudEngine: 2 open LIVE orders
      ordersRepo.find.mockResolvedValue([
        makeOrder({ id: 'order-1', dhan_order_id: 'dhan-1' }),
        makeOrder({ id: 'order-2', dhan_order_id: 'dhan-2' }),
      ]);
      executionsRepo.find.mockResolvedValue([]);

      // Dhan: same 2 order IDs present
      dhanApiClient.getOrderbook.mockResolvedValue([
        makeDhanOrder('dhan-1', 'PENDING'),
        makeDhanOrder('dhan-2', 'PENDING'),
      ]);
      dhanApiClient.getTradebook.mockResolvedValue([]);

      await service.runEodReconciliation();

      expect(service.isNewOrdersHalted()).toBe(false);
    });

    it('does NOT publish an alert when there are no discrepancies', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient, notificationService } =
        await buildService();

      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: 'dhan-1' })]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([makeDhanOrder('dhan-1')]);
      dhanApiClient.getTradebook.mockResolvedValue([]);

      await service.runEodReconciliation();

      expect(notificationService.publish).not.toHaveBeenCalled();
    });

    it('skips orders without a dhan_order_id (not yet submitted)', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient } = await buildService();

      // Order with no dhan_order_id — should not cause a discrepancy
      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: null, status: 'submitted' })]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);
      dhanApiClient.getTradebook.mockResolvedValue([]);

      await service.runEodReconciliation();

      expect(service.isNewOrdersHalted()).toBe(false);
    });

    it('records reconciliation run in AuditLogs on success', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient, auditLogsRepo } =
        await buildService();

      ordersRepo.find.mockResolvedValue([]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);
      dhanApiClient.getTradebook.mockResolvedValue([]);

      await service.runEodReconciliation();

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.RECONCILIATION_ACTION,
          entityType: 'ReconciliationRun',
          outcome: AuditOutcome.SUCCESS,
        }),
      );
      expect(auditLogsRepo.save).toHaveBeenCalled();
    });
  });

  // ── EOD Reconciliation — discrepancy found ───────────────────────────────

  describe('runEodReconciliation() — discrepancy found', () => {
    it('sets newOrdersHalted = true when a CloudEngine order is missing from Dhan', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient } = await buildService();

      // CloudEngine has an order with dhan-999 but Dhan orderbook is empty
      ordersRepo.find.mockResolvedValue([makeOrder({ id: 'order-1', dhan_order_id: 'dhan-999' })]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]); // dhan-999 NOT in orderbook
      dhanApiClient.getTradebook.mockResolvedValue([]);

      await service.runEodReconciliation();

      expect(service.isNewOrdersHalted()).toBe(true);
    });

    it('publishes a CRITICAL alert when a discrepancy is detected', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient, notificationService } =
        await buildService();

      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: 'dhan-missing' })]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]); // dhan-missing NOT found
      dhanApiClient.getTradebook.mockResolvedValue([]);

      await service.runEodReconciliation();

      expect(notificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'CRITICAL' }),
      );
    });

    it('records discrepancy details in AuditLogs', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient, auditLogsRepo } =
        await buildService();

      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: 'dhan-missing' })]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);
      dhanApiClient.getTradebook.mockResolvedValue([]);

      await service.runEodReconciliation();

      const savedMetadata = (auditLogsRepo.create as jest.Mock).mock.calls[0][0];
      expect(savedMetadata.metadata.discrepancies).toHaveLength(1);
      expect(savedMetadata.metadata.discrepancies[0].type).toBe(
        DiscrepancyType.ORDER_NOT_FOUND_IN_DHAN,
      );
    });

    it('sets haltReason to a descriptive string on discrepancy', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient } = await buildService();

      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: 'dhan-99' })]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);
      dhanApiClient.getTradebook.mockResolvedValue([]);

      await service.runEodReconciliation();

      expect(service.getHaltReason()).not.toBeNull();
      expect(service.getHaltReason()).toMatch(/discrepancy/i);
    });

    it('flags Dhan trades with no matching CloudEngine order as unrecognised executions', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient, auditLogsRepo } =
        await buildService();

      // No CloudEngine orders
      ordersRepo.find.mockResolvedValue([]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);
      // Dhan has a trade with orderId not in CloudEngine
      dhanApiClient.getTradebook.mockResolvedValue([makeDhanTrade('unknown-dhan-id')]);

      await service.runEodReconciliation();

      expect(service.isNewOrdersHalted()).toBe(true);
      const savedMetadata = (auditLogsRepo.create as jest.Mock).mock.calls[0][0];
      const discrepancies: Array<{ type: DiscrepancyType }> = savedMetadata.metadata.discrepancies;
      expect(discrepancies.some((d) => d.type === DiscrepancyType.UNRECOGNIZED_EXECUTION)).toBe(
        true,
      );
    });
  });

  // ── Reconnection Reconciliation — completes normally ────────────────────

  describe('triggerReconnectionReconciliation() — completes within 30 s', () => {
    it('does not halt orders when no discrepancy is found', async () => {
      const { service, ordersRepo, dhanApiClient } = await buildService();

      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: 'dhan-1' })]);
      dhanApiClient.getOrderbook.mockResolvedValue([makeDhanOrder('dhan-1')]);
      dhanApiClient.getPositions.mockResolvedValue([]);

      // Prevent the real 30s timer from hanging the test
      spyTimeoutNeverFires(service);

      await service.triggerReconnectionReconciliation();

      expect(service.isNewOrdersHalted()).toBe(false);
    });

    it('halts orders and publishes CRITICAL alert on discrepancy', async () => {
      const { service, ordersRepo, dhanApiClient, notificationService } = await buildService();

      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: 'dhan-missing' })]);
      dhanApiClient.getOrderbook.mockResolvedValue([]); // dhan-missing NOT found
      dhanApiClient.getPositions.mockResolvedValue([]);

      spyTimeoutNeverFires(service);

      await service.triggerReconnectionReconciliation();

      expect(service.isNewOrdersHalted()).toBe(true);
      expect(notificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'CRITICAL' }),
      );
    });
  });

  // ── Reconnection Reconciliation — timeout ───────────────────────────────

  describe('triggerReconnectionReconciliation() — timeout', () => {
    it('halts new order submissions when reconciliation exceeds 30 seconds', async () => {
      const { service } = await buildService();

      // performReconnectionReconciliation never resolves
      spyNeverResolves(service, 'performReconnectionReconciliation');
      // createTimeoutPromise rejects immediately with timeout error
      spyTimeoutImmediate(service, 'reconnection reconciliation', 30_000);

      await service.triggerReconnectionReconciliation();

      expect(service.isNewOrdersHalted()).toBe(true);
    });

    it('publishes a CRITICAL timeout alert when reconciliation times out', async () => {
      const { service, notificationService } = await buildService();

      spyNeverResolves(service, 'performReconnectionReconciliation');
      spyTimeoutImmediate(service, 'reconnection reconciliation', 30_000);

      await service.triggerReconnectionReconciliation();

      expect(notificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'CRITICAL',
          title: expect.stringContaining('Timeout'),
        }),
      );
    });

    it('records a TIMEOUT run in AuditLogs', async () => {
      const { service, auditLogsRepo } = await buildService();

      spyNeverResolves(service, 'performReconnectionReconciliation');
      spyTimeoutImmediate(service, 'reconnection reconciliation', 30_000);

      await service.triggerReconnectionReconciliation();

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.RECONCILIATION_ACTION,
          // TIMEOUT is treated as a successfully-handled outcome, not a code failure
          outcome: AuditOutcome.SUCCESS,
        }),
      );
    });

    it('sets a descriptive haltReason on timeout', async () => {
      const { service } = await buildService();

      spyNeverResolves(service, 'performReconnectionReconciliation');
      spyTimeoutImmediate(service, 'reconnection reconciliation', 30_000);

      await service.triggerReconnectionReconciliation();

      expect(service.getHaltReason()).toMatch(/timed?\s+out|timeout/i);
    });
  });

  // ── SL Status Verification ───────────────────────────────────────────────

  describe('verifySLStatusAfterReconnect()', () => {
    it('returns empty lists immediately for an empty positionIds array', async () => {
      const { service } = await buildService();

      const result = await service.verifySLStatusAfterReconnect([]);

      expect(result.verified).toHaveLength(0);
      expect(result.inactive).toHaveLength(0);
    });

    it('returns correct verified and inactive lists based on Dhan orderbook', async () => {
      const { service, positionsRepo, ordersRepo, dhanApiClient } = await buildService();

      // 3 positions across 3 instruments
      positionsRepo.find.mockResolvedValue([
        makePosition({ id: 'pos-1', instrument_id: 'instr-a' }),
        makePosition({ id: 'pos-2', instrument_id: 'instr-b' }),
        makePosition({ id: 'pos-3', instrument_id: 'instr-c' }),
      ]);

      // SL orders: each instrument has one SL order with a dhan_order_id
      ordersRepo.find.mockResolvedValue([
        makeOrder({
          id: 'sl-ord-1',
          instrument_id: 'instr-a',
          order_type: 'SL',
          dhan_order_id: 'dhan-sl-1',
        }),
        makeOrder({
          id: 'sl-ord-2',
          instrument_id: 'instr-b',
          order_type: 'SL-M',
          dhan_order_id: 'dhan-sl-2',
        }),
        makeOrder({
          id: 'sl-ord-3',
          instrument_id: 'instr-c',
          order_type: 'SL',
          dhan_order_id: 'dhan-sl-3',
        }),
      ]);

      // Dhan: dhan-sl-1 and dhan-sl-2 are active; dhan-sl-3 is CANCELLED
      dhanApiClient.getOrderbook.mockResolvedValue([
        makeDhanOrder('dhan-sl-1', 'PENDING'),
        makeDhanOrder('dhan-sl-2', 'PENDING'),
        makeDhanOrder('dhan-sl-3', 'CANCELLED'),
      ]);

      // Prevent timeout from interfering with this normal-path test
      spyTimeoutNeverFires(service);

      const result = await service.verifySLStatusAfterReconnect(['pos-1', 'pos-2', 'pos-3']);

      expect(result.verified).toContain('pos-1');
      expect(result.verified).toContain('pos-2');
      expect(result.inactive).toContain('pos-3');
      expect(result.verified).not.toContain('pos-3');
    });

    it('marks a position as inactive when its SL order has no dhan_order_id', async () => {
      const { service, positionsRepo, ordersRepo, dhanApiClient } = await buildService();

      positionsRepo.find.mockResolvedValue([
        makePosition({ id: 'pos-1', instrument_id: 'instr-a' }),
      ]);
      // SL order without dhan_order_id — not yet submitted to broker
      ordersRepo.find.mockResolvedValue([
        makeOrder({
          instrument_id: 'instr-a',
          order_type: 'SL',
          dhan_order_id: null, // not submitted
        }),
      ]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);

      spyTimeoutNeverFires(service);

      const result = await service.verifySLStatusAfterReconnect(['pos-1']);

      expect(result.inactive).toContain('pos-1');
      expect(result.verified).not.toContain('pos-1');
    });

    it('marks a position as inactive when it cannot be found in the DB', async () => {
      const { service, positionsRepo, ordersRepo } = await buildService();

      // DB returns no position for 'pos-unknown'
      positionsRepo.find.mockResolvedValue([]);
      ordersRepo.find.mockResolvedValue([]);

      spyTimeoutNeverFires(service);

      const result = await service.verifySLStatusAfterReconnect(['pos-unknown']);

      expect(result.inactive).toContain('pos-unknown');
    });

    it('returns all positions as inactive on timeout', async () => {
      const { service } = await buildService();

      // performSLVerification never resolves
      spyNeverResolves(service, 'performSLVerification');
      // Timeout fires immediately
      spyTimeoutImmediate(service, 'SL status verification', 60_000);

      const result = await service.verifySLStatusAfterReconnect(['pos-a', 'pos-b']);

      expect(result.verified).toHaveLength(0);
      expect(result.inactive).toEqual(expect.arrayContaining(['pos-a', 'pos-b']));
    });
  });

  // ── ACK / Auto-agreement ────────────────────────────────────────────────

  describe('acknowledgeDiscrepancy()', () => {
    it('clears newOrdersHalted after a discrepancy acknowledgment', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient } = await buildService();

      // Trigger a halt via EOD
      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: 'dhan-missing' })]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);
      dhanApiClient.getTradebook.mockResolvedValue([]);
      await service.runEodReconciliation();

      expect(service.isNewOrdersHalted()).toBe(true);

      // ACK the discrepancy
      await service.acknowledgeDiscrepancy('some-reconciliation-id');

      expect(service.isNewOrdersHalted()).toBe(false);
    });

    it('clears haltReason after acknowledgment', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient } = await buildService();

      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: 'dhan-missing' })]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);
      dhanApiClient.getTradebook.mockResolvedValue([]);
      await service.runEodReconciliation();

      await service.acknowledgeDiscrepancy('rec-id-1');

      expect(service.getHaltReason()).toBeNull();
    });

    it('persists acknowledgment to AuditLogs with RECONCILIATION_ACTION event type', async () => {
      const { service, auditLogsRepo } = await buildService();

      await service.acknowledgeDiscrepancy('rec-id-123');

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.RECONCILIATION_ACTION,
          entityType: 'ReconciliationRun',
          entityId: 'rec-id-123',
          outcome: AuditOutcome.SUCCESS,
        }),
      );
      expect(auditLogsRepo.save).toHaveBeenCalled();
    });

    it('is idempotent — second ACK does not error even if already cleared', async () => {
      const { service } = await buildService();

      // Service starts unhalted; ACK should still not throw
      await expect(service.acknowledgeDiscrepancy('any-id')).resolves.not.toThrow();
    });
  });

  // ── isNewOrdersHalted — state transitions ───────────────────────────────

  describe('isNewOrdersHalted() — state transitions', () => {
    it('transitions false → true → false across discrepancy + ACK lifecycle', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient } = await buildService();

      // 1. Initially false
      expect(service.isNewOrdersHalted()).toBe(false);

      // 2. EOD finds a discrepancy → true
      ordersRepo.find.mockResolvedValue([makeOrder({ dhan_order_id: 'dhan-missing' })]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);
      dhanApiClient.getTradebook.mockResolvedValue([]);
      await service.runEodReconciliation();

      expect(service.isNewOrdersHalted()).toBe(true);

      // 3. ACK → false
      await service.acknowledgeDiscrepancy('rec-id');

      expect(service.isNewOrdersHalted()).toBe(false);
    });
  });

  // ── alertUnrecognizedExecution ───────────────────────────────────────────

  describe('alertUnrecognizedExecution()', () => {
    it('publishes a CRITICAL alert with the unrecognized orderId', async () => {
      const { service, notificationService } = await buildService();

      await service.alertUnrecognizedExecution('dhan-unrec-99');

      expect(notificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'CRITICAL',
          title: 'Unrecognized Execution Detected',
          metadata: expect.objectContaining({ dhanOrderId: 'dhan-unrec-99' }),
        }),
      );
    });

    it('publishes the unrecognized execution alert immediately during EOD reconciliation', async () => {
      const { service, ordersRepo, executionsRepo, dhanApiClient, notificationService } =
        await buildService();

      ordersRepo.find.mockResolvedValue([]);
      executionsRepo.find.mockResolvedValue([]);
      dhanApiClient.getOrderbook.mockResolvedValue([]);
      // Dhan has a trade whose orderId is unknown to CloudEngine
      dhanApiClient.getTradebook.mockResolvedValue([makeDhanTrade('orphan-order-id')]);

      await service.runEodReconciliation();

      // The unrecognized-execution alert should have been published (Req 19.5)
      const unrecAlert = (notificationService.publish as jest.Mock).mock.calls.find(
        ([alert]) => alert.title === 'Unrecognized Execution Detected',
      );
      expect(unrecAlert).toBeDefined();
      expect(unrecAlert![0]).toMatchObject({
        priority: 'CRITICAL',
        metadata: expect.objectContaining({ dhanOrderId: 'orphan-order-id' }),
      });
    });
  });

  // ── verifyPnlAgreement ───────────────────────────────────────────────────

  describe('verifyPnlAgreement()', () => {
    it('returns { agreement: true } when all three values are identical', async () => {
      const { service } = await buildService();
      const result: PnlAgreementResult = service.verifyPnlAgreement(1000, 1000, 1000);
      expect(result.agreement).toBe(true);
      expect(result.discrepancy).toBeUndefined();
    });

    it('returns { agreement: true } when differences are well within ₹1 tolerance', async () => {
      const { service } = await buildService();
      // 0.50 and 0.30 differences — both within 1.00
      const result = service.verifyPnlAgreement(1000.5, 1000.0, 999.7);
      expect(result.agreement).toBe(true);
      expect(result.discrepancy).toBeUndefined();
    });

    it('returns { agreement: true } when the difference is exactly ₹1.00 (boundary)', async () => {
      const { service } = await buildService();
      // Exact boundary: |1001 - 1000| = 1.00 ≤ 1.00 → still in agreement
      const result = service.verifyPnlAgreement(1001, 1000, 1000);
      expect(result.agreement).toBe(true);
    });

    it('returns { agreement: false } when CloudEngine and Dhan P&L differ by more than ₹1', async () => {
      const { service } = await buildService();
      // |1002 - 1000| = 2.00 > 1.00
      const result = service.verifyPnlAgreement(1002, 1000, 1000);
      expect(result.agreement).toBe(false);
      expect(result.discrepancy).toMatch(/CloudEngine/i);
      expect(result.discrepancy).toMatch(/Dhan/i);
    });

    it('returns { agreement: false } when Dhan P&L and CapitalLedger differ by more than ₹1', async () => {
      const { service } = await buildService();
      // Cloud vs Dhan: |1000 - 1000| = 0 (OK); Dhan vs Ledger: |1000 - 998| = 2 > 1
      const result = service.verifyPnlAgreement(1000, 1000, 998);
      expect(result.agreement).toBe(false);
      expect(result.discrepancy).toMatch(/CapitalLedger/i);
    });

    it('discrepancy message includes the actual rupee difference', async () => {
      const { service } = await buildService();
      const result = service.verifyPnlAgreement(1500, 1497, 1497);
      expect(result.agreement).toBe(false);
      // |1500 - 1497| = 3.00 — should appear in the message
      expect(result.discrepancy).toMatch(/3\.00/);
    });

    it('reports a discrepancy when difference is ₹1.01 (just above boundary)', async () => {
      const { service } = await buildService();
      // |1001.01 - 1000| = 1.01 > 1.00
      const result = service.verifyPnlAgreement(1001.01, 1000, 1000);
      expect(result.agreement).toBe(false);
    });
  });
});
