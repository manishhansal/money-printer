/**
 * dhan-api.client.spec.ts
 *
 * Unit tests for DhanApiClient.
 *
 * Tests cover (per task 5.1 requirements):
 *  1. placeOrder sends correct headers including `access-token`.
 *  2. On HTTP 401 response, returns DhanAuthFailureError without retry.
 *  3. Rate-limit queue handles < 50 requests correctly.
 *  4. Rate-limit queue returns DhanRateLimitQueueFullError when at 50 requests.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.7
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DhanApiClient } from './dhan-api.client';
import {
  DhanAuthFailureError,
  DhanOrderRequest,
  DhanOrderResponse,
  DhanRateLimitQueueFullError,
} from './dhan-api.types';
import { SecretsService } from '../secrets/secrets.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object that globalThis.fetch will return. */
function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const responseHeaders = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: responseHeaders,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** A minimal DhanOrderRequest fixture. */
function makeOrderRequest(): DhanOrderRequest {
  return {
    dhanClientId: 'TEST_CLIENT',
    transactionType: 'BUY',
    exchangeSegment: 'NSE_FNO',
    productType: 'INTRADAY',
    orderType: 'LIMIT',
    validity: 'DAY',
    securityId: '49081',
    quantity: 1,
    price: 100,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('DhanApiClient', () => {
  let client: DhanApiClient;
  let fetchSpy: jest.SpyInstance;

  const mockSecretsService = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockConfigService = {
    get: jest.fn((_key: string, defaultVal?: string) => defaultVal ?? 'https://api.dhan.co'),
    getOrThrow: jest.fn((_key: string) => 'https://api.dhan.co'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default secrets mock
    mockSecretsService.get.mockImplementation((key: string) => {
      if (key === 'DHAN_SESSION_TOKEN') return Promise.resolve('test-jwt-token');
      if (key === 'DHAN_CLIENT_ID') return Promise.resolve('1000000001');
      return Promise.reject(new Error(`Unknown secret key: ${key}`));
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DhanApiClient,
        { provide: SecretsService, useValue: mockSecretsService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    client = module.get<DhanApiClient>(DhanApiClient);

    // Spy on the global fetch — available in Node 18+.
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    // Clean up any pending timers so Jest exits cleanly.
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. placeOrder sends correct headers
  // -------------------------------------------------------------------------

  describe('placeOrder', () => {
    it('sends Content-Type: application/json header', async () => {
      const successBody: DhanOrderResponse = {
        orderId: 'ORDER123',
        orderStatus: 'PENDING',
      };
      fetchSpy.mockResolvedValueOnce(makeResponse(200, successBody));

      await client.placeOrder(makeOrderRequest());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('sends access-token header with value from SecretsService', async () => {
      const successBody: DhanOrderResponse = {
        orderId: 'ORDER123',
        orderStatus: 'PENDING',
      };
      fetchSpy.mockResolvedValueOnce(makeResponse(200, successBody));

      await client.placeOrder(makeOrderRequest());

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['access-token']).toBe('test-jwt-token');
    });

    it('calls POST /v2/orders', async () => {
      const successBody: DhanOrderResponse = {
        orderId: 'ORDER456',
        orderStatus: 'PENDING',
      };
      fetchSpy.mockResolvedValueOnce(makeResponse(200, successBody));

      await client.placeOrder(makeOrderRequest());

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.dhan.co/v2/orders');
    });

    it('returns the order response on success', async () => {
      const successBody: DhanOrderResponse = {
        orderId: 'ORDER789',
        orderStatus: 'PENDING',
      };
      fetchSpy.mockResolvedValueOnce(makeResponse(200, successBody));

      const result = await client.placeOrder(makeOrderRequest());

      expect(result).toEqual(successBody);
    });

    it('fetches the session token from SecretsService on every call', async () => {
      const successBody: DhanOrderResponse = {
        orderId: 'ORDER999',
        orderStatus: 'PENDING',
      };
      fetchSpy.mockResolvedValue(makeResponse(200, successBody));

      await client.placeOrder(makeOrderRequest());
      await client.placeOrder(makeOrderRequest());

      // get('DHAN_SESSION_TOKEN') must be called twice — no local caching.
      const tokenCalls = mockSecretsService.get.mock.calls.filter(
        (c: string[]) => c[0] === 'DHAN_SESSION_TOKEN',
      );
      expect(tokenCalls.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 2. HTTP 401 → DhanAuthFailureError, no retry
  // -------------------------------------------------------------------------

  describe('HTTP 401 / 403 handling', () => {
    it('throws DhanAuthFailureError on HTTP 401', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse(401, { errorType: 'AUTH', errorCode: '401', errorMessage: 'Unauthorized' }),
      );

      await expect(client.placeOrder(makeOrderRequest())).rejects.toBeInstanceOf(
        DhanAuthFailureError,
      );
    });

    it('throws DhanAuthFailureError on HTTP 403', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse(403, { errorType: 'AUTH', errorCode: '403', errorMessage: 'Forbidden' }),
      );

      await expect(client.placeOrder(makeOrderRequest())).rejects.toBeInstanceOf(
        DhanAuthFailureError,
      );
    });

    it('does NOT retry after HTTP 401 — fetch is called exactly once', async () => {
      fetchSpy.mockResolvedValue(
        makeResponse(401, { errorType: 'AUTH', errorCode: '401', errorMessage: 'Unauthorized' }),
      );

      await expect(client.placeOrder(makeOrderRequest())).rejects.toBeInstanceOf(
        DhanAuthFailureError,
      );

      // Even though fetchSpy would return 401 every time, it must be called
      // exactly once — no silent retry loop.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('invalidates DHAN_SESSION_TOKEN via SecretsService on HTTP 401', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse(401, { errorType: 'AUTH', errorCode: '401', errorMessage: 'Unauthorized' }),
      );

      await expect(client.placeOrder(makeOrderRequest())).rejects.toBeInstanceOf(
        DhanAuthFailureError,
      );

      expect(mockSecretsService.set).toHaveBeenCalledWith('DHAN_SESSION_TOKEN', '');
    });

    it('includes the endpoint path in the error', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse(401, { errorType: 'AUTH', errorCode: '401', errorMessage: 'Unauthorized' }),
      );

      try {
        await client.placeOrder(makeOrderRequest());
        fail('Expected DhanAuthFailureError to be thrown');
      } catch (err) {
        const authErr = err as DhanAuthFailureError;
        expect(authErr.statusCode).toBe(401);
        expect(authErr.endpoint).toContain('/v2/orders');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Rate-limit queue — < 50 requests are queued and retried
  // -------------------------------------------------------------------------

  describe('rate-limit queue (< 50 requests)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('queues a request when 429 is returned and resolves it after retry window', async () => {
      const successBody: DhanOrderResponse = {
        orderId: 'QUEUED_ORDER',
        orderStatus: 'PENDING',
      };

      // First call → 429 with Retry-After: 1
      fetchSpy.mockResolvedValueOnce(makeResponse(429, {}, { 'Retry-After': '1' }));
      // Second call (after timer fires) → 200
      fetchSpy.mockResolvedValueOnce(makeResponse(200, successBody));

      const promise = client.placeOrder(makeOrderRequest());

      // runAllTimersAsync advances fake timers AND awaits async timer callbacks.
      await jest.runAllTimersAsync();

      const result = await promise;
      expect(result).toEqual(successBody);
    });

    it('makes exactly 2 fetch calls — original + retry', async () => {
      const successBody: DhanOrderResponse = {
        orderId: 'QUEUED_ORDER2',
        orderStatus: 'PENDING',
      };

      fetchSpy.mockResolvedValueOnce(makeResponse(429, {}, { 'Retry-After': '1' }));
      fetchSpy.mockResolvedValueOnce(makeResponse(200, successBody));

      const promise = client.placeOrder(makeOrderRequest());
      await jest.runAllTimersAsync();
      await promise;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('queues multiple requests below the 50-entry limit', async () => {
      const successBody: DhanOrderResponse = {
        orderId: 'MULTI',
        orderStatus: 'PENDING',
      };

      // Simulate 3 concurrent 429s then 3 successes on retry.
      fetchSpy
        .mockResolvedValueOnce(makeResponse(429, {}, { 'Retry-After': '1' }))
        .mockResolvedValueOnce(makeResponse(429, {}, { 'Retry-After': '1' }))
        .mockResolvedValueOnce(makeResponse(429, {}, { 'Retry-After': '1' }))
        .mockResolvedValue(makeResponse(200, successBody));

      const p1 = client.placeOrder(makeOrderRequest());
      const p2 = client.placeOrder(makeOrderRequest());
      const p3 = client.placeOrder(makeOrderRequest());

      await jest.runAllTimersAsync();

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toEqual(successBody);
      expect(r2).toEqual(successBody);
      expect(r3).toEqual(successBody);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Rate-limit queue full — throws DhanRateLimitQueueFullError at 50
  // -------------------------------------------------------------------------

  describe('rate-limit queue full (50 requests)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('throws DhanRateLimitQueueFullError when 51st request arrives and queue is full', async () => {
      // Every call returns 429 so requests pile up in the queue.
      fetchSpy.mockResolvedValue(makeResponse(429, {}, { 'Retry-After': '60' }));

      // Fill the queue with exactly 50 requests (each will be queued, not resolved).
      const promises: Promise<DhanOrderResponse>[] = [];
      for (let i = 0; i < 50; i++) {
        // We don't await — we want them all queued simultaneously.
        promises.push(client.placeOrder(makeOrderRequest()));
      }

      // The 51st request must throw DhanRateLimitQueueFullError.
      await expect(client.placeOrder(makeOrderRequest())).rejects.toBeInstanceOf(
        DhanRateLimitQueueFullError,
      );

      // Clean up: mock success and drain the queue so Jest exits cleanly.
      fetchSpy.mockResolvedValue(makeResponse(200, { orderId: 'CLEANUP', orderStatus: 'PENDING' }));
      await jest.runAllTimersAsync();
      await Promise.allSettled(promises);
    });

    it('error name is DhanRateLimitQueueFullError', async () => {
      fetchSpy.mockResolvedValue(makeResponse(429, {}, { 'Retry-After': '60' }));

      const promises: Promise<DhanOrderResponse>[] = [];
      for (let i = 0; i < 50; i++) {
        promises.push(client.placeOrder(makeOrderRequest()));
      }

      try {
        await client.placeOrder(makeOrderRequest());
        fail('Expected DhanRateLimitQueueFullError');
      } catch (err) {
        expect((err as Error).name).toBe('DhanRateLimitQueueFullError');
      }

      fetchSpy.mockResolvedValue(makeResponse(200, { orderId: 'CLEANUP', orderStatus: 'PENDING' }));
      await jest.runAllTimersAsync();
      await Promise.allSettled(promises);
    });
  });
});
