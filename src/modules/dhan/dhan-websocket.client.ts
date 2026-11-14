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

/**
 * Dhan v2 Feed Request Codes (from Annexure):
 *   15 = Subscribe Ticker, 16 = Unsubscribe Ticker
 *   17 = Subscribe Quote,  18 = Unsubscribe Quote
 *   21 = Subscribe Full,   22 = Unsubscribe Full
 *
 * Full packet (21) is used so the bot receives LTP, Volume, OI and Market
 * Depth in one message — required for options signal generation.
 */
const SUBSCRIBE_REQUEST_CODE = 21; // Subscribe - Full Packet

/** Dhan market feed request code: unsubscribe Full Packet. */
const UNSUBSCRIBE_REQUEST_CODE = 22;

/**
 * Dhan v2 Feed Response Codes (binary header byte 0):
 *   1 = Index, 2 = Ticker, 4 = Quote, 5 = OI,
 *   6 = Prev Close, 7 = Market Status, 8 = Full, 50 = Disconnect
 */
const FEED_RESPONSE_CODE = {
  INDEX: 1,
  TICKER: 2,
  QUOTE: 4,
  OI: 5,
  PREV_CLOSE: 6,
  MARKET_STATUS: 7,
  FULL: 8,
  DISCONNECT: 50,
} as const;

/**
 * Exchange segment byte → string mapping (from Dhan Annexure).
 * Used when converting binary response header back to human-readable segment.
 */
const EXCHANGE_SEGMENT_MAP: Record<number, string> = {
  0: 'IDX_I',
  1: 'NSE_EQ',
  2: 'NSE_FNO',
  3: 'NSE_CURRENCY',
  4: 'BSE_EQ',
  5: 'MCX_COMM',
  7: 'BSE_CURRENCY',
  8: 'BSE_FNO',
};

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
   * Dhan v2 authenticates via query parameters on the WebSocket URL — NOT via
   * HTTP headers.  The URL format is:
   *   wss://api-feed.dhan.co?version=2&token=TOKEN&clientId=CLIENT_ID&authType=2
   *
   * The Dhan session token is fetched fresh from SecretsService on every call
   * (never stored locally — Requirement 3.3).
   */
  private async attemptConnection(): Promise<void> {
    const wsBaseUrl = this.config.get<string>('DHAN_WS_URL', 'wss://api-feed.dhan.co');
    const clientId = this.config.get<string>('DHAN_CLIENT_ID', '');

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

    // Dhan v2 requires auth as query params, NOT as HTTP headers.
    // Adding headers causes HTTP 400 — the server ignores them.
    const wsUrl =
      `${wsBaseUrl}?version=2` +
      `&token=${encodeURIComponent(token)}` +
      `&clientId=${encodeURIComponent(clientId)}` +
      `&authType=2`;

    this.logger.log(
      `Connecting to Dhan feed: ${wsBaseUrl}?version=2&clientId=${clientId}&authType=2&token=***`,
    );

    try {
      // No headers needed — auth is embedded in the URL above
      this.ws = new WebSocket(wsUrl);

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
   * Handle an incoming WebSocket message from Dhan Market Feed v2.
   *
   * Dhan sends ALL responses as **little-endian binary packets**, never JSON.
   * The binary layout (0-indexed bytes):
   *
   *   Header (8 bytes):
   *     [0]      uint8  — Feed Response Code (see FEED_RESPONSE_CODE)
   *     [1-2]    int16  — Total message length in bytes
   *     [3]      uint8  — Exchange Segment (see EXCHANGE_SEGMENT_MAP)
   *     [4-7]    int32  — Security ID
   *
   *   Payload varies by response code:
   *     2  Ticker   : [8-11] float32 LTP,  [12-15] int32 LTT(epoch)
   *     4  Quote    : [8-11] float32 LTP,  [12-13] int16 LTQ,
   *                   [14-17] int32 LTT,   [18-21] float32 ATP,
   *                   [22-25] int32 Volume,[26-29] int32 TSQ,[30-33] int32 TBQ,
   *                   [34-37] float32 Open,[38-41] float32 Close,
   *                   [42-45] float32 High,[46-49] float32 Low
   *     5  OI       : [8-11] int32 openInterest
   *     6  PrevClose: [8-11] float32 prevClose, [12-15] int32 prevOI
   *     8  Full     : Quote fields + OI + depth (163 bytes total)
   *     50 Disconnect: [8-9] int16 disconnection code
   *
   * All multi-byte values are **Little Endian** (Dhan v2 spec).
   *
   * Cancels the first-tick SLA timer on the first message received.
   * Emits `market.tick.received` with the parsed DhanTickData payload.
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
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      // Need at least 8 bytes to read the header
      if (buf.length < 8) {
        this.logger.warn(`Received undersized packet (${buf.length} bytes) — skipping`);
        return;
      }

      const responseCode = buf.readUInt8(0);
      // bytes 1-2: message length (unused for routing, but useful for debug)
      const exchangeSegmentByte = buf.readUInt8(3);
      const securityId = buf.readInt32LE(4);
      const exchangeSegment =
        EXCHANGE_SEGMENT_MAP[exchangeSegmentByte] ?? `UNKNOWN_${exchangeSegmentByte}`;

      // ── Disconnect packet ──────────────────────────────────────────────────
      if (responseCode === FEED_RESPONSE_CODE.DISCONNECT) {
        const disconnectCode = buf.length >= 10 ? buf.readInt16LE(8) : -1;
        this.logger.warn(`Dhan feed sent disconnect packet, code=${disconnectCode}`);
        return;
      }

      // ── Ticker packet (code 2) ─────────────────────────────────────────────
      if (responseCode === FEED_RESPONSE_CODE.TICKER) {
        if (buf.length < 16) return;
        const tick: DhanTickData = {
          securityId,
          exchangeSegment,
          lastTradedPrice: buf.readFloatLE(8),
          timestamp: buf.readInt32LE(12),
        };
        this.eventEmitter.emit('market.tick.received', tick);
        return;
      }

      // ── Quote packet (code 4) ──────────────────────────────────────────────
      if (responseCode === FEED_RESPONSE_CODE.QUOTE) {
        if (buf.length < 50) return;
        const tick: DhanTickData = {
          securityId,
          exchangeSegment,
          lastTradedPrice: buf.readFloatLE(8),
          lastTradedQuantity: buf.readInt16LE(12),
          timestamp: buf.readInt32LE(14),
          avgTradePrice: buf.readFloatLE(18),
          volume: buf.readInt32LE(22),
          totalSellQty: buf.readInt32LE(26),
          totalBuyQty: buf.readInt32LE(30),
          open: buf.readFloatLE(34),
          close: buf.readFloatLE(38),
          high: buf.readFloatLE(42),
          low: buf.readFloatLE(46),
        };
        this.eventEmitter.emit('market.tick.received', tick);
        return;
      }

      // ── OI packet (code 5) ─────────────────────────────────────────────────
      if (responseCode === FEED_RESPONSE_CODE.OI) {
        if (buf.length < 12) return;
        const tick: DhanTickData = {
          securityId,
          exchangeSegment,
          openInterest: buf.readInt32LE(8),
        };
        this.eventEmitter.emit('market.tick.received', tick);
        return;
      }

      // ── Prev-Close packet (code 6) ─────────────────────────────────────────
      if (responseCode === FEED_RESPONSE_CODE.PREV_CLOSE) {
        if (buf.length < 16) return;
        const tick: DhanTickData = {
          securityId,
          exchangeSegment,
          prevClose: buf.readFloatLE(8),
          prevOI: buf.readInt32LE(12),
        };
        this.eventEmitter.emit('market.tick.received', tick);
        return;
      }

      // ── Full packet (code 8) — primary packet for trading ─────────────────
      if (responseCode === FEED_RESPONSE_CODE.FULL) {
        if (buf.length < 62) return;
        const tick: DhanTickData = {
          securityId,
          exchangeSegment,
          lastTradedPrice: buf.readFloatLE(8),
          lastTradedQuantity: buf.readInt16LE(12),
          timestamp: buf.readInt32LE(14),
          avgTradePrice: buf.readFloatLE(18),
          volume: buf.readInt32LE(22),
          totalSellQty: buf.readInt32LE(26),
          totalBuyQty: buf.readInt32LE(30),
          openInterest: buf.readInt32LE(34),
          highestOI: buf.readInt32LE(38),
          lowestOI: buf.readInt32LE(42),
          open: buf.readFloatLE(46),
          close: buf.readFloatLE(50),
          high: buf.readFloatLE(54),
          low: buf.readFloatLE(58),
        };

        // Market depth: 5 levels × 20 bytes starting at byte 62
        if (buf.length >= 162) {
          const depth: Array<{
            bidQty: number;
            askQty: number;
            bidOrders: number;
            askOrders: number;
            bidPrice: number;
            askPrice: number;
          }> = [];
          for (let i = 0; i < 5; i++) {
            const offset = 62 + i * 20;
            depth.push({
              bidQty: buf.readInt32LE(offset),
              askQty: buf.readInt32LE(offset + 4),
              bidOrders: buf.readInt16LE(offset + 8),
              askOrders: buf.readInt16LE(offset + 10),
              bidPrice: buf.readFloatLE(offset + 12),
              askPrice: buf.readFloatLE(offset + 16),
            });
          }
          tick.depth = depth;
        }

        this.eventEmitter.emit('market.tick.received', tick);
        return;
      }

      // ── Index packet (code 1) ──────────────────────────────────────────────
      if (responseCode === FEED_RESPONSE_CODE.INDEX) {
        if (buf.length < 16) return;
        const tick: DhanTickData = {
          securityId,
          exchangeSegment,
          lastTradedPrice: buf.readFloatLE(8),
          timestamp: buf.readInt32LE(12),
        };
        this.eventEmitter.emit('market.tick.received', tick);
        return;
      }

      // Unknown response code — log and discard
      this.logger.debug(`Unknown feed response code ${responseCode} for securityId=${securityId}`);
    } catch (err) {
      this.logger.error(`Failed to parse binary tick packet: ${(err as Error).message}`);
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
      // Guard: if disconnect() was called while the timer was pending, the
      // explicitDisconnect flag will be set — do not overwrite state or reconnect.
      if (this.explicitDisconnect || this.state === 'DISCONNECTING') {
        this.logger.log('Reconnect timer fired but explicit disconnect is in progress — aborting');
        return;
      }
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
