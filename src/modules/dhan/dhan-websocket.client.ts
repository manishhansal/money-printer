/**
 * dhan-websocket.client.ts
 *
 * DhanWebSocketClient — injectable NestJS service that manages a persistent
 * WebSocket connection to the Dhan Market Feed.
 *
 * Design rules:
 *  1. Session token is fetched from SecretsService on EVERY connection attempt
 *     (Requirement 3.3 — never stored locally).
 *  2. Exponential backoff reconnection: 1 s → 2 s → 4 s → 8 s → 16 s, capped
 *     at 30 s, for up to 5 consecutive attempts (Requirement 3.5).
 *  3. After 5 consecutive failed attempts, a CRITICAL connectivity-failure alert
 *     is published via NotificationService within 5 s (Requirement 3.8).
 *  4. First-tick SLA: a tick message must arrive within 3 s of the WebSocket
 *     `open` event; otherwise a WARNING log and staleness alert are emitted
 *     (Requirement 3.4).
 *  5. All connection errors are caught and logged without crashing the process.
 *
 * Requirements: 3.4, 3.5, 3.8
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationService } from '../notification/notification.service';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The four valid states of the WebSocket session state machine. */
export type SessionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTING';

/** Parsed tick payload emitted on the `market.tick.received` event. */
export interface DhanTickData {
  securityId: number | string;
  exchangeSegment?: string;
  lastTradedPrice?: number;
  timestamp?: number;
  /** Catch-all for any additional Dhan-specific fields. */
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconnection delay for each consecutive attempt (0-indexed).
 * Indices 0-4 correspond to attempts 1-5.
 * Requirement 3.5: 1 s → 2 s → 4 s → 8 s → 16 s.
 */
const BACKOFF_DELAYS_MS: readonly number[] = [
  1_000, // attempt 1
  2_000, // attempt 2
  4_000, // attempt 3
  8_000, // attempt 4
  16_000, // attempt 5
] as const;

/** Hard cap applied to any computed backoff delay. */
const MAX_BACKOFF_MS = 30_000;

/** Total number of consecutive reconnect attempts before giving up. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** First-tick SLA window in milliseconds (Requirement 3.4). */
const FIRST_TICK_SLA_MS = 3_000;

/** Dhan market feed request code: subscribe. */
const SUBSCRIBE_REQUEST_CODE = 21;

/** Dhan market feed request code: unsubscribe. */
const UNSUBSCRIBE_REQUEST_CODE = 22;

// ─────────────────────────────────────────────────────────────────────────────
// DhanWebSocketClient
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class DhanWebSocketClient implements OnModuleDestroy {
  private readonly logger = new Logger(DhanWebSocketClient.name);

  /** Active WebSocket instance; null when disconnected. */
  private ws: WebSocket | null = null;

  /** Current session state. */
  private state: SessionState = 'DISCONNECTED';

  /**
   * Number of consecutive reconnect attempts that have failed.
   * Reset to 0 when the WebSocket `open` event fires (Requirement 3.5).
   */
  private consecutiveFailures = 0;

  /**
   * Set to `true` when the caller explicitly disconnects.
   * Prevents automatic reconnection on the next `close` event.
   */
  private explicitDisconnect = false;

  /**
   * `true` once the first `message` event is received after the last `open`.
   * Used to track first-tick SLA compliance (Requirement 3.4).
   */
  private firstTickReceived = false;

  /** Handle for the first-tick SLA timeout. */
  private firstTickSlaTimer?: ReturnType<typeof setTimeout>;

  /** Handle for the reconnect backoff timer. */
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /**
   * Maps securityId → exchangeSegment for all active subscriptions.
   * Used to produce the correct unsubscription message when only securityIds
   * are provided.
   */
  private readonly subscriptions = new Map<number, string>();

  constructor(
    private readonly secrets: SecretsService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly notificationService: NotificationService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  onModuleDestroy(): void {
    this.explicitDisconnect = true;
    clearTimeout(this.firstTickSlaTimer);
    clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      // Ignore errors during teardown
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — connection lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /** Current session state (read-only accessor for external observers). */
  get sessionState(): SessionState {
    return this.state;
  }

  /**
   * Initiate the WebSocket connection.
   *
   * Idempotent: no-op if the client is not in DISCONNECTED state.
   * Resets the consecutive failure counter for a clean reconnect cycle.
   */
  async connect(): Promise<void> {
    if (this.state !== 'DISCONNECTED') {
      this.logger.warn(`connect() called while in state "${this.state}" — ignored`);
      return;
    }

    this.explicitDisconnect = false;
    this.consecutiveFailures = 0;
    this.state = 'CONNECTING';

    await this.attemptConnection();
  }

  /**
   * Gracefully close the WebSocket connection.
   *
   * Sets `explicitDisconnect = true` so the `close` event handler does NOT
   * schedule a reconnect attempt.
   */
  disconnect(): void {
    if (this.state === 'DISCONNECTED') {
      return;
    }

    this.explicitDisconnect = true;
    this.state = 'DISCONNECTING';

    clearTimeout(this.firstTickSlaTimer);
    clearTimeout(this.reconnectTimer);

    try {
      this.ws?.close();
    } catch (err) {
      this.logger.error(`Error closing WebSocket: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — subscription management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to live tick data for the given instruments.
   *
   * Sends a Dhan market feed subscription request (RequestCode 21).
   * No-op with a warning if the session is not CONNECTED.
   *
   * Requirement 3.2 — live WebSocket feed subscription.
   *
   * @param securityIds  Array of Dhan security IDs (integers).
   * @param exchangeType Dhan exchange segment string (e.g. `'NSE_FNO'`).
   */
  subscribe(securityIds: number[], exchangeType: string): void {
    // Store subscriptions for unsubscription lookups
    securityIds.forEach((id) => this.subscriptions.set(id, exchangeType));

    const message = {
      RequestCode: SUBSCRIBE_REQUEST_CODE,
      InstrumentCount: securityIds.length,
      InstrumentList: securityIds.map((id) => ({
        ExchangeSegment: exchangeType,
        SecurityId: id.toString(),
      })),
    };

    this.sendMessage(message);
  }

  /**
   * Unsubscribe from live tick data for the given instruments.
   *
   * Sends a Dhan market feed unsubscription request (RequestCode 22) grouped
   * by exchange segment (derived from the stored subscription map).
   * Security IDs not found in the subscription map are silently skipped.
   *
   * @param securityIds  Array of Dhan security IDs to unsubscribe.
   */
  unsubscribe(securityIds: number[]): void {
    // Group by exchange segment using stored subscription data
    const byExchange = new Map<string, number[]>();

    for (const id of securityIds) {
      const exchange = this.subscriptions.get(id);
      if (!exchange) {
        this.logger.warn(
          `unsubscribe: securityId ${id} not found in active subscriptions — skipping`,
        );
        continue;
      }

      if (!byExchange.has(exchange)) {
        byExchange.set(exchange, []);
      }
      byExchange.get(exchange)!.push(id);
      this.subscriptions.delete(id);
    }

    for (const [exchange, ids] of byExchange) {
      const message = {
        RequestCode: UNSUBSCRIBE_REQUEST_CODE,
        InstrumentCount: ids.length,
        InstrumentList: ids.map((id) => ({
          ExchangeSegment: exchange,
          SecurityId: id.toString(),
        })),
      };
      this.sendMessage(message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — connection management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new WebSocket instance and attach event handlers.
   *
   * The Dhan session token is fetched fresh from SecretsService on every call
   * (never stored locally — Requirement 3.3).
   */
  private async attemptConnection(): Promise<void> {
    const wsUrl = this.config.get<string>('DHAN_WS_URL', 'wss://api-feed.dhan.co');

    // Fetch token on every connection attempt — never cached (Requirement 3.3)
    let token: string;
    try {
      token = await this.secrets.get('DHAN_SESSION_TOKEN');
    } catch (err) {
      this.logger.error(
        `Failed to fetch DHAN_SESSION_TOKEN for WebSocket connection: ${(err as Error).message}`,
      );
      this.scheduleReconnect();
      return;
    }

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: { 'access-token': token },
      });

      this.ws.on('open', () => this.onOpen());
      this.ws.on('message', (data) => this.onMessage(data as Buffer));
      this.ws.on('close', (code: number, reason: Buffer) => this.onClose(code, reason));
      this.ws.on('error', (err: Error) => this.onError(err));
    } catch (err) {
      this.logger.error(`WebSocket constructor threw: ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — WebSocket event handlers
  // ─────────────────────────────────────────────────────────────────────────

  private onOpen(): void {
    // If the caller disconnected while we were establishing the connection,
    // close immediately without transitioning to CONNECTED.
    if (this.explicitDisconnect) {
      try {
        this.ws?.close();
      } catch {
        // Ignore
      }
      return;
    }

    this.state = 'CONNECTED';
    this.consecutiveFailures = 0; // Reset on every successful connection (Requirement 3.5)
    this.firstTickReceived = false;

    this.logger.log('Dhan WebSocket connection established');
    this.eventEmitter.emit('websocket.connected');

    // Arm the first-tick SLA watchdog (Requirement 3.4)
    this.clearFirstTickSlaTimer();
    this.firstTickSlaTimer = setTimeout(() => {
      if (!this.firstTickReceived) {
        this.logger.warn(
          `First-tick SLA violation: no tick received within ${FIRST_TICK_SLA_MS / 1_000} s of connection`,
        );
        void this.publishStalenessAlert();
      }
    }, FIRST_TICK_SLA_MS);
  }

  /**
   * Handle an incoming WebSocket message.
   *
   * Cancels the first-tick SLA timer on the first message received.
   * Emits `market.tick.received` with the parsed tick payload.
   *
   * Requirement 3.4 — first-tick SLA tracking.
   */
  private onMessage(data: Buffer): void {
    // First tick satisfies the SLA — cancel the watchdog
    if (!this.firstTickReceived) {
      this.firstTickReceived = true;
      this.clearFirstTickSlaTimer();
    }

    try {
      const rawStr = data.toString('utf8');
      const tick = JSON.parse(rawStr) as DhanTickData;
      this.eventEmitter.emit('market.tick.received', tick);
    } catch (err) {
      this.logger.error(`Failed to parse tick message: ${(err as Error).message}`);
    }
  }

  private onClose(code: number, reason: Buffer): void {
    this.logger.log(`Dhan WebSocket closed: code=${code} reason="${reason.toString()}"`);

    this.state = 'DISCONNECTED';
    this.clearFirstTickSlaTimer();
    this.eventEmitter.emit('websocket.disconnected', {
      code,
      reason: reason.toString(),
    });

    // Do not reconnect when the close was triggered explicitly
    if (!this.explicitDisconnect) {
      this.scheduleReconnect();
    }
  }

  private onError(err: Error): void {
    // Log the error; the `close` event that follows will drive reconnection
    this.logger.error(`Dhan WebSocket error: ${err.message}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — reconnection backoff
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Schedule the next reconnect attempt using exponential backoff.
   *
   * When all 5 consecutive attempts have been exhausted, the method publishes
   * a CRITICAL connectivity-failure alert via NotificationService instead of
   * scheduling another attempt.
   *
   * Requirement 3.5: delays are 1 s, 2 s, 4 s, 8 s, 16 s (≤ 30 s cap).
   * Requirement 3.8: connectivity-failure published within 5 s of 5th failure.
   */
  private scheduleReconnect(): void {
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.logger.error(
        `All ${MAX_CONSECUTIVE_FAILURES} WebSocket reconnect attempts exhausted — ` +
          'publishing connectivity-failure alert',
      );
      this.eventEmitter.emit('websocket.connectivity-failure');
      void this.publishConnectivityFailureAlert();
      return;
    }

    const delayMs = Math.min(
      BACKOFF_DELAYS_MS[this.consecutiveFailures] ?? MAX_BACKOFF_MS,
      MAX_BACKOFF_MS,
    );

    this.consecutiveFailures++;

    this.logger.log(
      `Scheduling reconnect attempt ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} in ${delayMs} ms`,
    );

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.state = 'CONNECTING';
      void this.attemptConnection();
    }, delayMs);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — message sending
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a JSON-serialisable message over the active WebSocket.
   * Logs a warning and discards the message if the session is not CONNECTED.
   */
  private sendMessage(message: unknown): void {
    if (this.state !== 'CONNECTED' || !this.ws) {
      this.logger.warn(`sendMessage called in state "${this.state}" — message discarded`);
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      this.logger.error(`Failed to send WebSocket message: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — alert publishing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Publish a CRITICAL connectivity-failure alert.
   * Fires-and-returns; any publish error is caught and logged.
   *
   * Requirement 3.8: published within 5 s of the 5th consecutive failure.
   */
  private async publishConnectivityFailureAlert(): Promise<void> {
    try {
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'CRITICAL',
        title: 'Dhan WebSocket Connectivity Failure',
        message:
          `Failed to reconnect to the Dhan market feed after ` +
          `${MAX_CONSECUTIVE_FAILURES} consecutive attempts. ` +
          'Manual intervention may be required.',
        metadata: {
          consecutiveFailures: this.consecutiveFailures,
          maxAttempts: MAX_CONSECUTIVE_FAILURES,
        },
        createdAt: new Date(),
      });
    } catch (err) {
      this.logger.error(`Failed to publish connectivity-failure alert: ${(err as Error).message}`);
    }
  }

  /**
   * Publish a WARNING staleness alert when the first-tick SLA is violated.
   * Fires-and-returns; any publish error is caught and logged.
   *
   * Requirement 3.4: first tick must arrive within 3 s of connection.
   */
  private async publishStalenessAlert(): Promise<void> {
    try {
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'WARNING',
        title: 'Market Data Staleness Alert',
        message:
          `No tick data received within ${FIRST_TICK_SLA_MS / 1_000} seconds ` +
          'of Dhan WebSocket connection. Market data feed may be stale.',
        metadata: {
          slaSecs: FIRST_TICK_SLA_MS / 1_000,
        },
        createdAt: new Date(),
      });
    } catch (err) {
      this.logger.error(`Failed to publish staleness alert: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — utilities
  // ─────────────────────────────────────────────────────────────────────────

  private clearFirstTickSlaTimer(): void {
    if (this.firstTickSlaTimer !== undefined) {
      clearTimeout(this.firstTickSlaTimer);
      this.firstTickSlaTimer = undefined;
    }
  }
}
