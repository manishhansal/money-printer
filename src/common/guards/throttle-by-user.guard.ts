/**
 * ThrottleByUserGuard — per-authenticated-client rate-limiting guard.
 *
 * Extends the default NestJS ThrottlerGuard with two key behaviours:
 *
 *  1. Tracker key: extracts the authenticated user ID (`sub` claim) from
 *     the JWT in the Authorization header.  Because this guard runs at the
 *     global level (before Passport populates `req.user`), the JWT is decoded
 *     without re-verification here — the structural check is sufficient to
 *     derive the client identity for bucket keying.  Full cryptographic
 *     validation still occurs in JwtAuthGuard on protected routes.
 *     Falls back to IP address for unauthenticated requests (e.g. /auth/login).
 *
 *  2. Strictly-positive Retry-After: overrides `throwThrottlingException` to
 *     guarantee the Retry-After response header is always ≥ 1 second, as
 *     required by requirement 16.4 ("strictly positive integer, greater than 0").
 *
 * Requirements: 16.3, 16.4
 */

import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';

@Injectable()
export class ThrottleByUserGuard extends ThrottlerGuard {
  /**
   * Derives the rate-limit bucket key for the incoming request.
   *
   * Priority:
   *  1. `sub` claim from the JWT Bearer token (authenticated client ID)
   *  2. Client IP address (unauthenticated requests)
   *  3. `'anonymous'` fallback (no IP information available)
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    try {
      const authHeader: string | undefined = req.headers?.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const parts = token.split('.');
        if (parts.length === 3) {
          // Decode the payload segment (base64url → JSON) without verification.
          // This is intentionally lightweight — full RS256 verification happens
          // in JwtAuthGuard on every protected route.
          const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
          const payload: unknown = JSON.parse(payloadJson);
          if (
            payload !== null &&
            typeof payload === 'object' &&
            'sub' in payload &&
            typeof (payload as Record<string, unknown>).sub === 'string'
          ) {
            return (payload as { sub: string }).sub;
          }
        }
      }
    } catch {
      // Malformed token — fall through to IP-based tracking.
    }

    return (req.ip as string | undefined) ?? 'anonymous';
  }

  /**
   * Overrides the default implementation to guarantee `Retry-After` is a
   * strictly positive integer (> 0), satisfying requirement 16.4.
   *
   * The base guard sets `Retry-After: timeToBlockExpire` before calling this
   * method, but `timeToBlockExpire` can theoretically be 0 if the block
   * window is expiring at the exact same millisecond.  We clamp to at least 1.
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context);

    // Clamp to strictly positive integer — requirement 16.4.
    const retryAfter = Math.max(1, Math.ceil(throttlerLimitDetail.timeToBlockExpire));
    this.setResponseHeader(res, 'Retry-After', retryAfter);

    throw new ThrottlerException();
  }
}
