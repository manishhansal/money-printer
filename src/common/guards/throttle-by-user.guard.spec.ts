/**
 * Unit tests for ThrottleByUserGuard.
 *
 * Covers:
 *  - getTracker() extracts the sub claim from a valid JWT Bearer token
 *  - getTracker() falls back to IP address when no valid JWT is present
 *  - throwThrottlingException() sets Retry-After to a strictly positive integer (≥ 1)
 *  - throwThrottlingException() enforces Math.max(1, ...) when timeToBlockExpire is 0
 *
 * Requirements: 16.3, 16.4
 */

import { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { ThrottleByUserGuard } from './throttle-by-user.guard';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Builds a minimal base64url-encoded JWT with the given payload.
 * No real signature — only structural validity matters for the tracker.
 */
function buildFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesignature`;
}

// ── Guard factory ──────────────────────────────────────────────────────────

function createGuard(): ThrottleByUserGuard {
  // Minimal stub: only options, storageService, and reflector are needed
  // by the base ThrottlerGuard constructor.
  const options = [{ name: 'default', ttl: 60_000, limit: 100 }];
  const storageService = {
    increment: jest.fn().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
  };
  const reflector = new Reflector();

  return new ThrottleByUserGuard(options as any, storageService as any, reflector);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ThrottleByUserGuard', () => {
  let guard: ThrottleByUserGuard;

  beforeEach(() => {
    guard = createGuard();
  });

  // ── getTracker ────────────────────────────────────────────────────────

  describe('getTracker()', () => {
    it('should return the sub claim from a valid Bearer JWT', async () => {
      const jwt = buildFakeJwt({ sub: 'user-123', exp: 9999999999 });
      const req = {
        headers: { authorization: `Bearer ${jwt}` },
        ip: '10.0.0.1',
      };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('user-123');
    });

    it('should fall back to IP when no Authorization header is present', async () => {
      const req = { headers: {}, ip: '192.168.1.1' };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('192.168.1.1');
    });

    it('should fall back to IP when the Bearer token is malformed', async () => {
      const req = {
        headers: { authorization: 'Bearer not.a.valid.jwt.here' },
        ip: '10.0.0.2',
      };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('10.0.0.2');
    });

    it('should fall back to IP when the JWT payload has no sub claim', async () => {
      const jwt = buildFakeJwt({ clientId: 'client-abc' });
      const req = {
        headers: { authorization: `Bearer ${jwt}` },
        ip: '10.0.0.3',
      };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('10.0.0.3');
    });

    it('should return "anonymous" when there is no IP and no JWT', async () => {
      const req = { headers: {}, ip: undefined };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('anonymous');
    });

    it('should not use Authorization header that does not start with "Bearer "', async () => {
      const jwt = buildFakeJwt({ sub: 'user-xyz' });
      const req = {
        headers: { authorization: `Basic ${jwt}` },
        ip: '10.0.0.4',
      };

      const tracker = await (guard as any).getTracker(req);

      expect(tracker).toBe('10.0.0.4');
    });
  });

  // ── throwThrottlingException ──────────────────────────────────────────

  describe('throwThrottlingException()', () => {
    /**
     * Builds a minimal ExecutionContext stub backed by a mocked Express response.
     */
    function buildContext(existingRetryAfter?: number): {
      context: ExecutionContext;
      mockResponse: Record<string, jest.Mock>;
    } {
      const headers: Record<string, string | number> = {};
      const mockResponse = {
        header: jest.fn((name: string, value: string | number) => {
          headers[name.toLowerCase()] = value;
        }),
        setHeader: jest.fn((name: string, value: string | number) => {
          headers[name.toLowerCase()] = value;
        }),
        getHeader: jest.fn((name: string) => headers[name.toLowerCase()]),
      };

      if (existingRetryAfter !== undefined) {
        headers['retry-after'] = existingRetryAfter;
      }

      const context = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: {}, ip: '127.0.0.1' }),
          getResponse: () => mockResponse,
        }),
        getClass: () => ({ name: 'TestController' }),
        getHandler: () => ({ name: 'testHandler' }),
      } as unknown as ExecutionContext;

      return { context, mockResponse };
    }

    it('should throw ThrottlerException', async () => {
      const { context } = buildContext();
      const detail: ThrottlerLimitDetail = {
        totalHits: 101,
        timeToExpire: 60,
        isBlocked: true,
        timeToBlockExpire: 45,
        ttl: 60_000,
        limit: 100,
        key: 'test-key',
        tracker: 'user-123',
      };

      await expect((guard as any).throwThrottlingException(context, detail)).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('should set Retry-After to the clamped timeToBlockExpire value', async () => {
      const { context, mockResponse } = buildContext();
      const detail: ThrottlerLimitDetail = {
        totalHits: 101,
        timeToExpire: 60,
        isBlocked: true,
        timeToBlockExpire: 30,
        ttl: 60_000,
        limit: 100,
        key: 'test-key',
        tracker: 'user-123',
      };

      try {
        await (guard as any).throwThrottlingException(context, detail);
      } catch {
        // expected ThrottlerException
      }

      // The guard sets the header via setResponseHeader (header or setHeader)
      const setHeader = mockResponse.header.mock.calls.find(
        ([name]: string[]) => name.toLowerCase() === 'retry-after',
      );
      const retryAfter = Number(setHeader?.[1]);

      expect(retryAfter).toBeGreaterThan(0);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBe(30);
    });

    it('should clamp Retry-After to 1 when timeToBlockExpire is 0', async () => {
      const { context, mockResponse } = buildContext();
      const detail: ThrottlerLimitDetail = {
        totalHits: 101,
        timeToExpire: 60,
        isBlocked: true,
        timeToBlockExpire: 0, // edge case — exactly at expiry
        ttl: 60_000,
        limit: 100,
        key: 'test-key',
        tracker: 'user-123',
      };

      try {
        await (guard as any).throwThrottlingException(context, detail);
      } catch {
        // expected ThrottlerException
      }

      const setHeader = mockResponse.header.mock.calls.find(
        ([name]: string[]) => name.toLowerCase() === 'retry-after',
      );
      const retryAfter = Number(setHeader?.[1]);

      // Must be strictly positive — requirement 16.4
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBe(1);
    });

    it('should clamp Retry-After to 1 when timeToBlockExpire is negative', async () => {
      const { context, mockResponse } = buildContext();
      const detail: ThrottlerLimitDetail = {
        totalHits: 101,
        timeToExpire: 60,
        isBlocked: true,
        timeToBlockExpire: -5, // storage race condition edge case
        ttl: 60_000,
        limit: 100,
        key: 'test-key',
        tracker: 'user-123',
      };

      try {
        await (guard as any).throwThrottlingException(context, detail);
      } catch {
        // expected ThrottlerException
      }

      const setHeader = mockResponse.header.mock.calls.find(
        ([name]: string[]) => name.toLowerCase() === 'retry-after',
      );
      const retryAfter = Number(setHeader?.[1]);

      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBe(1);
    });
  });
});

// ── ThrottlerExceptionFilter ───────────────────────────────────────────────

import { ThrottlerExceptionFilter } from '../filters/throttler-exception.filter';

describe('ThrottlerExceptionFilter', () => {
  let filter: ThrottlerExceptionFilter;

  beforeEach(() => {
    filter = new ThrottlerExceptionFilter();
  });

  function buildHost(existingRetryAfterHeader?: number | string): {
    host: any;
    mockResponse: Record<string, jest.Mock>;
  } {
    const headers: Record<string, string | number> = {};
    if (existingRetryAfterHeader !== undefined) {
      headers['retry-after'] = existingRetryAfterHeader;
    }

    const mockResponse = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      getHeader: jest.fn((name: string) => headers[name.toLowerCase()]),
    };

    const host = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => ({ method: 'POST', path: '/auth/login', ip: '127.0.0.1' }),
      }),
    };

    return { host, mockResponse };
  }

  it('should respond with HTTP 429 status code', () => {
    const { host, mockResponse } = buildHost(30);
    const exception = new ThrottlerException();

    filter.catch(exception, host as any);

    expect(mockResponse.status).toHaveBeenCalledWith(429);
  });

  it('should include a Retry-After header that is a strictly positive integer', () => {
    const { host, mockResponse } = buildHost(45);
    const exception = new ThrottlerException();

    filter.catch(exception, host as any);

    const retryAfterCall = mockResponse.setHeader.mock.calls.find(
      ([name]: string[]) => name.toLowerCase() === 'retry-after',
    );
    const retryAfter = Number(retryAfterCall?.[1]);

    expect(retryAfter).toBeGreaterThan(0);
    expect(Number.isInteger(retryAfter)).toBe(true);
  });

  it('should preserve a positive Retry-After already set by the guard', () => {
    const { host, mockResponse } = buildHost(42);
    const exception = new ThrottlerException();

    filter.catch(exception, host as any);

    const retryAfterCall = mockResponse.setHeader.mock.calls.find(
      ([name]: string[]) => name.toLowerCase() === 'retry-after',
    );
    expect(Number(retryAfterCall?.[1])).toBe(42);
  });

  it('should return Retry-After of 1 when the guard-set header is 0', () => {
    const { host, mockResponse } = buildHost(0);
    const exception = new ThrottlerException();

    filter.catch(exception, host as any);

    const retryAfterCall = mockResponse.setHeader.mock.calls.find(
      ([name]: string[]) => name.toLowerCase() === 'retry-after',
    );
    const retryAfter = Number(retryAfterCall?.[1]);

    // Must be > 0 — requirement 16.4
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBe(1);
  });

  it('should return Retry-After of 1 when no header is set', () => {
    const { host, mockResponse } = buildHost(undefined);
    const exception = new ThrottlerException();

    filter.catch(exception, host as any);

    const retryAfterCall = mockResponse.setHeader.mock.calls.find(
      ([name]: string[]) => name.toLowerCase() === 'retry-after',
    );
    const retryAfter = Number(retryAfterCall?.[1]);

    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBe(1);
  });

  it('should include retryAfter in the JSON body matching the header value', () => {
    const { host, mockResponse } = buildHost(20);
    const exception = new ThrottlerException();

    filter.catch(exception, host as any);

    const jsonBody = mockResponse.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(jsonBody.statusCode).toBe(429);
    expect(jsonBody.retryAfter).toBe(20);
    expect(typeof jsonBody.retryAfter).toBe('number');
    expect(jsonBody.retryAfter as number).toBeGreaterThan(0);
  });
});
