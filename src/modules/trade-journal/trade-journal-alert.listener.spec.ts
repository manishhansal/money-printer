/**
 * TradeJournalAlertListener unit tests.
 *
 * Covers:
 *   1. Publishes a CRITICAL alert via NotificationService when
 *      JOURNAL_WRITE_FAILED_EVENT fires (Requirements 13.7).
 *   2. Alert payload contains the correct priority, recordType metadata,
 *      failureReason, and a valid timestamp.
 *   3. Gracefully handles an absent NotificationService (Optional injection)
 *      without throwing — only logs a warning.
 *   4. Does not propagate errors thrown by NotificationService.publish().
 *
 * Requirements: 13.7, 13.8
 */

import { Test, TestingModule } from '@nestjs/testing';
import { TradeJournalAlertListener } from './trade-journal-alert.listener';
import { JOURNAL_WRITE_FAILED_EVENT, JournalWriteFailedPayload } from './trade-journal.service';
import { NotificationService } from '../notification/notification.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPayload(
  recordType = 'risk_events',
  failureReason = 'Disk full',
): JournalWriteFailedPayload {
  return { recordType, failureReason, timestamp: new Date('2024-01-15T10:00:00Z') };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('TradeJournalAlertListener', () => {
  let listener: TradeJournalAlertListener;
  let notificationService: { publish: jest.Mock };

  beforeEach(async () => {
    notificationService = { publish: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TradeJournalAlertListener,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    listener = module.get<TradeJournalAlertListener>(TradeJournalAlertListener);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('should call notificationService.publish() when JOURNAL_WRITE_FAILED_EVENT fires', async () => {
    await listener.handleJournalWriteFailed(buildPayload());

    expect(notificationService.publish).toHaveBeenCalledTimes(1);
  });

  it('should publish a CRITICAL priority alert', async () => {
    await listener.handleJournalWriteFailed(buildPayload());

    const [alert] = notificationService.publish.mock.calls[0];
    expect(alert.priority).toBe('CRITICAL');
  });

  it('should include the record type in the alert title and metadata', async () => {
    await listener.handleJournalWriteFailed(buildPayload('completed_trades', 'DB timeout'));

    const [alert] = notificationService.publish.mock.calls[0];
    expect(alert.title).toContain('completed_trades');
    expect(alert.metadata).toMatchObject({
      recordType: 'completed_trades',
      failureReason: 'DB timeout',
    });
  });

  it('should include the failure reason in the alert message', async () => {
    await listener.handleJournalWriteFailed(buildPayload('system_errors', 'Connection refused'));

    const [alert] = notificationService.publish.mock.calls[0];
    expect(alert.message).toContain('Connection refused');
  });

  it('should set createdAt from the payload timestamp', async () => {
    const payload = buildPayload();
    await listener.handleJournalWriteFailed(payload);

    const [alert] = notificationService.publish.mock.calls[0];
    expect(alert.createdAt).toEqual(payload.timestamp);
  });

  it('should attach a unique id (UUID) to the alert', async () => {
    await listener.handleJournalWriteFailed(buildPayload());

    const [alert] = notificationService.publish.mock.calls[0];
    expect(typeof alert.id).toBe('string');
    expect(alert.id.length).toBeGreaterThan(0);
  });

  // ── Optional NotificationService (degraded mode) ───────────────────────────

  it('should NOT throw when NotificationService is unavailable (Optional injection returns null)', async () => {
    const moduleWithoutNotification: TestingModule = await Test.createTestingModule({
      providers: [
        // No NotificationService provided — @Optional() gives null
        {
          provide: TradeJournalAlertListener,
          useValue: new (TradeJournalAlertListener as any)(null),
        },
      ],
    }).compile();

    const listenerWithoutNotification =
      moduleWithoutNotification.get<TradeJournalAlertListener>(TradeJournalAlertListener);

    // Must not throw — graceful degradation only logs a warning.
    await expect(
      listenerWithoutNotification.handleJournalWriteFailed(buildPayload()),
    ).resolves.toBeUndefined();
  });

  // ── Resilience against publish() errors ────────────────────────────────────

  it('should NOT propagate an error thrown by notificationService.publish()', async () => {
    notificationService.publish.mockRejectedValue(new Error('Redis unreachable'));

    // Must not throw — journal-alert errors must never propagate upward.
    await expect(listener.handleJournalWriteFailed(buildPayload())).resolves.toBeUndefined();
  });

  it('should still emit exactly one publish() attempt even when publish() rejects', async () => {
    notificationService.publish.mockRejectedValue(new Error('Redis unreachable'));

    await listener.handleJournalWriteFailed(buildPayload()).catch(() => {});

    expect(notificationService.publish).toHaveBeenCalledTimes(1);
  });

  // ── Event name constant ─────────────────────────────────────────────────────

  it('should listen on the correct event name exported by TradeJournalService', () => {
    expect(JOURNAL_WRITE_FAILED_EVENT).toBe('trade-journal.write.failed');
  });
});
