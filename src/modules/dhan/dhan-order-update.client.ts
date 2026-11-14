/**
 * dhan-order-update.client.ts
 *
 * DhanOrderUpdateClient — WebSocket client for Dhan's real-time order
 * update feed (wss://api-order-update.dhan.co).
 *
 * This replaces the 15-second polling in OrderStatusPollerService for
 * fill detection, reducing fill latency from ~15 s to ~100 ms.
 *
 * Authentication: same query-param format as the market data feed.
 *   wss://api-order-update.dhan.co?version=2&token=<token>&clientId=<id>&authType=2
 *
 * Message format: JSON (not binary like the market data feed).
 *   {
 *     "dhanClientId": "...",
 *     "orderId": "...",
 *     "correlationId": "...",
 *     "orderStatus": "TRADED" | "PARTIALLY_TRADED" | "REJECTED" | "CANCELLED",
 *     "tradingSymbol": "NIFTY24JAN21000CE",
 *     "securityId": "...",
 *     "quantity": 50,
 *     "tradedQuantity": 50,
 *     "tradedPrice": "123.45",
 *     "remainingQuantity": 0,
 *     "type": "ORDER_STATUS"
 *   }
 *
 * On receiving a fill event, emits ORDER_FILL_DETECTED_EVENT (same event as
 * OrderStatusPollerService) and updates the Orders table — keeping the two
 * paths fully interchangeable.
 *
 * Requirements: Phase 2 — real-time order fill detection
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationService } from '../notification/notification.service';
import { Order } from '../../database/entities/orders.entity';
import { ORDER_FILL_DETECTED_EVENT } from './order-status-poller.service';

/** Reconnection back-off delays (ms). */
const BACKOFF_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** Max consecutive reconnect attempts before halting. */
const MAX_FAILURES = 5;
/** Startup delay (ms) — allow DB connections to stabilise before connecting. */
const STARTUP_DELAY_MS = 8_000;

/** Shape of a Dhan order-update WebSocket message. */
interface DhanOrderUpdateMessage {
  type?: string;
  orderId?: string;
  correlationId?: string;
  orderStatus?: string;
  tradingSymbol?: string;
  securityId?: string;
  tradedQuantity?: number;
  tradedPrice?: string;
  quantity?: number;
  remainingQuantity?: number;
}

@Injectable()
export class DhanOrderUpdateClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DhanOrderUpdateClient.name);

  private ws: WebSocket | null = null;
  private consecutiveFailures = 0;
  private explicitDisconnect = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /** Track already-alerted REJECTED/CANCELLED orders to suppress duplicates. */
  private readonly alertedOrders = new Set<string>();

  constructor(
    private readonly secrets: SecretsService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly notificationService: NotificationService,
    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,
  ) {}

  onModuleInit(): void {
    setTimeout(() => {
      void this.connect();
    }, STARTUP_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.explicitDisconnect = true;
    clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore teardown errors */
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.explicitDisconnect) return;

    let token: string;
    let clientId: string;
    try {
      [token, clientId] = await Promise.all([
        this.secrets.get('DHAN_SESSION_TOKEN'),
        this.secrets.get('DHAN_CLIENT_ID'),
      ]);
    } catch (err) {
      this.logger.warn(`[OrderUpdateWS] Cannot read Dhan credentials: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }

    if (!token || !clientId) {
      this.logger.warn('[OrderUpdateWS] DHAN_SESSION_TOKEN or DHAN_CLIENT_ID not set — skipping');
      return;
    }

    const baseUrl = this.config.get<string>(
      'DHAN_ORDER_UPDATE_WS_URL',
      'wss://api-order-update.dhan.co',
    );
    const wsUrl =
      `${baseUrl}?version=2` +
      `&token=${encodeURIComponent(token)}` +
      `&clientId=${encodeURIComponent(clientId)}` +
      `&authType=2`;

    this.logger.log('[OrderUpdateWS] Connecting to Dhan order update feed…');

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this.logger.error(`[OrderUpdateWS] WebSocket constructor failed: ${(err as Error).message}`);
      this.consecutiveFailures++;
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.consecutiveFailures = 0;
      this.logger.log('[OrderUpdateWS] Connected — real-time order updates active');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      void this.handleMessage(data);
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`[OrderUpdateWS] Error: ${err.message}`);
    });

    this.ws.on('close', (code: number) => {
      this.logger.warn(`[OrderUpdateWS] Disconnected (code=${code})`);
      this.ws = null;
      if (!this.explicitDisconnect) {
        this.consecutiveFailures++;
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.explicitDisconnect || this.consecutiveFailures > MAX_FAILURES) {
      if (this.consecutiveFailures > MAX_FAILURES) {
        this.logger.error(
          `[OrderUpdateWS] Exceeded ${MAX_FAILURES} reconnect attempts — giving up. ` +
            `Order fills will be detected by the 15s poller fallback.`,
        );
      }
      return;
    }
    const delay =
      BACKOFF_DELAYS_MS[Math.min(this.consecutiveFailures - 1, BACKOFF_DELAYS_MS.length - 1)] ??
      30_000;
    this.logger.log(`[OrderUpdateWS] Reconnecting in ${delay / 1_000}s…`);
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message handling
  // ─────────────────────────────────────────────────────────────────────────

  private async handleMessage(raw: WebSocket.Data): Promise<void> {
    let msg: DhanOrderUpdateMessage;
    try {
      msg = JSON.parse(raw.toString()) as DhanOrderUpdateMessage;
    } catch {
      return; // ignore non-JSON frames (heartbeat, etc.)
    }

    if (msg.type !== 'ORDER_STATUS' || !msg.orderId) return;

    const dhanOrderId = msg.orderId;
    const status = msg.orderStatus?.toUpperCase() ?? '';

    // Find our DB order by dhan_order_id
    let order: Order | null;
    try {
      order = await this.ordersRepo.findOne({
        where: { dhan_order_id: dhanOrderId, engine: 'LIVE' },
      });
    } catch {
      return;
    }
    if (!order) return; // unknown order — OrderStatusPoller will handle it

    // ── TRADED (full fill) ───────────────────────────────────────────────────
    if (status === 'TRADED' || status === 'FILLED') {
      const qty = msg.tradedQuantity ?? order.quantity;
      const price = msg.tradedPrice ?? '0';

      // Atomic guard: only write if not already complete — eliminates the
      // TOCTOU race with OrderStatusPollerService (both detect fills independently).
      const updateResult = await this.ordersRepo.update(
        { id: order.id, status: Not('complete') },
        { status: 'complete' as Order['status'], filled_quantity: qty, average_fill_price: price },
      );

      if (!updateResult.affected || updateResult.affected === 0) {
        this.logger.debug(
          `[OrderUpdateWS] Fill for order ${order.id} already processed — skipping duplicate`,
        );
        return;
      }

      this.eventEmitter.emit(ORDER_FILL_DETECTED_EVENT, {
        orderId: order.id,
        dhanOrderId,
        fillQuantity: qty,
        fillPrice: price,
        engine: order.engine,
        instrumentId: order.instrument_id,
        fillTimestamp: new Date(),
      });

      this.logger.log(`[OrderUpdateWS] FILLED orderId=${order.id} qty=${qty}@${price}`);
    }

    // ── PARTIALLY_TRADED ─────────────────────────────────────────────────────
    else if (status === 'PARTIALLY_TRADED' || status === 'PARTIALLY_FILLED') {
      const tradedQty = msg.tradedQuantity ?? 0;
      if (tradedQty > 0) {
        const price = msg.tradedPrice ?? '0';
        const prevFilled = order.filled_quantity; // snapshot before atomic update

        // Atomic guard: only write if our tradedQty is strictly greater than the
        // current DB value — eliminates duplicate partial-fill events.
        const updateResult = await this.ordersRepo.update(
          { id: order.id, filled_quantity: LessThan(tradedQty) },
          {
            status: 'partial' as Order['status'],
            filled_quantity: tradedQty,
            average_fill_price: price,
          },
        );

        if (!updateResult.affected || updateResult.affected === 0) {
          return; // stale or already processed
        }

        const newFill = tradedQty - prevFilled;
        this.eventEmitter.emit(ORDER_FILL_DETECTED_EVENT, {
          orderId: order.id,
          dhanOrderId,
          fillQuantity: newFill,
          fillPrice: price,
          engine: order.engine,
          instrumentId: order.instrument_id,
          fillTimestamp: new Date(),
        });
      }
    }

    // ── REJECTED / CANCELLED ─────────────────────────────────────────────────
    else if (
      (status === 'REJECTED' || status === 'CANCELLED') &&
      order.status !== 'rejected' &&
      order.status !== 'cancelled'
    ) {
      const newStatus = status === 'REJECTED' ? 'rejected' : 'cancelled';
      order.status = newStatus as Order['status'];
      order.rejection_reason = null;
      await this.ordersRepo.save(order);

      if (!this.alertedOrders.has(order.id)) {
        this.alertedOrders.add(order.id);
        await this.notificationService.publish({
          id: uuidv4(),
          priority: 'WARNING',
          title: `Order ${newStatus.toUpperCase()}: ${msg.tradingSymbol ?? ''}`,
          message: `Order ${order.id.slice(0, 8)} for ${msg.tradingSymbol ?? 'unknown'} was ${newStatus} by Dhan.`,
          metadata: { orderId: order.id, dhanOrderId, status },
          createdAt: new Date(),
        });
      }
    }
  }
}
