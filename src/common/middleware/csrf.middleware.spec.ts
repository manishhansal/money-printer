/**
 * Unit tests for CsrfMiddleware.
 *
 * Covers:
 *  - Rejects state-modifying requests without a CSRF token in the header
 *  - Rejects state-modifying requests with a mismatched CSRF token
 *  - Allows state-modifying requests with a matching CSRF token
 *  - Passes safe methods (GET, HEAD, OPTIONS) without validation
 *  - Passes WebSocket upgrade requests without validation
 *  - Sets a csrf-token cookie when none is present
 *  - Passes requests to exempt paths without validation
 *
 * Requirements: 16.5
 */

import type { NextFunction, Request, Response } from 'express';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CsrfMiddleware } from './csrf.middleware';

// ── Helpers ────────────────────────────────────────────────────────────────

function buildRequest(
  overrides: Partial<{
    method: string;
    path: string;
    headers: Record<string, string | undefined>;
    upgrade: string;
  }>,
): Request {
  return {
    method: overrides.method ?? 'POST',
    path: overrides.path ?? '/auth/login',
    headers: overrides.headers ?? {},
    ip: '127.0.0.1',
  } as unknown as Request;
}

function buildResponse(): {
  res: Response;
  setCookieSpy: jest.Mock;
  statusSpy: jest.Mock;
  jsonSpy: jest.Mock;
} {
  const jsonSpy = jest.fn().mockReturnThis();
  const statusSpy = jest.fn().mockReturnValue({ json: jsonSpy });
  const setCookieSpy = jest.fn();

  const res = {
    cookie: setCookieSpy,
    status: statusSpy,
    json: jsonSpy,
  } as unknown as Response;

  return { res, setCookieSpy, statusSpy, jsonSpy };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CsrfMiddleware', () => {
  let middleware: CsrfMiddleware;
  let next: jest.Mock<NextFunction>;

  beforeEach(() => {
    middleware = new CsrfMiddleware();
    next = jest.fn();
  });

  // ── Token validation on state-modifying methods ───────────────────────

  describe('POST requests (state-modifying)', () => {
    const TOKEN = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';

    it('should return 403 when the X-CSRF-Token header is missing', () => {
      const req = buildRequest({
        method: 'POST',
        headers: { cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      });
      const { res, statusSpy } = buildResponse();

      middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledWith(403);
    });

    it('should return 403 when the X-CSRF-Token header does not match the cookie', () => {
      const req = buildRequest({
        method: 'POST',
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
          [CSRF_HEADER_NAME]: 'wrong-token-value',
        },
      });
      const { res, statusSpy } = buildResponse();

      middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledWith(403);
    });

    it('should call next() when X-CSRF-Token header matches the cookie', () => {
      const req = buildRequest({
        method: 'POST',
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
          [CSRF_HEADER_NAME]: TOKEN,
        },
      });
      const { res } = buildResponse();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should return 403 with correct error shape when header is missing', () => {
      const req = buildRequest({
        method: 'POST',
        headers: { cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      });
      const { res, statusSpy, jsonSpy } = buildResponse();

      middleware.use(req, res, next);

      expect(statusSpy).toHaveBeenCalledWith(403);
      expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });
  });

  describe('PUT / PATCH / DELETE requests (state-modifying)', () => {
    const TOKEN = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

    it.each(['PUT', 'PATCH', 'DELETE'])('should reject %s request without CSRF token', (method) => {
      const req = buildRequest({
        method,
        headers: { cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
      });
      const { res, statusSpy } = buildResponse();

      middleware.use(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledWith(403);
    });

    it.each(['PUT', 'PATCH', 'DELETE'])(
      'should allow %s request with matching CSRF token',
      (method) => {
        const req = buildRequest({
          method,
          headers: {
            cookie: `${CSRF_COOKIE_NAME}=${TOKEN}`,
            [CSRF_HEADER_NAME]: TOKEN,
          },
        });
        const { res } = buildResponse();

        middleware.use(req, res, next);

        expect(next).toHaveBeenCalled();
      },
    );
  });

  // ── Safe HTTP methods ─────────────────────────────────────────────────

  describe('safe HTTP methods', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])(
      'should call next() for %s without requiring a CSRF token',
      (method) => {
        const req = buildRequest({ method, headers: { cookie: '' } });
        const { res } = buildResponse();

        middleware.use(req, res, next);

        expect(next).toHaveBeenCalled();
      },
    );
  });

  // ── WebSocket upgrade ─────────────────────────────────────────────────

  describe('WebSocket upgrade requests', () => {
    it('should skip CSRF validation for Upgrade: websocket requests', () => {
      const req = buildRequest({
        method: 'GET',
        headers: { upgrade: 'websocket', cookie: '' },
      });
      const { res } = buildResponse();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  // ── Exempt paths ─────────────────────────────────────────────────────

  describe('exempt paths', () => {
    const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    it.each(['/health', '/health/live', '/metrics'])(
      'should skip CSRF validation for %s (even for POST)',
      (path) => {
        const req = buildRequest({
          method: 'POST',
          path,
          headers: { cookie: `${CSRF_COOKIE_NAME}=${TOKEN}` },
          // No X-CSRF-Token header — should still pass
        });
        const { res } = buildResponse();

        middleware.use(req, res, next);

        expect(next).toHaveBeenCalled();
      },
    );
  });

  // ── CSRF cookie issuance ──────────────────────────────────────────────

  describe('CSRF cookie issuance', () => {
    it('should set a csrf-token cookie when none exists (GET request)', () => {
      const req = buildRequest({ method: 'GET', headers: { cookie: '' } });
      const { res, setCookieSpy } = buildResponse();

      middleware.use(req, res, next);

      expect(setCookieSpy).toHaveBeenCalledWith(
        CSRF_COOKIE_NAME,
        expect.any(String),
        expect.objectContaining({ httpOnly: false }),
      );
    });

    it('should not override an existing csrf-token cookie', () => {
      const existingToken = 'existing-token-value';
      const req = buildRequest({
        method: 'GET',
        headers: { cookie: `${CSRF_COOKIE_NAME}=${existingToken}` },
      });
      const { res, setCookieSpy } = buildResponse();

      middleware.use(req, res, next);

      expect(setCookieSpy).not.toHaveBeenCalled();
    });

    it('should generate a hexadecimal csrf-token of 64 characters (256-bit)', () => {
      const req = buildRequest({ method: 'GET', headers: {} });
      const { res, setCookieSpy } = buildResponse();

      middleware.use(req, res, next);

      const [, tokenValue] = setCookieSpy.mock.calls[0] as [string, string, object];
      expect(tokenValue).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── parseCookies ──────────────────────────────────────────────────────

  describe('parseCookies()', () => {
    it('should parse a single cookie', () => {
      const result = middleware.parseCookies('foo=bar');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('should parse multiple cookies', () => {
      const result = middleware.parseCookies('foo=bar; baz=qux; csrf-token=abc');
      expect(result).toEqual({ foo: 'bar', baz: 'qux', 'csrf-token': 'abc' });
    });

    it('should decode URI-encoded cookie values', () => {
      const result = middleware.parseCookies('foo=hello%20world');
      expect(result['foo']).toBe('hello world');
    });

    it('should handle an empty cookie header', () => {
      expect(middleware.parseCookies('')).toEqual({});
    });

    it('should handle cookie values that contain equals signs', () => {
      const result = middleware.parseCookies('jwt=a.b.c=d');
      expect(result['jwt']).toBe('a.b.c=d');
    });
  });
});
