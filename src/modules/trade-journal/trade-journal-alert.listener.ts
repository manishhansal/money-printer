/**
 * TradeJournalAlertListener — forwards JOURNAL_WRITE_FAILED_EVENT to the
 * NotificationService as a CRITICAL-priority operator alert.
 *
 * Design notes:
 *  - NotificationService is injected with @Optional() so the TradeJournalModule
 *    continues to function (with a degraded-alert-path warning) even if the
 *    NotificationModule is unavailable — e.g., in reduced-scope test harnesses.
 *  - The handler is async to support the async publish() call without blocking
 *    the EventEmitter dispatch loop.
 *  - Any failure inside publish() is caught and logged; it must never propagate
 *    and kill the event dispatch cycle.
 *
 * Requirements: 13.7, 13.8
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';

import { NotificationService } from '../notification/notification.service';
import { NotificationAlert } from '../notification/notification.types';
import { JOURNAL_WRITE_FAILED_EVENT, JournalWriteFailedPayload } from './trade-journal.service';

@Injectable()
export class TradeJournalAlertListener {
  private readonly logger = new Logger(TradeJournalAlertListener.name);

  constructor(
    /**
     * Optional — when NotificationService is not registered (e.g., test
     * harnesses that do not import NotificationModule), NestJS injects null
     * rather than throwing.  The handler falls back to a logger-only path.
     *
     * @Inject() is required alongside @Optional() to ensure NestJS uses the
     * correct injection token regardless of TypeScript's emitDecoratorMetadata
     * behaviour with optional/union types.
     */
    @Optional()
    @Inject(NotificationService)
    private readonly notificationService: NotificationService | null,
  ) {}

  /**
   * React to all-retry-exhausted journal write failures.
   *
   * Publishes a CRITICAL alert to the operator via NotificationService so that
   * no failure is silently dropped (Requirement 13.7).
   */
  @OnEvent(JOURNAL_WRITE_FAILED_EVENT)
  async handleJournalWriteFailed(payload: JournalWriteFailedPayload): Promise<void> {
    // Always emit a structured error log regardless of NotificationService state.
    this.logger.error(
      `[TradeJournalAlert] Journal write failure detected — ` +
        `recordType="${payload.recordType}", reason="${payload.failureReason}", ` +
        `timestamp=${payload.timestamp.toISOString()}`,
    );

    if (!this.notificationService) {
      this.logger.warn(
        '[TradeJournalAlert] NotificationService is unavailable — ' +
          'CRITICAL alert could not be forwarded to the operator.',
      );
      return;
    }

    const alert: NotificationAlert = {
      id: uuidv4(),
      priority: 'CRITICAL',
      title: `Trade Journal Write Failed: ${payload.recordType}`,
      message:
        `All retry attempts were exhausted for journal record type "${payload.recordType}". ` +
        `Failure reason: ${payload.failureReason}. ` +
        `This record may not have been persisted — immediate operator review is required.`,
      metadata: {
        recordType: payload.recordType,
        failureReason: payload.failureReason,
        failedAt: payload.timestamp.toISOString(),
      },
      createdAt: payload.timestamp,
    };

    try {
      await this.notificationService.publish(alert);
      this.logger.log(
        `[TradeJournalAlert] CRITICAL alert published for failed write — ` +
          `recordType="${payload.recordType}"`,
      );
    } catch (err) {
      // Do not let a notification failure mask the original journal failure.
      this.logger.error(
        `[TradeJournalAlert] Failed to publish CRITICAL alert for ` +
          `recordType="${payload.recordType}": ${(err as Error).message}`,
      );
    }
  }
}
