/**
 * dhan-token-watcher.service.ts
 *
 * DhanTokenWatcherService — monitors the Dhan session token for expiry and
 * alerts operators before it expires.
 *
 * Uses EventEmitter2 to avoid a circular dependency with LiveTradingModule.
 * On token expiry, emits `dhan.token.expired` which LiveTradingService handles.
 *
 * Requirements: Phase 10 — Dhan token renewal workflow
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import { RedisService } from '../redis/redis.service';
import { NotificationService } from '../notification/notification.service';

/** NestJS event emitted when the token has expired. LiveTradingService handles this. */
export const DHAN_TOKEN_EXPIRED_EVENT = 'dhan.token.expired';

/** Redis key storing the ISO timestamp of the last confirmed token validation. */
export const DHAN_TOKEN_LAST_VALIDATED_KEY = 'dhan:token:last_validated';

/** Token lifetime in milliseconds (24 hours). */
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/** Issue WARNING alert when less than this many ms remain. */
const WARN_THRESHOLD_MS = 2 * 60 * 60 * 1_000; // 2 hours

/** Issue CRITICAL alert when less than this many ms remain. */
const CRITICAL_THRESHOLD_MS = 30 * 60 * 1_000; // 30 minutes

@Injectable()
export class DhanTokenWatcherService {
  private readonly logger = new Logger(DhanTokenWatcherService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly notificationService: NotificationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Record that the token was just successfully used.
   * Called by DhanApiClient after a successful request.
   */
  async markTokenActive(): Promise<void> {
    try {
      await this.redisService.set(
        DHAN_TOKEN_LAST_VALIDATED_KEY,
        new Date().toISOString(),
        TOKEN_LIFETIME_MS / 1_000 + 3600, // TTL slightly longer than token lifetime
      );
    } catch {
      // Non-fatal
    }
  }

  /**
   * Check token expiry every 30 minutes.
   * Alerts at 2h, 30min, and 0min remaining.
   */
  @Cron('*/30 * * * *', { timeZone: 'Asia/Kolkata' })
  async checkTokenExpiry(): Promise<void> {
    let tokenAgeMs: number;

    try {
      const lastValidated = await this.redisService.get(DHAN_TOKEN_LAST_VALIDATED_KEY);
      if (!lastValidated) {
        // Conservative fallback: assume 23h age (1h remaining)
        tokenAgeMs = 23 * 60 * 60 * 1_000;
        this.logger.warn('[TokenWatcher] No token validation timestamp found — assuming 23h age');
      } else {
        tokenAgeMs = Date.now() - new Date(lastValidated).getTime();
      }
    } catch (err) {
      this.logger.error(`[TokenWatcher] Failed to read token age: ${(err as Error).message}`);
      return;
    }

    const remainingMs = TOKEN_LIFETIME_MS - tokenAgeMs;

    this.logger.debug(
      `[TokenWatcher] Token age: ${Math.round(tokenAgeMs / 60_000)}min, ` +
        `remaining: ${Math.round(remainingMs / 60_000)}min`,
    );

    // ── Expired ───────────────────────────────────────────────────────────────
    if (remainingMs <= 0) {
      this.logger.error('[TokenWatcher] Dhan token has EXPIRED — emitting force-disarm event');
      // Emit event instead of calling LiveTradingService directly (avoids circular dep).
      this.eventEmitter.emit(DHAN_TOKEN_EXPIRED_EVENT, { expiredAt: new Date() });
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'MAX',
        title: '🔴 Dhan Token EXPIRED — Live Trading Disabled',
        message:
          'The Dhan session token has expired (24h lifetime). ' +
          'Generate a new token at https://login.dhan.co and update DHAN_SESSION_TOKEN. ' +
          'Live trading has been force-disarmed.',
        metadata: { tokenAgeMinutes: Math.round(tokenAgeMs / 60_000) },
        createdAt: new Date(),
      });
      return;
    }

    // ── CRITICAL: < 30 minutes remaining ────────────────────────────────────
    if (remainingMs < CRITICAL_THRESHOLD_MS) {
      const minutesLeft = Math.round(remainingMs / 60_000);
      this.logger.warn(`[TokenWatcher] CRITICAL: Dhan token expires in ${minutesLeft} minutes`);
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'CRITICAL',
        title: `⚠️ Dhan Token Expires in ${minutesLeft} Minutes`,
        message:
          `The Dhan session token expires in approximately ${minutesLeft} minutes. ` +
          'Renew it immediately at https://login.dhan.co to avoid trading disruption.',
        metadata: { minutesRemaining: minutesLeft },
        createdAt: new Date(),
      });
      return;
    }

    // ── WARNING: < 2 hours remaining ─────────────────────────────────────────
    if (remainingMs < WARN_THRESHOLD_MS) {
      const hoursLeft = (remainingMs / (60 * 60 * 1_000)).toFixed(1);
      this.logger.warn(`[TokenWatcher] WARNING: Dhan token expires in ${hoursLeft}h`);
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'WARNING',
        title: `⚠️ Dhan Token Expires in ${hoursLeft}h`,
        message:
          `The Dhan session token expires in approximately ${hoursLeft} hours. ` +
          'Plan to renew it at https://login.dhan.co before it expires.',
        metadata: { hoursRemaining: parseFloat(hoursLeft) },
        createdAt: new Date(),
      });
    }
  }
}
