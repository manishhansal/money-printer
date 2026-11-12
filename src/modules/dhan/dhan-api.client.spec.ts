/**
 * dhan-api.client.spec.ts
 *
 * Tests for DhanApiClient — both normal operation and failure scenarios.
 *
 * Section 17 — Failure testing requirements:
 *  - Dhan API outage (HTTP errors)
 *  - Auth failure (401/403)
 *  - Rate limiting (429)
 *  - Queue overflow
 *  - Invalid response bodies
 *
 * Requirements: 3.4, 3.5, 3.7, 3.9, Section 17
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DhanApiClient } from './dhan-api.client';
import { DhanAuthFailureError, DhanRateLimitQueueFullError } from './dhan-api.types';
import { SecretsService } from '../secrets/secrets.service';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const mockSecrets = {
  get: jest.fn().mockResolvedValue('test-token'),
  set: jest.fn().mockResolvedValue(undefined),
};

const mockConfig = {
  get: jest.fn((key: string, defaultVal?: unknown) => {
    if (key === 'DHAN_API_BASE_URL') return 'https://api.dhan.co';
    return defaultVal;
  }),
};

global.fetch = jest.fn();

function mockFetchOk(body: unknown): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: () => null },
  });
}

function mockFetchError(status: number, retryAfter?: string): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ errorCode: `ERR_${status}`, errorMessage: `HTTP ${status}` }),
    text: async () => `HTTP ${status}`,
    headers: { get: (name: string) => (name === 'Retry-After' && retryAfter ? retryAfter : null) },
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('DhanApiClient', () => {
  let client: DhanApiClient;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DhanApiClient,
        { provide: SecretsService, useValue: mockSecrets },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    client = module.get<DhanApiClient>(DhanApiClient);
  });

  // ── Normal operation ──────────────────────────────────────────────────────

  describe('Normal operation', () => {
    it('getFundLimit returns fund data on 200 OK', async () => {
      const mockData = {
        dhanClientId: 'TEST',
        availabelBalance: 100000,
        sodLimit: 200000,
        collateralAmount: 0,
        receiveableAmount: 0,
        utilizedAmount: 0,
        blockedPayoutAmount: 0,
        withdrawableBalance: 100000,
      };
      mockFetchOk(mockData);
      const result = await client.getFundLimit();
      expect(result.availabelBalance).toBe(100000);
    });

    it('placeOrder returns orderId on success', async () => {
      mockFetchOk({ orderId: 'dhan-123', orderStatus: 'TRANSIT' });
      const result = await client.placeOrder({
        dhanClientId: 'TEST',
        transactionType: 'BUY',
        exchangeSegment: 'NSE_FNO',
        productType: 'INTRADAY',
        orderType: 'MARKET',
        validity: 'DAY',
        securityId: '49081',
        quantity: 75,
      });
      expect(result.orderId).toBe('dhan-123');
    });

    it('getOrderByCorrelationId retrieves order by correlation ID', async () => {
      const mockOrder = { orderId: 'dhan-456', orderStatus: 'FILLED', quantity: 75 };
      mockFetchOk(mockOrder);
      const result = await client.getOrderByCorrelationId('my-correlation-id');
      expect(result.orderId).toBe('dhan-456');
    });

    it('getTradesByOrderId retrieves trades for a specific order', async () => {
      mockFetchOk([{ orderId: 'dhan-789', tradedQuantity: 75, tradedPrice: 100.5 }]);
      const result = await client.getTradesByOrderId('dhan-789');
      expect(result).toHaveLength(1);
    });

    it('getSuperOrders returns super orders list', async () => {
      mockFetchOk([]);
      const result = await client.getSuperOrders();
      expect(Array.isArray(result)).toBe(true);
    });

    it('calculateMargin returns margin data', async () => {
      mockFetchOk({
        dhanClientId: 'TEST',
        totalMargin: 5000,
        spanMargin: 4000,
        exposureMargin: 1000,
        availableBalance: 95000,
        variableMargin: 0,
        insufficientBalance: false,
        netMarginRequired: 5000,
      });
      const result = await client.calculateMargin({
        dhanClientId: 'TEST',
        instruments: [
          {
            exchangeSegment: 'NSE_FNO',
            transactionType: 'BUY',
            quantity: 75,
            productType: 'INTRADAY',
            securityId: '49081',
            price: 100,
          },
        ],
      });
      expect(result.totalMargin).toBe(5000);
      expect(result.insufficientBalance).toBe(false);
    });
  });

  // ── Failure scenarios (Section 17) ────────────────────────────────────────

  describe('Failure scenarios — Section 17', () => {
    it('P0: throws DhanAuthFailureError on HTTP 401 (token expired)', async () => {
      mockFetchError(401);
      await expect(client.getFundLimit()).rejects.toThrow(DhanAuthFailureError);
    });

    it('P0: throws DhanAuthFailureError on HTTP 403 (access denied)', async () => {
      mockFetchError(403);
      await expect(client.getFundLimit()).rejects.toThrow(DhanAuthFailureError);
    });

    it('P0: 401 invalidates token (calls secrets.set)', async () => {
      mockFetchError(401);
      await expect(client.getFundLimit()).rejects.toThrow();
      expect(mockSecrets.set).toHaveBeenCalledWith('DHAN_SESSION_TOKEN', '');
    });

    it('P0: throws on generic HTTP 500 (Dhan API outage)', async () => {
      mockFetchError(500);
      await expect(client.getFundLimit()).rejects.toThrow('Dhan API error: HTTP 500');
    });

    it('P0: throws on HTTP 503 (Dhan service unavailable)', async () => {
      mockFetchError(503);
      await expect(
        client.placeOrder({
          dhanClientId: 'TEST',
          transactionType: 'BUY',
          exchangeSegment: 'NSE_FNO',
          productType: 'INTRADAY',
          orderType: 'MARKET',
          validity: 'DAY',
          securityId: '49081',
          quantity: 75,
        }),
      ).rejects.toThrow();
    });

    it('P2: enqueues request and throws DhanRateLimitQueueFullError when queue is full', async () => {
      // Fill queue with 50 rate-limited requests (each one triggers a 429)
      for (let i = 0; i < 50; i++) {
        mockFetchError(429, '1');
      }
      // These will be queued
      const promises = Array.from({ length: 50 }, () => client.getFundLimit().catch(() => null));
      // 51st request should fail immediately — queue is full
      mockFetchError(429, '1');
      await expect(client.getFundLimit()).rejects.toThrow(DhanRateLimitQueueFullError);
      // Let the queued requests resolve
      await Promise.all(promises);
    });
  });

  // ── Error naming ──────────────────────────────────────────────────────────

  describe('Error class names', () => {
    it('DhanAuthFailureError has correct name', () => {
      const err = new DhanAuthFailureError(401, '/test');
      expect(err.name).toBe('DhanAuthFailureError');
      expect(err.statusCode).toBe(401);
    });

    it('DhanRateLimitQueueFullError has correct name', () => {
      const err = new DhanRateLimitQueueFullError();
      expect(err.name).toBe('DhanRateLimitQueueFullError');
    });
  });
});
