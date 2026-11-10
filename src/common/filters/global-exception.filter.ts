/**
 * global-exception.filter.ts
 *
 * GlobalExceptionFilter — NestJS catch-all exception filter that intercepts
 * every unhandled exception reaching the HTTP layer, reports it to the
 * SystemHealthMonitorService, persists it in the TradeJournal, and returns
 * a sanitised HTTP response to the client.
 *
 * Responsibilities:
 *  1. Catch all unhandled exceptions (HTTP and non-HTTP alike).
 *  2. For non-HttpException errors (unexpected runtime failures):
 *       - Call SystemHealthMonitorService.updateMetricStatus(
 *             'cloudengine_modules', 'Degraded', error.message
 *         ) so the health dashboard reflects the degradation immediately.
 *       - Call TradeJournalService.recordSystemError() with an
 *         UNHANDLED_EXCEPTION + CRITICAL entry so the event is permanently
 *         auditable in the system_health_events table.
 *  3. Return a well-formed JSON error response with the appropriate HTTP
 *     status code (preserves the original status for HttpExceptions,
 *     falls back to 500 for unexpected errors).
 *
 * Both service dependencies are @Optional() so the filter degrades gracefully
 * in environments where the services have not been registered (e.g. isolated
 * route-level tests).
 *
 * Requirements: 13.1, 10.1, 2.7
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Response } from 'express';

import { SystemHealthMonitorService } from '../../modules/system-health-monitor/system-health-monitor.service';
import { TradeJournalService } from '../../modules/trade-journal/trade-journal.service';
import { SystemErrorDto } from '../../modules/trade-journal/dto/system-error.dto';

/** @Catch() with no arguments catches every exception type. */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(
    @Optional()
    private readonly systemHealthMonitorService: SystemHealthMonitorService | null,
    @Optional()
    private readonly tradeJournalService: TradeJournalService | null,
  ) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // Normalise to an Error object for consistent downstream handling.
    const error = exception instanceof Error ? exception : new Error(String(exception));

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    this.logger.error(`Unhandled exception [${status}]: ${error.message}`, error.stack);

    // ── Health + journal reporting ─────────────────────────────────────────
    // Only report unexpected (non-HTTP) errors or server-side HTTP 5xx errors
    // as infrastructure degradation. 4xx errors are intentional client errors
    // and do not indicate module health problems.
    if (!isHttpException || status >= 500) {
      // Update CloudEngine health metric immediately.
      if (this.systemHealthMonitorService) {
        await this.systemHealthMonitorService
          .updateMetricStatus('cloudengine_modules', 'Degraded', error.message)
          .catch((err: Error) =>
            this.logger.error(
              `[GlobalExceptionFilter] Failed to update health metric: ${err.message}`,
            ),
          );
      }

      // Persist as a system error in the TradeJournal.
      if (this.tradeJournalService) {
        const dto = new SystemErrorDto();
        dto.eventType = 'UNHANDLED_EXCEPTION';
        dto.moduleName = 'GlobalExceptionFilter';
        dto.severity = 'CRITICAL';
        dto.message = error.message;
        dto.metadata = {
          stack: error.stack ?? null,
          httpStatus: status,
        };
        dto.timestamp = new Date();

        await this.tradeJournalService
          .recordSystemError(dto)
          .catch((err: Error) =>
            this.logger.error(
              `[GlobalExceptionFilter] Failed to record system error: ${err.message}`,
            ),
          );
      }
    }

    // ── HTTP response ─────────────────────────────────────────────────────
    const message =
      status === HttpStatus.INTERNAL_SERVER_ERROR
        ? 'Internal server error'
        : isHttpException
          ? ((exception.getResponse() as { message?: string })?.message ?? exception.message)
          : error.message;

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
