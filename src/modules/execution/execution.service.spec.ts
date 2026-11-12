/**
 * execution.service.spec.ts
 *
 * Unit tests for ExecutionService.
 *
 * Coverage:
 *   Idempotency guard (Requirements 16.6, 16.7):
 *     - Duplicate request (Redis key exists) returns "duplicate-order-rejected"
 *       without calling DhanApiClient or running pre-trade checks
 *     - Returns the existing orderId stored in Redis
 *     - After a successful placement the idempotency key is stored with 5-minute TTL
 *     - A second identical request within the 5-minute window is rejected
 *     - A request after TTL expires (no Redis key) proceeds normally
 *
 *   Pre-trade validation chain:
 *     - Check 1 failure (score-below-threshold)
 *     - Check 2 failure (risk-engine-rejected)
 *     - Check 3 failure (insufficient-margin)
 *     - Check 4 failure (duplicate-order)
 *     - Check 5 failure (session-time-violation)
 *     - Happy path: all 5 checks pass → order placed and persisted
 *     - Sequence enforcement: check 1 fail → risk engine never called
 *     - Sequence enforcement: check 2 fail → margin never checked
 *     - Sequence enforcement: check 3 fail → Orders table never queried
 *     - Sequence enforcement: check 4 fail → session phase never checked
 *
 *   Order lifecycle:
 *     - modifyOrder: calls DhanApiClient.modifyOrder + updates Orders table
 *     - cancelOrder: calls DhanApiClient.cancelOrder + sets status CANCELLED
 *     - handleFill:  updates Orders (filled_qty, avg_price, status)
 *                    + inserts into Executions table
 *     - handleFill with partial fill → status 'partial'
 *     - handleFill completing full quantity → status 'complete'
 *
 * Requirements: 11.3, 11.4, 16.6, 16.7
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';

import { ExecutionService } from './execution.service';
import { Order } from '../../database/entities/orders.entity';
import { Execution } from '../../database/entities/executions.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { Position } from '../../database/entities/positions.entity';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { RiskManagementService } from '../risk-management/risk-management.service';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { SessionPhase } from '../session-manager/session-manager.types';
import { LiveTradingService } from '../live-trading/live-trading.service';
import { ArmedState } from '../live-trading/live-trading.types';
import { SecretsService } from '../secrets/secrets.service';
import { RedisService } from '../redis/redis.service';
import { OrderRequest, FillData, OrderModification } from './execution.types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A valid OrderRequest that passes all 5 checks.
 *
 * NOTE: `quantity` is in UNITS (lots × lotSize).  Default is 50 = 1 lot × lotSize 50.
 * Tests that override `quantity` MUST pass a value that is a multiple of `lotSize`.
 */
function makeOrderRequest(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    idempotencyKey: 'idempotency-uuid-1234',
    engine: 'LIVE',
    signalId: 'signal-uuid-5678',
    compositeScore: 85,
    instrumentId: 'instrument-uuid-abcd',
    securityId: '49081',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    orderType: 'LIMIT',
    transactionType: 'BUY',
    // 1 lot × lotSize 50 = 50 units.  quantity MUST be a multiple of lotSize.
    quantity: 50,
    selectedLots: 1,
    price: 100,
    entryPrice: '100.00',
    stopLossPrice: '95.00',
    lotSize: 50,
    dynamicCapital: '100000.00',
    riskPercentage: '1.00',
    currentTotalExposure: '0.00',
    currentCorrelatedExposure: '0.00',
    currentInstrumentExposure: '0.00',
    openPositionsCount: 0,
    requiredMargin: 5000,
    ...overrides,
  };
}

/** A saved Order row as TypeORM would return it. */
function makeSavedOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-db-uuid-1111',
    idempotency_key: 'idempotency-uuid-1234',
    engine: 'LIVE',
    signal_id: 'signal-uuid-5678',
    instrument_id: 'instrument-uuid-abcd',
    order_type: 'LIMIT',
    transaction_type: 'BUY',
    quantity: 1,
    price: '100.00',
    trigger_price: null,
    dhan_order_id: 'dhan-order-9999',
    dhan_correlation_id: 'idempotency-uuid-1234',
    status: 'submitted',
    rejection_reason: null,
    submitted_at: new Date('2024-01-01T10:00:00Z'),
    filled_quantity: 0,
    average_fill_price: null,
    created_at: new Date('2024-01-01T10:00:00Z'),
    updated_at: new Date('2024-01-01T10:00:00Z'),
    executions: [],
    ...overrides,
  } as Order;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeOrdersRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
}

function makeInstrumentsRepo() {
  return {
    findOne: jest.fn(),
  };
}

function makeExecutionsRepo() {
  return {
    create: jest.fn(),
    save: jest.fn(),
  };
}

function makeDhanApiClient() {
  return {
    placeOrder: jest.fn(),
    modifyOrder: jest.fn(),
    cancelOrder: jest.fn(),
    getFundLimit: jest.fn(),
  };
}

function makeRiskManagementService() {
  return {
    evaluatePreEntryGates: jest.fn(),
  };
}

function makeSessionManagerService() {
  return {
    getCurrentPhase: jest.fn(),
  };
}

function makeSecretsService() {
  return {
    get: jest.fn().mockResolvedValue('TEST_CLIENT_ID'),
  };
}

function makeRedisService() {
  return {
    get: jest.fn().mockResolvedValue(null), // no key by default → not a duplicate
    set: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Default: engine is ARMED and new entries are not blocked.
 * Tests that exercise the armed-state gates override these individually.
 */
function makeLiveTradingService() {
  return {
    isArmed: jest.fn().mockReturnValue(true),
    isNewEntryBlocked: jest.fn().mockReturnValue(false),
    getArmedState: jest.fn().mockReturnValue(ArmedState.ARMED),
  };
}

// ---------------------------------------------------------------------------
// Test setup helper
// ---------------------------------------------------------------------------

async function buildService(): Promise<{
  service: ExecutionService;
  ordersRepo: ReturnType<typeof makeOrdersRepo>;
  executionsRepo: ReturnType<typeof makeExecutionsRepo>;
  instrumentsRepo: ReturnType<typeof makeInstrumentsRepo>;
  dhanApiClient: ReturnType<typeof makeDhanApiClient>;
  riskManagementService: ReturnType<typeof makeRiskManagementService>;
  sessionManagerService: ReturnType<typeof makeSessionManagerService>;
  liveTradingService: ReturnType<typeof makeLiveTradingService>;
  secretsService: ReturnType<typeof makeSecretsService>;
  redisService: ReturnType<typeof makeRedisService>;
}> {
  const ordersRepo = makeOrdersRepo();
  const executionsRepo = makeExecutionsRepo();
  const instrumentsRepo = makeInstrumentsRepo();
  const dhanApiClient = makeDhanApiClient();
  const riskManagementService = makeRiskManagementService();
  const sessionManagerService = makeSessionManagerService();
  const liveTradingService = makeLiveTradingService();
  const secretsService = makeSecretsService();
  const redisService = makeRedisService();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ExecutionService,
      { provide: getRepositoryToken(Order), useValue: ordersRepo },
      { provide: getRepositoryToken(Execution), useValue: executionsRepo },
      { provide: getRepositoryToken(Instruments), useValue: instrumentsRepo },
      {
        provide: getRepositoryToken(Position),
        useValue: { findOne: jest.fn().mockResolvedValue(null) },
      },
      { provide: DhanApiClient, useValue: dhanApiClient },
      { provide: RiskManagementService, useValue: riskManagementService },
      { provide: SessionManagerService, useValue: sessionManagerService },
      { provide: LiveTradingService, useValue: liveTradingService },
      { provide: SecretsService, useValue: secretsService },
      { provide: RedisService, useValue: redisService },
    ],
  }).compile();

  return {
    service: module.get<ExecutionService>(ExecutionService),
    ordersRepo,
    executionsRepo,
    instrumentsRepo,
    dhanApiClient,
    riskManagementService,
    sessionManagerService,
    liveTradingService,
    secretsService,
    redisService,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExecutionService', () => {
  // ── Idempotency guard (Check 0) ───────────────────────────────────────────

  describe('placeOrder — Check 0: idempotency guard', () => {
    it('returns "duplicate-order-rejected" when Redis key already exists', async () => {
      const { service, redisService, dhanApiClient, riskManagementService } = await buildService();

      // Simulate a key that was stored by a previous successful placement
      redisService.get.mockResolvedValue('order-db-uuid-existing');

      const response = await service.placeOrder(
        makeOrderRequest({ idempotencyKey: 'my-idem-key' }),
      );

      expect(response.status).toBe('rejected');
      expect(response.rejectedBy).toBe('duplicate-order-rejected');
      // Must not call DhanApiClient or run any pre-trade check
      expect(dhanApiClient.getFundLimit).not.toHaveBeenCalled();
      expect(dhanApiClient.placeOrder).not.toHaveBeenCalled();
      expect(riskManagementService.evaluatePreEntryGates).not.toHaveBeenCalled();
    });

    it('returns the existing orderId stored in Redis', async () => {
      const { service, redisService } = await buildService();

      redisService.get.mockResolvedValue('order-db-uuid-existing');

      const response = await service.placeOrder(makeOrderRequest());

      expect(response.orderId).toBe('order-db-uuid-existing');
      expect(response.dhanOrderId).toBeNull();
    });

    it('checks Redis with the correct key pattern orders:idempotency:{key}', async () => {
      const { service, redisService } = await buildService();

      redisService.get.mockResolvedValue('some-existing-id');

      await service.placeOrder(makeOrderRequest({ idempotencyKey: 'unique-key-abc' }));

      expect(redisService.get).toHaveBeenCalledWith('orders:idempotency:unique-key-abc');
    });

    it('stores the idempotency key in Redis with 300s TTL after successful placement', async () => {
      const {
        service,
        redisService,
        riskManagementService,
        dhanApiClient,
        sessionManagerService,
        ordersRepo,
      } = await buildService();

      // Idempotency key does not exist yet
      redisService.get.mockResolvedValue(null);
      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 50000,
        sodLimit: 100000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 50000,
      });
      ordersRepo.findOne.mockResolvedValue(null);
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.MID_SESSION);
      dhanApiClient.placeOrder.mockResolvedValue({ orderId: 'dhan-7777', orderStatus: 'TRANSIT' });
      const savedOrder = makeSavedOrder({ id: 'new-db-order-id', dhan_order_id: 'dhan-7777' });
      ordersRepo.create.mockReturnValue(savedOrder);
      ordersRepo.save.mockResolvedValue(savedOrder);

      await service.placeOrder(makeOrderRequest({ idempotencyKey: 'my-idem-key-xyz' }));

      expect(redisService.set).toHaveBeenCalledWith(
        'orders:idempotency:my-idem-key-xyz',
        'new-db-order-id',
        300,
      );
    });

    it('a second identical request within the 5-minute window is rejected', async () => {
      const {
        service,
        redisService,
        riskManagementService,
        dhanApiClient,
        sessionManagerService,
        ordersRepo,
      } = await buildService();

      const idemKey = 'repeat-key-123';

      // First call: key does not exist → placement succeeds
      redisService.get.mockResolvedValue(null);
      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 50000,
        sodLimit: 100000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 50000,
      });
      ordersRepo.findOne.mockResolvedValue(null);
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.MID_SESSION);
      dhanApiClient.placeOrder.mockResolvedValue({ orderId: 'dhan-8888', orderStatus: 'TRANSIT' });
      const saved = makeSavedOrder({ id: 'placed-order-id', dhan_order_id: 'dhan-8888' });
      ordersRepo.create.mockReturnValue(saved);
      ordersRepo.save.mockResolvedValue(saved);

      const first = await service.placeOrder(makeOrderRequest({ idempotencyKey: idemKey }));
      expect(first.status).toBe('submitted');

      // Simulate Redis now holding the key (as the service stored it)
      redisService.get.mockResolvedValue('placed-order-id');

      // Second call with the same key → rejected immediately
      const second = await service.placeOrder(makeOrderRequest({ idempotencyKey: idemKey }));
      expect(second.status).toBe('rejected');
      expect(second.rejectedBy).toBe('duplicate-order-rejected');
      expect(second.orderId).toBe('placed-order-id');
      // Dhan API must only have been called once (from the first placement)
      expect(dhanApiClient.placeOrder).toHaveBeenCalledTimes(1);
    });

    it('a request after the TTL expires (no Redis key) proceeds normally', async () => {
      const {
        service,
        redisService,
        riskManagementService,
        dhanApiClient,
        sessionManagerService,
        ordersRepo,
      } = await buildService();

      // Redis returns null → key has expired (or never existed)
      redisService.get.mockResolvedValue(null);
      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 50000,
        sodLimit: 100000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 50000,
      });
      ordersRepo.findOne.mockResolvedValue(null);
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.MORNING_MOMENTUM);
      dhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'dhan-new-after-ttl',
        orderStatus: 'TRANSIT',
      });
      const saved = makeSavedOrder({ dhan_order_id: 'dhan-new-after-ttl' });
      ordersRepo.create.mockReturnValue(saved);
      ordersRepo.save.mockResolvedValue(saved);

      const response = await service.placeOrder(makeOrderRequest());

      expect(response.status).toBe('submitted');
      expect(dhanApiClient.placeOrder).toHaveBeenCalledTimes(1);
    });
  });

  // ── Pre-trade check: Check 1 ──────────────────────────────────────────────

  describe('placeOrder — Check 1: composite score', () => {
    it('rejects with "score-below-threshold" when compositeScore < 80', async () => {
      const { service, riskManagementService } = await buildService();

      const request = makeOrderRequest({ compositeScore: 79 });
      const response = await service.placeOrder(request);

      expect(response.status).toBe('rejected');
      expect(response.rejectedBy).toBe('score-below-threshold');
      expect(response.orderId).toBeNull();
      expect(response.dhanOrderId).toBeNull();
      // Risk engine must NOT be called when check 1 fails
      expect(riskManagementService.evaluatePreEntryGates).not.toHaveBeenCalled();
    });

    it('rejects with score = 0', async () => {
      const { service } = await buildService();
      const response = await service.placeOrder(makeOrderRequest({ compositeScore: 0 }));
      expect(response.rejectedBy).toBe('score-below-threshold');
    });

    it('passes check 1 when score = 80 (boundary)', async () => {
      const { service, riskManagementService } = await buildService();

      // Set up subsequent mocks so we can verify check 1 passes (and check 2 fails)
      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: false,
        failingGate: 'PER_TRADE_LOSS',
        reason: 'exceeded',
      });

      const response = await service.placeOrder(makeOrderRequest({ compositeScore: 80 }));

      // Check 1 passed (risk engine was called), check 2 failed
      expect(riskManagementService.evaluatePreEntryGates).toHaveBeenCalledTimes(1);
      expect(response.rejectedBy).toBe('risk-engine-rejected');
    });
  });

  // ── Pre-trade check: Check 2 ──────────────────────────────────────────────

  describe('placeOrder — Check 2: risk engine', () => {
    it('rejects with "risk-engine-rejected" when risk engine disapproves', async () => {
      const { service, riskManagementService, dhanApiClient } = await buildService();

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: false,
        failingGate: 'TOTAL_EXPOSURE',
        reason: 'Total exposure exceeds limit',
      });

      const response = await service.placeOrder(makeOrderRequest());

      expect(response.status).toBe('rejected');
      expect(response.rejectedBy).toBe('risk-engine-rejected');
      expect(response.rejectionReason).toContain('TOTAL_EXPOSURE');
      // Margin check must NOT be called when check 2 fails
      expect(dhanApiClient.getFundLimit).not.toHaveBeenCalled();
    });

    it('passes gate input fields correctly to evaluatePreEntryGates', async () => {
      const { service, riskManagementService } = await buildService();

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: false,
        failingGate: 'SIGNAL_SCORE',
        reason: 'score too low',
      });

      const req = makeOrderRequest({
        compositeScore: 85,
        entryPrice: '200.00',
        stopLossPrice: '190.00',
        lotSize: 25,
        dynamicCapital: '500000.00',
        riskPercentage: '2.00',
        currentTotalExposure: '50000.00',
        currentCorrelatedExposure: '10000.00',
        currentInstrumentExposure: '5000.00',
        openPositionsCount: 3,
      });

      await service.placeOrder(req);

      expect(riskManagementService.evaluatePreEntryGates).toHaveBeenCalledWith(
        expect.objectContaining({
          compositeScore: 85,
          entryPrice: '200.00',
          stopLossPrice: '190.00',
          lotSize: 25,
          dynamicCapital: '500000.00',
          riskPercentage: '2.00',
          currentTotalExposure: '50000.00',
          currentCorrelatedExposure: '10000.00',
          currentInstrumentExposure: '5000.00',
          openPositionsCount: 3,
        }),
      );
    });
  });

  // ── Pre-trade check: Check 3 ──────────────────────────────────────────────

  describe('placeOrder — Check 3: margin', () => {
    it('rejects with "insufficient-margin" when available margin < required', async () => {
      const { service, riskManagementService, dhanApiClient, ordersRepo } = await buildService();

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 4999, // below requiredMargin of 5000
        sodLimit: 10000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 4999,
      });

      const response = await service.placeOrder(makeOrderRequest({ requiredMargin: 5000 }));

      expect(response.status).toBe('rejected');
      expect(response.rejectedBy).toBe('insufficient-margin');
      // Orders table must NOT be queried when check 3 fails
      expect(ordersRepo.findOne).not.toHaveBeenCalled();
    });

    it('passes when available balance exactly equals required margin', async () => {
      const { service, riskManagementService, dhanApiClient, ordersRepo } = await buildService();

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 5000, // exactly equals requiredMargin
        sodLimit: 10000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 5000,
      });
      // Let check 4 fail so we don't need to set up the full happy path
      ordersRepo.findOne.mockResolvedValue(makeSavedOrder({ status: 'open' }));

      const response = await service.placeOrder(makeOrderRequest({ requiredMargin: 5000 }));

      // Check 3 passed (margin ok), check 4 triggered duplicate rejection
      expect(response.rejectedBy).toBe('duplicate-order');
    });
  });

  // ── Pre-trade check: Check 4 ──────────────────────────────────────────────

  describe('placeOrder — Check 4: duplicate order', () => {
    it('rejects with "duplicate-order" when an open order exists for same instrument+direction', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 50000,
        sodLimit: 100000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 50000,
      });
      ordersRepo.findOne.mockResolvedValue(makeSavedOrder({ status: 'open' }));

      const response = await service.placeOrder(makeOrderRequest());

      expect(response.status).toBe('rejected');
      expect(response.rejectedBy).toBe('duplicate-order');
      // Session phase must NOT be checked when check 4 fails
      expect(sessionManagerService.getCurrentPhase).not.toHaveBeenCalled();
    });

    it('queries by correct instrument_id, transaction_type, and statuses', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 50000,
        sodLimit: 100000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 50000,
      });
      ordersRepo.findOne.mockResolvedValue(null); // no duplicate
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.AFTERNOON);
      dhanApiClient.placeOrder.mockResolvedValue({ orderId: 'dhan-123', orderStatus: 'TRANSIT' });
      ordersRepo.create.mockReturnValue(makeSavedOrder());
      ordersRepo.save.mockResolvedValue(makeSavedOrder());

      const req = makeOrderRequest({ instrumentId: 'instr-xyz', transactionType: 'SELL' });
      await service.placeOrder(req);

      expect(ordersRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            instrument_id: 'instr-xyz',
            transaction_type: 'SELL',
          }),
        }),
      );
    });
  });

  // ── Pre-trade check: Check 5 ──────────────────────────────────────────────

  describe('placeOrder — Check 5: session timing', () => {
    const setupPassingChecks1to4 = (mocks: {
      riskManagementService: ReturnType<typeof makeRiskManagementService>;
      dhanApiClient: ReturnType<typeof makeDhanApiClient>;
      ordersRepo: ReturnType<typeof makeOrdersRepo>;
    }) => {
      mocks.riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      mocks.dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 50000,
        sodLimit: 100000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 50000,
      });
      mocks.ordersRepo.findOne.mockResolvedValue(null); // no duplicate
    };

    it('rejects with "session-time-violation" during CLOSING phase', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      setupPassingChecks1to4({ riskManagementService, dhanApiClient, ordersRepo });
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.CLOSING);

      const response = await service.placeOrder(makeOrderRequest());

      expect(response.status).toBe('rejected');
      expect(response.rejectedBy).toBe('session-time-violation');
    });

    it('rejects with "session-time-violation" when market is CLOSED', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      setupPassingChecks1to4({ riskManagementService, dhanApiClient, ordersRepo });
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.MARKET_CLOSED);

      const response = await service.placeOrder(makeOrderRequest());

      expect(response.status).toBe('rejected');
      expect(response.rejectedBy).toBe('session-time-violation');
    });

    it('rejects with "session-time-violation" during EOD_RECONCILIATION', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      setupPassingChecks1to4({ riskManagementService, dhanApiClient, ordersRepo });
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.EOD_RECONCILIATION);

      const response = await service.placeOrder(makeOrderRequest());

      expect(response.status).toBe('rejected');
      expect(response.rejectedBy).toBe('session-time-violation');
    });

    it('rejects with "session-time-violation" during PRE_MARKET', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      setupPassingChecks1to4({ riskManagementService, dhanApiClient, ordersRepo });
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.PRE_MARKET);

      const response = await service.placeOrder(makeOrderRequest());

      expect(response.status).toBe('rejected');
      expect(response.rejectedBy).toBe('session-time-violation');
    });
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  describe('placeOrder — happy path', () => {
    async function runHappyPath() {
      const mocks = await buildService();
      const { riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } = mocks;

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 50000,
        sodLimit: 100000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 50000,
      });
      ordersRepo.findOne.mockResolvedValue(null); // no duplicate
      sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.MID_SESSION);
      dhanApiClient.placeOrder.mockResolvedValue({
        orderId: 'dhan-order-7777',
        orderStatus: 'TRANSIT',
      });
      const savedOrder = makeSavedOrder({ dhan_order_id: 'dhan-order-7777' });
      ordersRepo.create.mockReturnValue(savedOrder);
      ordersRepo.save.mockResolvedValue(savedOrder);

      return { mocks, savedOrder };
    }

    it('returns a submitted OrderResponse with orderId and dhanOrderId', async () => {
      const { mocks, savedOrder } = await runHappyPath();
      const response = await mocks.service.placeOrder(makeOrderRequest());

      expect(response.status).toBe('submitted');
      expect(response.orderId).toBe(savedOrder.id);
      expect(response.dhanOrderId).toBe('dhan-order-7777');
      expect(response.rejectedBy).toBeUndefined();
    });

    it('calls DhanApiClient.placeOrder with correct parameters', async () => {
      const { mocks } = await runHappyPath();
      // quantity must be UNITS (lots × lotSize). 2 lots × lotSize 50 = 100 units.
      const req = makeOrderRequest({
        securityId: '12345',
        transactionType: 'BUY',
        quantity: 100, // 2 lots × lotSize 50 = 100 units
        selectedLots: 2,
        price: 150,
      });

      await mocks.service.placeOrder(req);

      expect(mocks.dhanApiClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'BUY',
          securityId: '12345',
          quantity: 100, // UNITS forwarded to Dhan, not lots
          price: 150,
          orderType: 'LIMIT',
          validity: 'DAY',
        }),
      );
    });

    it('maps SL orderType to STOP_LOSS for Dhan API', async () => {
      const { mocks } = await runHappyPath();
      await mocks.service.placeOrder(
        makeOrderRequest({ orderType: 'SL', price: 100, triggerPrice: 98 }),
      );

      expect(mocks.dhanApiClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ orderType: 'STOP_LOSS' }),
      );
    });

    it('maps SL-M orderType to STOP_LOSS_MARKET for Dhan API', async () => {
      const { mocks } = await runHappyPath();
      await mocks.service.placeOrder(
        makeOrderRequest({ orderType: 'SL-M', price: undefined, triggerPrice: 98 }),
      );

      expect(mocks.dhanApiClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ orderType: 'STOP_LOSS_MARKET' }),
      );
    });

    it('persists the order to the Orders table with idempotency_key', async () => {
      const { mocks } = await runHappyPath();
      await mocks.service.placeOrder(makeOrderRequest({ idempotencyKey: 'my-idem-key-1234' }));

      // DB record is created FIRST (status='pending') before broker submission
      expect(mocks.ordersRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotency_key: 'my-idem-key-1234',
          status: 'pending', // intent written before broker call
          dhan_order_id: null, // not yet known
          submitted_at: null, // set after broker acknowledges
        }),
      );
      // save() is called twice: once for pending intent, once after broker ack
      expect(mocks.ordersRepo.save).toHaveBeenCalledTimes(2);
    });

    it('sets submitted_at on the persisted order', async () => {
      const { mocks } = await runHappyPath();
      await mocks.service.placeOrder(makeOrderRequest());

      // submitted_at is set on the second save (after broker acknowledgement)
      const secondSaveArg = mocks.ordersRepo.save.mock.calls[1][0] as Order;
      expect(secondSaveArg.submitted_at).toBeInstanceOf(Date);
    });

    it('passes all 5 phases between OPENING_VOLATILITY and AFTERNOON', async () => {
      const validPhases = [
        SessionPhase.OPENING_VOLATILITY,
        SessionPhase.ORB_FORMATION,
        SessionPhase.MORNING_MOMENTUM,
        SessionPhase.MID_SESSION,
        SessionPhase.AFTERNOON,
      ];

      for (const phase of validPhases) {
        const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
          await buildService();

        riskManagementService.evaluatePreEntryGates.mockReturnValue({
          approved: true,
          suggestedQuantity: 1,
        });
        dhanApiClient.getFundLimit.mockResolvedValue({
          dhanClientId: 'TEST',
          availabelBalance: 50000,
          sodLimit: 100000,
          collateralAmount: 0,
          receiveableAmount: 0,
          utilizedAmount: 0,
          blockedPayoutAmount: 0,
          withdrawableBalance: 50000,
        });
        ordersRepo.findOne.mockResolvedValue(null);
        sessionManagerService.getCurrentPhase.mockReturnValue(phase);
        dhanApiClient.placeOrder.mockResolvedValue({ orderId: 'dhan-123', orderStatus: 'TRANSIT' });
        const saved = makeSavedOrder();
        ordersRepo.create.mockReturnValue(saved);
        ordersRepo.save.mockResolvedValue(saved);

        const response = await service.placeOrder(makeOrderRequest());
        expect(response.status).toBe('submitted');
      }
    });
  });

  // ── Sequence enforcement ──────────────────────────────────────────────────

  describe('placeOrder — check sequence enforcement', () => {
    it('when check 1 fails: does NOT call risk engine, margin, orders repo, or session', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      await service.placeOrder(makeOrderRequest({ compositeScore: 50 }));

      expect(riskManagementService.evaluatePreEntryGates).not.toHaveBeenCalled();
      expect(dhanApiClient.getFundLimit).not.toHaveBeenCalled();
      expect(ordersRepo.findOne).not.toHaveBeenCalled();
      expect(sessionManagerService.getCurrentPhase).not.toHaveBeenCalled();
    });

    it('when check 2 fails: does NOT call margin check, orders repo, or session', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: false,
        failingGate: 'CONCURRENT_TRADES',
        reason: 'Too many trades',
      });

      await service.placeOrder(makeOrderRequest());

      expect(dhanApiClient.getFundLimit).not.toHaveBeenCalled();
      expect(ordersRepo.findOne).not.toHaveBeenCalled();
      expect(sessionManagerService.getCurrentPhase).not.toHaveBeenCalled();
    });

    it('when check 3 fails: does NOT query orders repo or session', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 100,
        sodLimit: 10000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 100,
      });

      await service.placeOrder(makeOrderRequest({ requiredMargin: 5000 }));

      expect(ordersRepo.findOne).not.toHaveBeenCalled();
      expect(sessionManagerService.getCurrentPhase).not.toHaveBeenCalled();
    });

    it('when check 4 fails: does NOT check session phase', async () => {
      const { service, riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } =
        await buildService();

      riskManagementService.evaluatePreEntryGates.mockReturnValue({
        approved: true,
        suggestedQuantity: 1,
      });
      dhanApiClient.getFundLimit.mockResolvedValue({
        dhanClientId: 'TEST',
        availabelBalance: 50000,
        sodLimit: 100000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 50000,
      });
      ordersRepo.findOne.mockResolvedValue(makeSavedOrder({ status: 'pending' }));

      await service.placeOrder(makeOrderRequest());

      expect(sessionManagerService.getCurrentPhase).not.toHaveBeenCalled();
    });
  });

  // ── modifyOrder ───────────────────────────────────────────────────────────

  describe('modifyOrder', () => {
    it('calls DhanApiClient.modifyOrder with the dhan_order_id', async () => {
      const { service, dhanApiClient, ordersRepo } = await buildService();

      const existing = makeSavedOrder({ dhan_order_id: 'dhan-9999', status: 'open', quantity: 2 });
      ordersRepo.findOne.mockResolvedValue(existing);
      dhanApiClient.modifyOrder.mockResolvedValue({ orderId: 'dhan-9999', orderStatus: 'PENDING' });
      ordersRepo.save.mockResolvedValue({ ...existing, quantity: 3 });

      const modification: OrderModification = { quantity: 3 };
      await service.modifyOrder(existing.id, modification);

      expect(dhanApiClient.modifyOrder).toHaveBeenCalledWith(
        'dhan-9999',
        expect.objectContaining({
          orderId: 'dhan-9999',
          quantity: 3,
          orderType: 'LIMIT',
          validity: 'DAY',
        }),
      );
      expect(ordersRepo.save).toHaveBeenCalled();
    });

    it('updates the Orders row when quantity and price are changed', async () => {
      const { service, dhanApiClient, ordersRepo } = await buildService();

      const existing = makeSavedOrder({
        dhan_order_id: 'dhan-5555',
        order_type: 'LIMIT',
        quantity: 1,
      });
      ordersRepo.findOne.mockResolvedValue(existing);
      dhanApiClient.modifyOrder.mockResolvedValue({ orderId: 'dhan-5555', orderStatus: 'PENDING' });
      ordersRepo.save.mockImplementation((o) => Promise.resolve(o as Order));

      await service.modifyOrder(existing.id, { quantity: 5, price: 200 });

      const saveArg = ordersRepo.save.mock.calls[0][0] as Order;
      expect(saveArg.quantity).toBe(5);
      expect(saveArg.price).toBe('200');
    });

    it('throws NotFoundException when order not found', async () => {
      const { service, ordersRepo } = await buildService();
      ordersRepo.findOne.mockResolvedValue(null);

      await expect(service.modifyOrder('nonexistent-id', { quantity: 1 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── cancelOrder ───────────────────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('calls DhanApiClient.cancelOrder with the dhan_order_id', async () => {
      const { service, dhanApiClient, ordersRepo } = await buildService();

      const existing = makeSavedOrder({ dhan_order_id: 'dhan-cancel-123', status: 'open' });
      ordersRepo.findOne.mockResolvedValue(existing);
      dhanApiClient.cancelOrder.mockResolvedValue({
        orderId: 'dhan-cancel-123',
        orderStatus: 'CANCELLED',
      });
      ordersRepo.save.mockResolvedValue({ ...existing, status: 'cancelled' });

      const response = await service.cancelOrder(existing.id);

      expect(dhanApiClient.cancelOrder).toHaveBeenCalledWith('dhan-cancel-123');
      expect(response.status).toBe('cancelled');
    });

    it('updates the Orders row status to "cancelled"', async () => {
      const { service, dhanApiClient, ordersRepo } = await buildService();

      const existing = makeSavedOrder({ status: 'open' });
      ordersRepo.findOne.mockResolvedValue(existing);
      dhanApiClient.cancelOrder.mockResolvedValue({
        orderId: 'dhan-order-9999',
        orderStatus: 'CANCELLED',
      });
      ordersRepo.save.mockImplementation((o) => Promise.resolve(o as Order));

      await service.cancelOrder(existing.id);

      const saveArg = ordersRepo.save.mock.calls[0][0] as Order;
      expect(saveArg.status).toBe('cancelled');
    });

    it('throws NotFoundException when order not found', async () => {
      const { service, ordersRepo } = await buildService();
      ordersRepo.findOne.mockResolvedValue(null);

      await expect(service.cancelOrder('ghost-order')).rejects.toThrow(NotFoundException);
    });
  });

  // ── handleFill ────────────────────────────────────────────────────────────

  describe('handleFill', () => {
    const makeFill = (overrides: Partial<FillData> = {}): FillData => ({
      orderId: 'order-db-uuid-1111',
      dhanTradeId: 'trade-tid-9999',
      fillPrice: '102.50',
      fillQuantity: 1,
      fillTimestamp: new Date('2024-01-01T10:30:00Z'),
      engine: 'LIVE',
      ...overrides,
    });

    it('updates the Orders row filled_quantity and average_fill_price', async () => {
      const { service, ordersRepo, executionsRepo } = await buildService();

      const order = makeSavedOrder({ quantity: 2, filled_quantity: 0, average_fill_price: null });
      ordersRepo.findOne.mockResolvedValue(order);
      ordersRepo.save.mockImplementation((o) => Promise.resolve(o as Order));
      const savedExec = { id: 'exec-uuid-1' } as Execution;
      executionsRepo.create.mockReturnValue(savedExec);
      executionsRepo.save.mockResolvedValue(savedExec);

      await service.handleFill(makeFill({ fillQuantity: 1, fillPrice: '102.50' }));

      const savedOrder = ordersRepo.save.mock.calls[0][0] as Order;
      expect(savedOrder.filled_quantity).toBe(1);
      expect(savedOrder.average_fill_price).toBe('102.50');
      expect(savedOrder.status).toBe('partial'); // 1 of 2 filled
    });

    it('sets status to "complete" when all quantity is filled', async () => {
      const { service, ordersRepo, executionsRepo } = await buildService();

      const order = makeSavedOrder({ quantity: 1, filled_quantity: 0, average_fill_price: null });
      ordersRepo.findOne.mockResolvedValue(order);
      ordersRepo.save.mockImplementation((o) => Promise.resolve(o as Order));
      executionsRepo.create.mockReturnValue({} as Execution);
      executionsRepo.save.mockResolvedValue({} as Execution);

      await service.handleFill(makeFill({ fillQuantity: 1 }));

      const savedOrder = ordersRepo.save.mock.calls[0][0] as Order;
      expect(savedOrder.status).toBe('complete');
    });

    it('calculates VWAP correctly for partial then completing fill', async () => {
      const { service, ordersRepo, executionsRepo } = await buildService();

      // First fill: 1 lot @ 100.00 → avg = 100.00, partial
      const order = makeSavedOrder({
        quantity: 2,
        filled_quantity: 1,
        average_fill_price: '100.00',
      });
      ordersRepo.findOne.mockResolvedValue(order);
      ordersRepo.save.mockImplementation((o) => Promise.resolve(o as Order));
      executionsRepo.create.mockReturnValue({} as Execution);
      executionsRepo.save.mockResolvedValue({} as Execution);

      // Second fill: 1 lot @ 110.00 → avg = (100 * 1 + 110 * 1) / 2 = 105.00
      await service.handleFill(makeFill({ fillQuantity: 1, fillPrice: '110.00' }));

      const savedOrder = ordersRepo.save.mock.calls[0][0] as Order;
      expect(savedOrder.average_fill_price).toBe('105.00');
      expect(savedOrder.status).toBe('complete');
    });

    it('inserts a row into Executions table', async () => {
      const { service, ordersRepo, executionsRepo } = await buildService();

      const order = makeSavedOrder({ quantity: 1, filled_quantity: 0 });
      ordersRepo.findOne.mockResolvedValue(order);
      ordersRepo.save.mockImplementation((o) => Promise.resolve(o as Order));
      const fakeExec = { id: 'exec-new' } as Execution;
      executionsRepo.create.mockReturnValue(fakeExec);
      executionsRepo.save.mockResolvedValue(fakeExec);

      const fill = makeFill({
        dhanTradeId: 'trade-888',
        fillPrice: '99.75',
        fillQuantity: 1,
        fillTimestamp: new Date('2024-01-01T11:00:00Z'),
        slippage: '0.25',
        engine: 'LIVE',
      });
      await service.handleFill(fill);

      expect(executionsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          order_id: order.id,
          dhan_trade_id: 'trade-888',
          fill_price: '99.75',
          fill_quantity: 1,
          fill_timestamp: fill.fillTimestamp,
          slippage: '0.25',
          engine: 'LIVE',
        }),
      );
      expect(executionsRepo.save).toHaveBeenCalledWith(fakeExec);
    });

    it('throws NotFoundException when order not found', async () => {
      const { service, ordersRepo } = await buildService();
      ordersRepo.findOne.mockResolvedValue(null);

      await expect(service.handleFill(makeFill({ orderId: 'missing-order' }))).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Lot-size invariant tests (Requirement P0-CRIT-001)
// ---------------------------------------------------------------------------

describe('ExecutionService — lot-size quantity invariant', () => {
  /**
   * Sets up all pre-trade mocks to pass so the quantity validation is reached.
   */
  async function buildPassingMocks() {
    const mocks = await buildService();
    const { riskManagementService, dhanApiClient, sessionManagerService, ordersRepo } = mocks;

    riskManagementService.evaluatePreEntryGates.mockReturnValue({
      approved: true,
      suggestedQuantity: 1,
    });
    dhanApiClient.getFundLimit.mockResolvedValue({
      dhanClientId: 'TEST',
      availabelBalance: 100000,
      sodLimit: 200000,
      collateralAmount: 0,
      receiveableAmount: 0,
      utilizedAmount: 0,
      blockedPayoutAmount: 0,
      withdrawableBalance: 100000,
    });
    ordersRepo.findOne.mockResolvedValue(null);
    sessionManagerService.getCurrentPhase.mockReturnValue(SessionPhase.MORNING_MOMENTUM);
    dhanApiClient.placeOrder.mockResolvedValue({
      orderId: 'dhan-qty-test',
      orderStatus: 'TRANSIT',
    });
    const saved = makeSavedOrder({ dhan_order_id: 'dhan-qty-test' });
    ordersRepo.create.mockReturnValue(saved);
    ordersRepo.save.mockResolvedValue(saved);

    return mocks;
  }

  it('P0: rejects when quantity is 0', async () => {
    const { service } = await buildPassingMocks();
    const response = await service.placeOrder(makeOrderRequest({ quantity: 0, lotSize: 50 }));
    expect(response.status).toBe('rejected');
    expect(response.rejectionReason).toMatch(/invalid quantity/i);
  });

  it('P0: rejects when quantity is negative', async () => {
    const { service } = await buildPassingMocks();
    const response = await service.placeOrder(makeOrderRequest({ quantity: -50, lotSize: 50 }));
    expect(response.status).toBe('rejected');
  });

  it('P0: rejects when quantity is not a multiple of lotSize (lots sent instead of units)', async () => {
    const { service } = await buildPassingMocks();
    // Classic bug: 1 lot sent as quantity=1 instead of quantity=75
    const response = await service.placeOrder(makeOrderRequest({ quantity: 1, lotSize: 75 }));
    expect(response.status).toBe('rejected');
    expect(response.rejectionReason).toMatch(/multiple of lot size/i);
  });

  it('P0: rejects when quantity is 2 (lots) for lotSize=75 — not a valid multiple', async () => {
    const { service } = await buildPassingMocks();
    const response = await service.placeOrder(makeOrderRequest({ quantity: 2, lotSize: 75 }));
    expect(response.status).toBe('rejected');
    expect(response.rejectionReason).toMatch(/multiple of lot size/i);
  });

  it('P0: accepts 1 lot × lotSize=75 → quantity=75', async () => {
    const { service, dhanApiClient } = await buildPassingMocks();
    const response = await service.placeOrder(
      makeOrderRequest({ quantity: 75, selectedLots: 1, lotSize: 75 }),
    );
    expect(response.status).toBe('submitted');
    expect(dhanApiClient.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 75 }),
    );
  });

  it('P0: accepts 2 lots × lotSize=75 → quantity=150', async () => {
    const { service, dhanApiClient } = await buildPassingMocks();
    const response = await service.placeOrder(
      makeOrderRequest({ quantity: 150, selectedLots: 2, lotSize: 75 }),
    );
    expect(response.status).toBe('submitted');
    expect(dhanApiClient.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 150 }),
    );
  });

  it('P0: accepts 3 lots × lotSize=25 → quantity=75 (FINNIFTY-style)', async () => {
    const { service, dhanApiClient } = await buildPassingMocks();
    const response = await service.placeOrder(
      makeOrderRequest({ quantity: 75, selectedLots: 3, lotSize: 25 }),
    );
    expect(response.status).toBe('submitted');
    expect(dhanApiClient.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 75 }),
    );
  });

  it('P0: invariant — Dhan API always receives quantityUnits divisible by lotSize', async () => {
    // Property: for any valid (lots, lotSize) pair, quantity sent to Dhan = lots × lotSize
    const cases: Array<{ lots: number; lotSize: number }> = [
      { lots: 1, lotSize: 25 },
      { lots: 1, lotSize: 50 },
      { lots: 1, lotSize: 75 },
      { lots: 2, lotSize: 25 },
      { lots: 2, lotSize: 50 },
      { lots: 2, lotSize: 100 },
      { lots: 3, lotSize: 25 },
      { lots: 5, lotSize: 15 },
    ];

    for (const { lots, lotSize } of cases) {
      const mocks = await buildPassingMocks();
      const quantityUnits = lots * lotSize;
      const response = await mocks.service.placeOrder(
        makeOrderRequest({ quantity: quantityUnits, selectedLots: lots, lotSize }),
      );
      expect(response.status).toBe('submitted');
      expect(mocks.dhanApiClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: quantityUnits }),
      );
      // Invariant: quantity sent to Dhan is always a multiple of lotSize
      const calledQty = mocks.dhanApiClient.placeOrder.mock.calls[0][0].quantity as number;
      expect(calledQty % lotSize).toBe(0);
      expect(calledQty).toBe(lots * lotSize);
    }
  });

  it('P0: DB order.quantity stores UNITS (not lots)', async () => {
    const { service, ordersRepo } = await buildPassingMocks();
    // 2 lots × lotSize=50 = 100 units
    await service.placeOrder(makeOrderRequest({ quantity: 100, selectedLots: 2, lotSize: 50 }));

    // First create call should have quantity=100 (units)
    const createArg = ordersRepo.create.mock.calls[0][0] as Partial<Order>;
    expect(createArg.quantity).toBe(100);
  });
});
