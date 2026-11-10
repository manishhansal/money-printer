/**
 * sl-rejection-escalation.service.spec.ts
 *
 * Unit tests for SlRejectionEscalationService — the broker-side SL rejection
 * escalation ladder.
 *
 * Requirements: 12.7, 12.8, 12.9
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  SlRejectionEscalationService,
  SlRejectionOrderDetails,
  SL_REPLACEMENT_REQUIRED_EVENT,
} from './sl-rejection-escalation.service';
import { NotificationService } from '../notification/notification.service';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const POSITION_ID = 'pos-001';

const ORDER_DETAILS: SlRejectionOrderDetails = {
  positionId: POSITION_ID,
  instrumentId: 'NSE:NIFTY:CE:21000',
  stopLossPrice: 450.0,
  rejectionReason: 'INSUFFICIENT_MARGIN',
};

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('SlRejectionEscalationService', () => {
  let service: SlRejectionEscalationService;
  let mockNotificationService: { publish: jest.Mock };
  let mockEventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    mockNotificationService = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    mockEventEmitter = {
      emit: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlRejectionEscalationService,
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<SlRejectionEscalationService>(SlRejectionEscalationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // handleSlRejection: 1st rejection
  // ─────────────────────────────────────────────────────────────────────────

  describe('1st consecutive rejection', () => {
    it('publishes a CRITICAL alert', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'CRITICAL' }),
      );
    });

    it('returns action=SUBMIT_REPLACEMENT with count=1', async () => {
      const result = await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(result.action).toBe('SUBMIT_REPLACEMENT');
      expect(result.consecutiveRejections).toBe(1);
    });

    it('emits SL_REPLACEMENT_REQUIRED_EVENT with positionId', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SL_REPLACEMENT_REQUIRED_EVENT,
        expect.objectContaining({ positionId: POSITION_ID, consecutiveRejections: 1 }),
      );
    });

    it('does NOT disable entries', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // handleSlRejection: 2nd rejection
  // ─────────────────────────────────────────────────────────────────────────

  describe('2nd consecutive rejection', () => {
    beforeEach(async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      jest.clearAllMocks(); // isolate 2nd-rejection assertions
    });

    it('publishes a CRITICAL alert', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'CRITICAL' }),
      );
    });

    it('returns action=SUBMIT_REPLACEMENT with count=2', async () => {
      const result = await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(result.action).toBe('SUBMIT_REPLACEMENT');
      expect(result.consecutiveRejections).toBe(2);
    });

    it('emits SL_REPLACEMENT_REQUIRED_EVENT with consecutiveRejections=2', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SL_REPLACEMENT_REQUIRED_EVENT,
        expect.objectContaining({ positionId: POSITION_ID, consecutiveRejections: 2 }),
      );
    });

    it('does NOT disable entries', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // handleSlRejection: 3rd rejection
  // ─────────────────────────────────────────────────────────────────────────

  describe('3rd consecutive rejection', () => {
    beforeEach(async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      jest.clearAllMocks(); // isolate 3rd-rejection assertions
    });

    it('publishes a MAX-priority alert', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'MAX' }),
      );
    });

    it('returns action=DISABLE_ENTRIES with count=3', async () => {
      const result = await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(result.action).toBe('DISABLE_ENTRIES');
      expect(result.consecutiveRejections).toBe(3);
    });

    it('disables new entries for the position', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(true);
    });

    it('does NOT emit SL_REPLACEMENT_REQUIRED_EVENT (entries disabled instead)', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // handleSlRejection: 4th+ rejection
  // ─────────────────────────────────────────────────────────────────────────

  describe('4th and subsequent consecutive rejections', () => {
    beforeEach(async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      jest.clearAllMocks(); // isolate 4th+ assertions
    });

    it('publishes a MAX-priority alert on 4th rejection', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(mockNotificationService.publish).toHaveBeenCalledTimes(1);
      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'MAX' }),
      );
    });

    it('returns action=DISABLE_ENTRIES with count=4', async () => {
      const result = await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(result.action).toBe('DISABLE_ENTRIES');
      expect(result.consecutiveRejections).toBe(4);
    });

    it('entries remain disabled after 4th rejection', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(true);
    });

    it('publishes MAX on every subsequent rejection (5th)', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS); // 4th
      jest.clearAllMocks();
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS); // 5th

      expect(mockNotificationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'MAX' }),
      );
      expect(service.getRejectionCount(POSITION_ID)).toBe(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // acknowledgeRejection
  // ─────────────────────────────────────────────────────────────────────────

  describe('acknowledgeRejection (user ACK)', () => {
    it('resets consecutive rejection counter to exactly 0 after 3 rejections', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      expect(service.getRejectionCount(POSITION_ID)).toBe(3);

      service.acknowledgeRejection(POSITION_ID);

      expect(service.getRejectionCount(POSITION_ID)).toBe(0);
    });

    it('re-enables new entries after ACK', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(true);

      service.acknowledgeRejection(POSITION_ID);

      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(false);
    });

    it('returns updated state with consecutiveRejections=0 and entriesDisabled=false', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      const updatedState = service.acknowledgeRejection(POSITION_ID);

      expect(updatedState.consecutiveRejections).toBe(0);
      expect(updatedState.entriesDisabled).toBe(false);
    });

    it('resets counter to exactly 0 even when count is > 3 (e.g. count=7)', async () => {
      for (let i = 0; i < 7; i++) {
        await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      }
      expect(service.getRejectionCount(POSITION_ID)).toBe(7);

      service.acknowledgeRejection(POSITION_ID);

      expect(service.getRejectionCount(POSITION_ID)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // isEntriesDisabledForPosition
  // ─────────────────────────────────────────────────────────────────────────

  describe('isEntriesDisabledForPosition()', () => {
    it('returns false for a position with no recorded rejections', () => {
      expect(service.isEntriesDisabledForPosition('unknown-pos')).toBe(false);
    });

    it('returns false after the 1st rejection', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(false);
    });

    it('returns false after the 2nd rejection', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(false);
    });

    it('returns true after the 3rd rejection', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(true);
    });

    it('returns false after ACK following 3rd rejection', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      service.acknowledgeRejection(POSITION_ID);

      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getRejectionCount
  // ─────────────────────────────────────────────────────────────────────────

  describe('getRejectionCount()', () => {
    it('returns 0 for unknown position', () => {
      expect(service.getRejectionCount('no-such-position')).toBe(0);
    });

    it('increments correctly across multiple rejections', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      expect(service.getRejectionCount(POSITION_ID)).toBe(1);

      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      expect(service.getRejectionCount(POSITION_ID)).toBe(2);

      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      expect(service.getRejectionCount(POSITION_ID)).toBe(3);
    });

    it('returns 0 after ACK resets the counter', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      service.acknowledgeRejection(POSITION_ID);

      expect(service.getRejectionCount(POSITION_ID)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Multiple positions: state isolation
  // ─────────────────────────────────────────────────────────────────────────

  describe('multiple positions — state isolation', () => {
    const OTHER_POSITION_ID = 'pos-002';

    it('rejections on one position do not affect another', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      expect(service.isEntriesDisabledForPosition(OTHER_POSITION_ID)).toBe(false);
      expect(service.getRejectionCount(OTHER_POSITION_ID)).toBe(0);
    });

    it('ACK on one position does not affect another', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      await service.handleSlRejection(OTHER_POSITION_ID, {
        ...ORDER_DETAILS,
        positionId: OTHER_POSITION_ID,
      });
      await service.handleSlRejection(OTHER_POSITION_ID, {
        ...ORDER_DETAILS,
        positionId: OTHER_POSITION_ID,
      });
      await service.handleSlRejection(OTHER_POSITION_ID, {
        ...ORDER_DETAILS,
        positionId: OTHER_POSITION_ID,
      });

      service.acknowledgeRejection(POSITION_ID);

      // pos-001 is reset; pos-002 is still disabled
      expect(service.getRejectionCount(POSITION_ID)).toBe(0);
      expect(service.isEntriesDisabledForPosition(POSITION_ID)).toBe(false);
      expect(service.getRejectionCount(OTHER_POSITION_ID)).toBe(3);
      expect(service.isEntriesDisabledForPosition(OTHER_POSITION_ID)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Notification metadata
  // ─────────────────────────────────────────────────────────────────────────

  describe('notification alert metadata', () => {
    it('CRITICAL alert contains positionId in metadata', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      const publishedAlert = mockNotificationService.publish.mock.calls[0][0];
      expect(publishedAlert.metadata).toMatchObject({ positionId: POSITION_ID });
    });

    it('MAX alert contains positionId and consecutiveRejections in metadata', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      const calls = mockNotificationService.publish.mock.calls;
      const maxAlert = calls.find(
        (args: unknown[]) => (args[0] as { priority: string }).priority === 'MAX',
      );
      expect(maxAlert).toBeDefined();
      expect((maxAlert![0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
        positionId: POSITION_ID,
        consecutiveRejections: 3,
      });
    });

    it('each alert has a unique UUID id', async () => {
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);
      await service.handleSlRejection(POSITION_ID, ORDER_DETAILS);

      const ids = mockNotificationService.publish.mock.calls.map(
        (args: unknown[]) => (args[0] as { id: string }).id,
      );
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });
});
