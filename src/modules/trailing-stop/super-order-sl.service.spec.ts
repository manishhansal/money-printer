/**
 * super-order-sl.service.spec.ts
 *
 * Unit tests for SuperOrderSlService.
 *
 * Requirements: 12.3, 12.5
 */

import {
  PositionSlRegistryEntry,
  SL_CONFIRMATION_TIMEOUT_MS,
  SuperOrderSlService,
} from './super-order-sl.service';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationService } from '../notification/notification.service';
import { DhanOrder, DhanOrderResponse, DhanOrderbookResponse } from '../dhan/dhan-api.types';

// ─────────────────────────────────────────────────────────────────────────────
// Test-double factories
// ─────────────────────────────────────────────────────────────────────────────

function buildDhanApiClientMock(): jest.Mocked<Pick<DhanApiClient, 'placeOrder' | 'getOrderById'>> {
  return {
    placeOrder: jest.fn(),
    getOrderById: jest.fn(),
  };
}

function buildSecretsServiceMock(): jest.Mocked<Pick<SecretsService, 'get'>> {
  return {
    get: jest.fn().mockResolvedValue('test-client-id'),
  };
}

function buildNotificationServiceMock(): jest.Mocked<Pick<NotificationService, 'publish'>> {
  return {
    publish: jest.fn().mockResolvedValue(undefined),
  };
}

function buildService(
  dhanMock: jest.Mocked<Pick<DhanApiClient, 'placeOrder' | 'getOrderById'>>,
  secretsMock: jest.Mocked<Pick<SecretsService, 'get'>>,
  notificationMock: jest.Mocked<Pick<NotificationService, 'publish'>>,
): SuperOrderSlService {
  return new SuperOrderSlService(
    dhanMock as unknown as DhanApiClient,
    secretsMock as unknown as SecretsService,
    notificationMock as unknown as NotificationService,
  );
}

/** Helper: build a minimal DhanOrder shape */
function buildDhanOrder(overrides: Partial<DhanOrder> = {}): DhanOrder {
  return {
    dhanClientId: 'test-client-id',
    orderId: 'order-001',
    correlationId: 'corr-001',
    orderStatus: 'PENDING',
    transactionType: 'SELL',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    orderType: 'STOP_LOSS_MARKET',
    validity: 'DAY',
    tradingSymbol: 'NIFTY25JUNFUT',
    securityId: 'instr-123',
    quantity: 50,
    disclosedQuantity: 0,
    price: 0,
    triggerPrice: 19000,
    afterMarketOrder: false,
    boProfitValue: 0,
    boStopLossValue: 0,
    averageTradedPrice: 0,
    filledQty: 0,
    pendingQuantity: 50,
    cancelledQuantity: 0,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    exchangeTime: new Date().toISOString(),
    drvExpiryDate: '2025-06-26',
    drvOptionType: null,
    drvStrikePrice: 0,
    ...overrides,
  };
}

/** Helper: build a DhanOrderResponse */
function buildOrderResponse(orderId: string): DhanOrderResponse {
  return { orderId, orderStatus: 'TRANSIT' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SL_CONFIRMATION_TIMEOUT_MS constant
// ─────────────────────────────────────────────────────────────────────────────

describe('SL_CONFIRMATION_TIMEOUT_MS', () => {
  it('is exactly 5000 ms (Requirement 12.3)', () => {
    expect(SL_CONFIRMATION_TIMEOUT_MS).toBe(5_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. registerBrokerSl()
// ─────────────────────────────────────────────────────────────────────────────

describe('SuperOrderSlService — registerBrokerSl()', () => {
  it('calls dhanApiClient.placeOrder() with STOP_LOSS_MARKET and correct parameters (LONG)', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-001'));
    const svc = buildService(dhan, secrets, notification);

    const result = await svc.registerBrokerSl('pos-001', 'instr-123', 19000, 'LONG', 50);

    expect(result.success).toBe(true);
    expect(result.dhanOrderId).toBe('order-001');

    expect(dhan.placeOrder).toHaveBeenCalledTimes(1);
    const callArg = dhan.placeOrder.mock.calls[0][0];
    expect(callArg.orderType).toBe('STOP_LOSS_MARKET');
    expect(callArg.transactionType).toBe('SELL'); // LONG → exit via SELL
    expect(callArg.securityId).toBe('instr-123');
    expect(callArg.quantity).toBe(50);
    expect(callArg.triggerPrice).toBe(19000);
    expect(callArg.dhanClientId).toBe('test-client-id');
  });

  it('uses SELL for LONG positions and BUY for SHORT positions', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-002'));
    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-short', 'instr-456', 20000, 'SHORT', 25);

    const callArg = dhan.placeOrder.mock.calls[0][0];
    expect(callArg.transactionType).toBe('BUY'); // SHORT → exit via BUY
  });

  it('stores the entry in the internal registry with confirmed=false', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-003'));
    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-002', 'instr-789', 18500, 'LONG', 100);

    const entry = svc.getBrokerSlStatus('pos-002') as PositionSlRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.dhanOrderId).toBe('order-003');
    expect(entry.confirmed).toBe(false);
    expect(entry.slPrice).toBe(18500);
    expect(entry.instrumentId).toBe('instr-789');
    expect(entry.direction).toBe('LONG');
    expect(entry.quantity).toBe(100);
  });

  it('stores registeredAt as a recent Date', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    const beforeCall = Date.now();
    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-004'));
    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-003', 'instr-001', 17000, 'LONG', 50);

    const entry = svc.getBrokerSlStatus('pos-003') as PositionSlRegistryEntry;
    expect(entry.registeredAt.getTime()).toBeGreaterThanOrEqual(beforeCall);
    expect(entry.registeredAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('returns success=false and error when placeOrder() throws', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockRejectedValue(new Error('Dhan API error: HTTP 503'));
    const svc = buildService(dhan, secrets, notification);

    const result = await svc.registerBrokerSl('pos-004', 'instr-002', 19500, 'LONG', 50);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/HTTP 503/);
    expect(result.dhanOrderId).toBeUndefined();
  });

  it('does NOT create a registry entry when placeOrder() fails', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockRejectedValue(new Error('Network timeout'));
    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-005', 'instr-003', 18000, 'LONG', 50);

    expect(svc.getBrokerSlStatus('pos-005')).toBeUndefined();
  });

  it('uses NSE_FNO and INTRADAY as defaults when not specified', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-005'));
    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-006', 'instr-004', 19200, 'LONG', 50);

    const callArg = dhan.placeOrder.mock.calls[0][0];
    expect(callArg.exchangeSegment).toBe('NSE_FNO');
    expect(callArg.productType).toBe('INTRADAY');
  });

  it('allows custom exchangeSegment and productType to be passed', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-006'));
    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-007', 'instr-005', 19100, 'SHORT', 25, 'NSE_EQ', 'CNC');

    const callArg = dhan.placeOrder.mock.calls[0][0];
    expect(callArg.exchangeSegment).toBe('NSE_EQ');
    expect(callArg.productType).toBe('CNC');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. verifyBrokerSlConfirmation() — confirmed path
// ─────────────────────────────────────────────────────────────────────────────

describe('SuperOrderSlService — verifyBrokerSlConfirmation() — confirmed', () => {
  async function setupWithRegisteredSl(dhanOrderId: string, orderbookEntry: DhanOrder) {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse(dhanOrderId));
    dhan.getOrderById.mockResolvedValue(orderbookEntry);

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-010', 'instr-100', 19000, 'LONG', 50);
    return { svc, dhan, secrets, notification };
  }

  it('returns { active: true } when order is in PENDING status', async () => {
    const { svc } = await setupWithRegisteredSl(
      'order-010',
      buildDhanOrder({ orderId: 'order-010', orderStatus: 'PENDING' }),
    );

    const result = await svc.verifyBrokerSlConfirmation('pos-010');
    expect(result.active).toBe(true);
    expect(result.replacementOrderId).toBeUndefined();
  });

  it('returns { active: true } when order is in TRANSIT status', async () => {
    const { svc } = await setupWithRegisteredSl(
      'order-011',
      buildDhanOrder({ orderId: 'order-011', orderStatus: 'TRANSIT' }),
    );

    const result = await svc.verifyBrokerSlConfirmation('pos-010');
    expect(result.active).toBe(true);
  });

  it('marks the registry entry as confirmed=true when order is active', async () => {
    const { svc } = await setupWithRegisteredSl(
      'order-012',
      buildDhanOrder({ orderId: 'order-012', orderStatus: 'PENDING' }),
    );

    await svc.verifyBrokerSlConfirmation('pos-010');

    const entry = svc.getBrokerSlStatus('pos-010') as PositionSlRegistryEntry;
    expect(entry.confirmed).toBe(true);
  });

  it('calls getOrderById() with registered dhanOrderId', async () => {
    const { svc, dhan } = await setupWithRegisteredSl(
      'order-013',
      buildDhanOrder({ orderId: 'order-013', orderStatus: 'PENDING' }),
    );

    await svc.verifyBrokerSlConfirmation('pos-010');
    expect(dhan.getOrderById).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. verifyBrokerSlConfirmation() — inactive path → replacement
// ─────────────────────────────────────────────────────────────────────────────

describe('SuperOrderSlService — verifyBrokerSlConfirmation() — inactive/replacement', () => {
  it('returns { active: false, replacementOrderId } when order is REJECTED', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder
      .mockResolvedValueOnce(buildOrderResponse('order-021')) // original
      .mockResolvedValueOnce(buildOrderResponse('order-022')); // replacement

    dhan.getOrderById.mockResolvedValue(
      buildDhanOrder({ orderId: 'order-021', orderStatus: 'REJECTED' }),
    );

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-020', 'instr-200', 18500, 'LONG', 50);

    const result = await svc.verifyBrokerSlConfirmation('pos-020');

    expect(result.active).toBe(false);
    expect(result.replacementOrderId).toBe('order-022');
  });

  it('returns { active: false, replacementOrderId } when order is CANCELLED', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder
      .mockResolvedValueOnce(buildOrderResponse('order-023'))
      .mockResolvedValueOnce(buildOrderResponse('order-024'));

    dhan.getOrderById.mockResolvedValue(
      buildDhanOrder({ orderId: 'order-023', orderStatus: 'CANCELLED' }),
    );

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-021', 'instr-201', 18400, 'SHORT', 25);

    const result = await svc.verifyBrokerSlConfirmation('pos-021');

    expect(result.active).toBe(false);
    expect(result.replacementOrderId).toBe('order-024');
  });

  it('submits replacement when order is NOT found in orderbook (Requirement 12.5)', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder
      .mockResolvedValueOnce(buildOrderResponse('order-025'))
      .mockResolvedValueOnce(buildOrderResponse('order-026'));

    // Orderbook is empty — original order not found
    dhan.getOrderById.mockRejectedValue(new Error('order not found'));

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-022', 'instr-202', 17800, 'LONG', 75);

    const result = await svc.verifyBrokerSlConfirmation('pos-022');

    expect(result.active).toBe(false);
    expect(result.replacementOrderId).toBe('order-026');
    // replacement placeOrder() must have been called
    expect(dhan.placeOrder).toHaveBeenCalledTimes(2);
  });

  it('replacement order uses same slPrice, instrumentId, quantity from registry', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder
      .mockResolvedValueOnce(buildOrderResponse('order-027'))
      .mockResolvedValueOnce(buildOrderResponse('order-028'));

    dhan.getOrderById.mockRejectedValue(new Error('order not found'));

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-023', 'instr-203', 17500, 'LONG', 60, 'NSE_FNO', 'INTRADAY');

    await svc.verifyBrokerSlConfirmation('pos-023');

    const replacementCall = dhan.placeOrder.mock.calls[1][0];
    expect(replacementCall.triggerPrice).toBe(17500);
    expect(replacementCall.securityId).toBe('instr-203');
    expect(replacementCall.quantity).toBe(60);
    expect(replacementCall.exchangeSegment).toBe('NSE_FNO');
    expect(replacementCall.productType).toBe('INTRADAY');
    expect(replacementCall.transactionType).toBe('SELL'); // LONG → SELL
    expect(replacementCall.orderType).toBe('STOP_LOSS_MARKET');
  });

  it('updates registry entry with replacement orderId after successful replacement', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder
      .mockResolvedValueOnce(buildOrderResponse('order-029'))
      .mockResolvedValueOnce(buildOrderResponse('order-030'));

    dhan.getOrderById.mockRejectedValue(new Error('order not found'));

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-024', 'instr-204', 17200, 'LONG', 50);

    await svc.verifyBrokerSlConfirmation('pos-024');

    const entry = svc.getBrokerSlStatus('pos-024') as PositionSlRegistryEntry;
    expect(entry.dhanOrderId).toBe('order-030');
    expect(entry.confirmed).toBe(false); // replacement not yet verified
  });

  it('returns { active: false } without replacementOrderId when replacement placeOrder() fails', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder
      .mockResolvedValueOnce(buildOrderResponse('order-031'))
      .mockRejectedValueOnce(new Error('Exchange rejection'));

    dhan.getOrderById.mockRejectedValue(new Error('order not found'));

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-025', 'instr-205', 16900, 'LONG', 50);

    const result = await svc.verifyBrokerSlConfirmation('pos-025');

    expect(result.active).toBe(false);
    expect(result.replacementOrderId).toBeUndefined();
  });

  it('returns { active: false } when no registry entry exists for positionId', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    const svc = buildService(dhan, secrets, notification);

    const result = await svc.verifyBrokerSlConfirmation('pos-nonexistent');

    expect(result.active).toBe(false);
    expect(result.replacementOrderId).toBeUndefined();
    expect(dhan.getOrderById).not.toHaveBeenCalled();
  });

  it('returns { active: false } when getOrderById() throws', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-032'));
    dhan.getOrderById.mockRejectedValue(new Error('Network error'));

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-026', 'instr-206', 16500, 'LONG', 50);

    const result = await svc.verifyBrokerSlConfirmation('pos-026');

    expect(result.active).toBe(false);
  });

  it('SHORT: replacement uses BUY transaction type', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder
      .mockResolvedValueOnce(buildOrderResponse('order-033'))
      .mockResolvedValueOnce(buildOrderResponse('order-034'));

    dhan.getOrderById.mockRejectedValue(new Error('order not found'));

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-027', 'instr-207', 20500, 'SHORT', 30);

    await svc.verifyBrokerSlConfirmation('pos-027');

    const replacementCall = dhan.placeOrder.mock.calls[1][0];
    expect(replacementCall.transactionType).toBe('BUY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. getBrokerSlStatus()
// ─────────────────────────────────────────────────────────────────────────────

describe('SuperOrderSlService — getBrokerSlStatus()', () => {
  it('returns undefined for a position with no registered SL', () => {
    const svc = buildService(
      buildDhanApiClientMock(),
      buildSecretsServiceMock(),
      buildNotificationServiceMock(),
    );
    expect(svc.getBrokerSlStatus('pos-unknown')).toBeUndefined();
  });

  it('returns the full registry entry after a successful registration', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-040'));
    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-030', 'instr-300', 15000, 'LONG', 100);

    const status = svc.getBrokerSlStatus('pos-030') as PositionSlRegistryEntry;
    expect(status).toBeDefined();
    expect(status.dhanOrderId).toBe('order-040');
    expect(status.slPrice).toBe(15000);
    expect(status.confirmed).toBe(false);
    expect(status.instrumentId).toBe('instr-300');
    expect(status.direction).toBe('LONG');
    expect(status.quantity).toBe(100);
  });

  it('reflects confirmed=true after successful verifyBrokerSlConfirmation()', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-041'));
    dhan.getOrderById.mockResolvedValue(
      buildDhanOrder({ orderId: 'order-041', orderStatus: 'PENDING' }),
    );

    const svc = buildService(dhan, secrets, notification);
    await svc.registerBrokerSl('pos-031', 'instr-301', 15200, 'SHORT', 50);
    await svc.verifyBrokerSlConfirmation('pos-031');

    const status = svc.getBrokerSlStatus('pos-031') as PositionSlRegistryEntry;
    expect(status.confirmed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. removeBrokerSl()
// ─────────────────────────────────────────────────────────────────────────────

describe('SuperOrderSlService — removeBrokerSl()', () => {
  it('removes the registry entry so getBrokerSlStatus() returns undefined afterwards', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-050'));
    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-040', 'instr-400', 14000, 'LONG', 50);
    expect(svc.getBrokerSlStatus('pos-040')).toBeDefined();

    svc.removeBrokerSl('pos-040');

    expect(svc.getBrokerSlStatus('pos-040')).toBeUndefined();
  });

  it('is a no-op (no throw) when the positionId has no entry', () => {
    const svc = buildService(
      buildDhanApiClientMock(),
      buildSecretsServiceMock(),
      buildNotificationServiceMock(),
    );
    expect(() => svc.removeBrokerSl('pos-nonexistent')).not.toThrow();
  });

  it('only removes the specified positionId — other entries are unaffected', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder
      .mockResolvedValueOnce(buildOrderResponse('order-051'))
      .mockResolvedValueOnce(buildOrderResponse('order-052'));

    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-041', 'instr-401', 14100, 'LONG', 50);
    await svc.registerBrokerSl('pos-042', 'instr-402', 14200, 'SHORT', 25);

    svc.removeBrokerSl('pos-041');

    expect(svc.getBrokerSlStatus('pos-041')).toBeUndefined();
    expect(svc.getBrokerSlStatus('pos-042')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Cross-cutting: correlationId format and uniqueness
// ─────────────────────────────────────────────────────────────────────────────

describe('SuperOrderSlService — correlationId', () => {
  it('correlationId does not contain the full positionId (truncated to 8 chars)', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    const positionId = '123e4567-e89b-12d3-a456-426614174000';
    dhan.placeOrder.mockResolvedValue(buildOrderResponse('order-060'));
    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl(positionId, 'instr-500', 13000, 'LONG', 50);

    const callArg = dhan.placeOrder.mock.calls[0][0];
    // correlationId must start with "sl-" followed by first 8 chars of positionId
    expect(callArg.correlationId).toMatch(/^sl-123e4567-/);
  });

  it('two calls produce distinct correlationIds (randomness from uuid suffix)', async () => {
    const dhan = buildDhanApiClientMock();
    const secrets = buildSecretsServiceMock();
    const notification = buildNotificationServiceMock();

    dhan.placeOrder
      .mockResolvedValueOnce(buildOrderResponse('order-061'))
      .mockResolvedValueOnce(buildOrderResponse('order-062'));

    const svc = buildService(dhan, secrets, notification);

    await svc.registerBrokerSl('pos-050', 'instr-501', 13100, 'LONG', 50);
    await svc.registerBrokerSl('pos-051', 'instr-502', 13200, 'LONG', 50);

    const id1 = dhan.placeOrder.mock.calls[0][0].correlationId as string;
    const id2 = dhan.placeOrder.mock.calls[1][0].correlationId as string;
    expect(id1).not.toBe(id2);
  });
});
