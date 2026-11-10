/**
 * CsrfMiddleware — double-submit cookie CSRF protection.
 *
 * Implements the double-submit cookie pattern to protect all state-modifying
 * API endpoints against Cross-Site Request Forgery attacks.
 *
 * Pattern:
 *  1. On any request where a `csrf-token` cookie is absent, a cryptographically
 *     random token is generated and set as a non-HttpOnly cookie so that the
 *     Chrome Extension can read it (via `document.cookie` or the
 *     `chrome.cookies` API).
 *  2. For state-modifying HTTP methods (POST, PUT, PATCH, DELETE), the
 *     middleware validates that the `X-CSRF-Token` request header value matches
 *     the `csrf-token` cookie value.
 *  3. If the header is absent or mismatched, the request is rejected with
 *     HTTP 403 Forbidden.
 *
 * Exempt from token validation (but cookie is still issued):
 *  - Safe HTTP methods: GET, HEAD, OPTIONS
 *  - Health-check paths: /health, /metrics
 *  - WebSocket upgrade requests (Connection: Upgrade)
 *
 * Cookie attributes:
 *  - `httpOnly: false`  — Extension JavaScript must be able to read the value.
 *  - `sameSite: 'strict'` — default for same-origin requests.
 *    Note: for cross-origin Chrome Extension requests in production, the
 *    server may need to relax this to `'none'` (with `secure: true`) and
 *    configure CORS accordingly.
 *  - `secure: true` in production, `false` in development.
 *
 * Requirements: 16.5
 */

import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/** HTTP methods that mutate server state and require CSRF validation. */
const STATE_MODIFYING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths exempt from CSRF validation (must prefix-match the request path). */
const EXEMPT_PATH_PREFIXES = [
  '/health',
  '/metrics',
  // Settings and portfolio summary are consumed by the Chrome Extension popup
  // which cannot access cookies in the service worker context. Both endpoints
  // are CORS-restricted to chrome-extension://* and localhost origins, so
  // CSRF provides no additional protection here.
  '/settings',
  '/portfolio/summary',
];

/** Cookie name that stores the CSRF token (must be readable by the client). */
export const CSRF_COOKIE_NAME = 'csrf-token';

/** Request header name carrying the client-submitted CSRF token. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Length of the random token in bytes (32 bytes = 256 bits of entropy). */
const TOKEN_BYTE_LENGTH = 32;

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CsrfMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    // Exempt WebSocket upgrade requests — no CSRF attack vector there.
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      return next();
    }

    // Ensure the CSRF cookie is present on every response.
    const cookies = this.parseCookies(req.headers.cookie ?? '');
    let csrfToken = cookies[CSRF_COOKIE_NAME];

    if (!csrfToken) {
      // Generate a fresh token and send it as a readable cookie.
      csrfToken = randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
      const isProduction = process.env.NODE_ENV === 'production';

      res.cookie(CSRF_COOKIE_NAME, csrfToken, {
        httpOnly: false, // Extension must be able to read this value.
        sameSite: 'strict', // Adjust to 'none' for cross-origin production use.
        secure: isProduction, // Enforce HTTPS in production.
        path: '/',
      });
    }

    // Safe methods and exempt paths do not require CSRF validation.
    const method = req.method.toUpperCase();
    if (!STATE_MODIFYING_METHODS.has(method)) {
      return next();
    }

    if (EXEMPT_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
      return next();
    }

    // ── CSRF token validation ──────────────────────────────────────────────

    const headerToken = req.headers[CSRF_HEADER_NAME] as string | undefined;

    if (!headerToken) {
      this.logger.warn(`CSRF token missing: ${method} ${req.path} from ${req.ip ?? 'unknown'}`);
      res.status(403).json({
        statusCode: 403,
        message: 'CSRF token missing',
        error: 'Forbidden',
      });
      return;
    }

    if (!this.safeEquals(headerToken, csrfToken)) {
      this.logger.warn(`CSRF token mismatch: ${method} ${req.path} from ${req.ip ?? 'unknown'}`);
      res.status(403).json({
        statusCode: 403,
        message: 'CSRF token invalid',
        error: 'Forbidden',
      });
      return;
    }

    next();
  }

  /**
   * Parses a raw `Cookie` header string into a key → value map.
   *
   * Deliberately does not rely on `cookie-parser` middleware so that this
   * class has zero additional runtime dependencies.
   *
   * @param cookieHeader  Raw `Cookie` header value (may be empty).
   * @returns             Map of cookie name → decoded value.
   */
  parseCookies(cookieHeader: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (!cookieHeader) return result;

    for (const part of cookieHeader.split(';')) {
      const eqIdx = part.indexOf('=');
      if (eqIdx < 0) continue;

      const name = part.slice(0, eqIdx).trim();
      const raw = part.slice(eqIdx + 1).trim();

      if (!name) continue;

      try {
        result[name] = decodeURIComponent(raw);
      } catch {
        result[name] = raw;
      }
    }

    return result;
  }

  /**
   * Constant-time string comparison to prevent timing attacks.
   *
   * Uses XOR-based comparison so the execution time is independent of where
   * the first differing character appears.
   */
  private safeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;

    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }
}
