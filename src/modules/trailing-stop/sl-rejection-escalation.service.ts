/**
 * sl-rejection-escalation.service.ts
 *
 * SlRejectionEscalationService — implements the SL rejection escalation ladder
 * defined in Requirements 12.7, 12.8, and 12.9.
 *
 * Escalation rules:
 *   1–2 consecutive rejections → submit replacement SL within 5 s;
 *                                 publish CRITICAL alert via NotificationService
 *   ≥ 3 consecutive rejections → publish MAX-priority alert via NotificationService;
 *                                 disable new entries for the position until user ACK
 *   User ACK                   → reset consecutive rejection counter to exactly 0;
 *                                 re-enable entries
 *
 * Replacement SL submission is triggered by emitting SL_REPLACEMENT_REQUIRED_EVENT
 * via EventEmitter2 so that the broker-side SL registration layer (task 23.3) can
 * react without creating a circular dependency.
 *
 * Requirements: 12.7, 12.8, 12.9
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';

import { NotificationService } from '../notification/notification.service';

// ─────────────────────────────────────────────────────────────────────────────
// Event name
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emitted when 1–2 consecutive SL rejections require a replacement SL submission.
 * Consumers (e.g. broker-side SL registration handler) should submit a new
 * Super Order SL within 5 seconds of receiving this event.
 *
 * Requirements: 12.7
 */
export const SL_REPLACEMENT_REQUIRED_EVENT = 'sl.replacement.required';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Internal per-position state tracked by the escalation service. */
export interface SlRejectionState {
  consecutiveRejections: number;
  entriesDisabled: boolean;
}

/**
 * Arbitrary order-level details passed by the caller to provide context in
 * the notification alert and in the SL_REPLACEMENT_REQUIRED_EVENT payload.
 */
export interface SlRejectionOrderDetails {
  positionId: string;
  instrumentId?: string;
  stopLossPrice?: number;
  rejectionReason?: string;
  [key: string]: unknown;
}

/** Payload emitted with SL_REPLACEMENT_REQUIRED_EVENT */
export interface SlReplacementRequiredPayload {
  positionId: string;
  consecutiveRejections: number;
  orderDetails: SlRejectionOrderDetails;
}

/** Result returned by handleSlRejection() */
export interface SlRejectionHandleResult {
  /** Action the caller should take */
  action: 'SUBMIT_REPLACEMENT' | 'DISABLE_ENTRIES';
  /** Current consecutive rejection count after this call */
  consecutiveRejections: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SlRejectionEscalationService {
  private readonly logger = new Logger(SlRejectionEscalationService.name);

  /**
   * Per-position rejection state.
   * Map key: positionId
   */
  private readonly stateMap = new Map<string, SlRejectionState>();

  constructor(
    private readonly notificationService: NotificationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record a broker-side SL order rejection for the given position and apply
   * the escalation ladder.
   *
   *   consecutiveRejections === 1 or 2:
   *     → Publish CRITICAL alert via NotificationService
   *     → Emit SL_REPLACEMENT_REQUIRED_EVENT so the broker-side layer can
   *       resubmit the SL within 5 seconds (Requirement 12.7)
   *     → Return { action: 'SUBMIT_REPLACEMENT', consecutiveRejections }
   *
   *   consecutiveRejections ≥ 3:
   *     → Set entriesDisabled = true for this position
   *     → Publish MAX-priority alert via NotificationService (Requirement 12.8)
   *     → Return { action: 'DISABLE_ENTRIES', consecutiveRejections }
   *
   * Requirements: 12.7, 12.8
   */
  async handleSlRejection(
    positionId: string,
    orderDetails: SlRejectionOrderDetails,
  ): Promise<SlRejectionHandleResult> {
    const state = this.getOrCreateState(positionId);
    state.consecutiveRejections += 1;

    this.logger.warn(
      `[SlRejectionEscalation] SL rejection #${state.consecutiveRejections} ` +
        `for positionId=${positionId}`,
    );

    if (state.consecutiveRejections >= 3) {
      return this.handleEscalatedRejection(positionId, state, orderDetails);
    }

    return this.handleInitialRejection(positionId, state, orderDetails);
  }

  /**
   * Acknowledge the MAX-priority SL escalation alert for a position.
   *
   * Resets the consecutive rejection counter to exactly 0 and re-enables
   * new entries for the position, regardless of the counter's current value.
   *
   * Requirement 12.9
   */
  acknowledgeRejection(positionId: string): SlRejectionState {
    const state = this.getOrCreateState(positionId);
    state.consecutiveRejections = 0;
    state.entriesDisabled = false;

    this.logger.log(
      `[SlRejectionEscalation] User ACK received for positionId=${positionId}. ` +
        `Consecutive rejection counter reset to 0; entries re-enabled.`,
    );

    return { ...state };
  }

  /**
   * Returns true when new entries are disabled for the given position due to
   * ≥ 3 consecutive SL rejections pending user acknowledgment.
   *
   * Returns false for positions that have never had a rejection recorded.
   *
   * Requirement 12.8
   */
  isEntriesDisabledForPosition(positionId: string): boolean {
    return this.stateMap.get(positionId)?.entriesDisabled ?? false;
  }

  /**
   * Returns the current consecutive SL rejection count for a position.
   * Returns 0 for positions with no recorded rejections.
   *
   * Requirements: 12.7, 12.8
   */
  getRejectionCount(positionId: string): number {
    return this.stateMap.get(positionId)?.consecutiveRejections ?? 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — escalation handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handles the 1st and 2nd consecutive rejection.
   *
   * Publishes a CRITICAL alert and emits the replacement-required event.
   * Requirement 12.7
   */
  private async handleInitialRejection(
    positionId: string,
    state: SlRejectionState,
    orderDetails: SlRejectionOrderDetails,
  ): Promise<SlRejectionHandleResult> {
    await this.notificationService.publish({
      id: uuidv4(),
      priority: 'CRITICAL',
      title: 'SL Order Rejected — Replacement SL Submitted',
      message:
        `Broker-side SL order for position ${positionId} was rejected ` +
        `(consecutive rejection #${state.consecutiveRejections}). ` +
        `A replacement SL order will be submitted within 5 seconds.`,
      metadata: {
        ...orderDetails,
        positionId,
        consecutiveRejections: state.consecutiveRejections,
      },
      createdAt: new Date(),
    });

    // Emit event so the broker-side SL handler can resubmit within 5 seconds.
    const payload: SlReplacementRequiredPayload = {
      positionId,
      consecutiveRejections: state.consecutiveRejections,
      orderDetails,
    };
    this.eventEmitter.emit(SL_REPLACEMENT_REQUIRED_EVENT, payload);

    return {
      action: 'SUBMIT_REPLACEMENT',
      consecutiveRejections: state.consecutiveRejections,
    };
  }

  /**
   * Handles the 3rd and subsequent consecutive rejections.
   *
   * Disables new entries and publishes a MAX-priority alert.
   * Requirement 12.8
   */
  private async handleEscalatedRejection(
    positionId: string,
    state: SlRejectionState,
    orderDetails: SlRejectionOrderDetails,
  ): Promise<SlRejectionHandleResult> {
    state.entriesDisabled = true;

    await this.notificationService.publish({
      id: uuidv4(),
      priority: 'MAX',
      title: 'SL Order Rejected Repeatedly — Entries Disabled',
      message:
        `Broker-side SL order for position ${positionId} has been rejected ` +
        `${state.consecutiveRejections} consecutive times. ` +
        `All new entries for this position are DISABLED until you acknowledge this alert.`,
      metadata: {
        ...orderDetails,
        positionId,
        consecutiveRejections: state.consecutiveRejections,
      },
      createdAt: new Date(),
    });

    this.logger.error(
      `[SlRejectionEscalation] ≥3 consecutive SL rejections for positionId=${positionId}. ` +
        `New entries disabled. Awaiting user ACK.`,
    );

    return {
      action: 'DISABLE_ENTRIES',
      consecutiveRejections: state.consecutiveRejections,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — state management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the existing state for a position, or creates and stores a fresh
   * zero-state entry if none exists yet.
   */
  private getOrCreateState(positionId: string): SlRejectionState {
    if (!this.stateMap.has(positionId)) {
      this.stateMap.set(positionId, {
        consecutiveRejections: 0,
        entriesDisabled: false,
      });
    }
    return this.stateMap.get(positionId)!;
  }
}
