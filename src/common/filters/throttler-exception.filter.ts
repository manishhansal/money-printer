/**
 * ThrottlerExceptionFilter — NestJS exception filter for HTTP 429 responses.
 *
 * Intercepts `ThrottlerException` thrown by the `ThrottleByUserGuard` and
 * returns a well-formed HTTP 429 Too Many Requests response that includes a
 * `Retry-After` header whose value is a strictly positive integer (> 0),
 * as required by requirement 16.4.
 *
 * Header value precedence:
 *  1. If the guard already set `Retry-After` on the response object, read
 *     that value (it was computed from the actual block-expiry time).
 *  2. Fall back to 1 second when the header is missing or ≤ 0.
 *
 * Requirements: 16.4
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';

/** Minimum allowed value for the Retry-After header (strictly positive). */
const MIN_RETRY_AFTER_SECONDS = 1;

@Catch(ThrottlerException)
export class ThrottlerExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ThrottlerExceptionFilter.name);

  catch(_exception: ThrottlerException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // The guard sets Retry-After before throwing; retrieve it.
    const rawHeader = response.getHeader('Retry-After');
    const parsed = Number(rawHeader);

    // Clamp to a strictly positive integer — requirement 16.4.
    const retryAfterSeconds =
      Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : MIN_RETRY_AFTER_SECONDS;

    this.logger.debug(`Rate limit exceeded — Retry-After: ${retryAfterSeconds}s`);

    response
      .status(HttpStatus.TOO_MANY_REQUESTS)
      .setHeader('Retry-After', String(retryAfterSeconds))
      .json({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too Many Requests',
        retryAfter: retryAfterSeconds,
      });
  }
}
