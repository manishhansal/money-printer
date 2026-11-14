/**
 * order-status-poller.service.ts
 *
 * OrderStatusPollerService — polls Dhan for order status updates and
 * reconciles the local Orders table.
 *
 * Dhan does NOT push order fill events over the market data WebSocket.
 * Until a Dhan Live Order Update WebSocket is integrated, this poller
 * provides fill detection by periodically querying the orderbook.
 *
 * Schedule: every 15 seconds during market hours.
 *
 * Responsibilities:
 *  1. Query `dhanApiClient.getOrderbook()` for all today's orders.
 *  2. For each order with a matching `dhan_order_id` in our DB, compare statuses.
 *  3. Detect FILLED / PARTIALLY_FILLED transitions and emit fill events.
 *  4. Update Orders table status and filled_quantity.
 *  5. Alert on REJECTED / CANCELLED orders that were previously active.
 *
 * Requirements: Phase 10 — Dhan order status reconciliation
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, LessThan } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';

import { Order } from '../../database/entities/orders.entity';
import { DhanApiClient } from './dhan-api.client';
import { DhanOrderStatus } from './dhan-api.types';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { NotificationService } from '../notification/notification.service';

/** NestJS event emitted when an order fill is detected by the poller. */
export const ORDER_FILL_DETECTED_EVENT = 'order.fill.detected';

/** Dhan statuses considered active (not yet terminal) — used for context documentation. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ACTIVE_DHAN_STATUSES: DhanOrderStatus[] = ['TRANSIT', 'PENDING', 'PARTIALLY_FILLED'];

@Injectable()
export class OrderStatusPollerService {
  private readonly logger = new Logger(OrderStatusPollerService.name);

  /** Track which orders we've already alerted on REJECTED/CANCELLED to avoid spam. */
  private readonly alertedOrders = new Set<string>();

  constructor(
    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,
    private readonly dhanApiClient: DhanApiClient,
    private readonly sessionManagerService: SessionManagerService,
    private readonly notificationService: NotificationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Poll order statuses every 15 seconds during market hours.
   * Skips outside market hours (MARKET_CLOSED phase).
   */
  @Cron('*/15 * * * * *', { timeZone: 'Asia/Kolkata' })
  async pollOrderStatuses(): Promise<void> {
    // Skip outside market hours.
    if (!this.sessionManagerService.isWithinMarketHours()) {
      return;
    }

    // Query all our LIVE orders that are still active (not terminal).
    let activeOrders: Order[];
    try {
      activeOrders = await this.ordersRepo.find({
        where: {
          engine: 'LIVE',
          status: In(['pending', 'submitted', 'open', 'partial']),
        },
      });
    } catch (err) {
      this.logger.error(`[OrderPoller] Failed to query active orders: ${(err as Error).message}`);
      return;
    }

    if (activeOrders.length === 0) return;

    // Build map of dhanOrderId → our DB order for fast lookup.
    const dhanIdToOrder = new Map<string, Order>();
    for (const order of activeOrders) {
      if (order.dhan_order_id) {
        dhanIdToOrder.set(order.dhan_order_id, order);
      }
    }

    if (dhanIdToOrder.size === 0) return;

    // Fetch Dhan orderbook.
    let dhanOrders: Awaited<ReturnType<typeof this.dhanApiClient.getOrderbook>>;
    try {
      dhanOrders = await this.dhanApiClient.getOrderbook();
    } catch (err) {
      this.logger.debug(`[OrderPoller] getOrderbook failed (non-fatal): ${(err as Error).message}`);
      return;
    }

    // Process each Dhan order that we're tracking.
    for (const dhanOrder of dhanOrders) {
      const localOrder = dhanIdToOrder.get(dhanOrder.orderId);
      if (!localOrder) continue;

      const dhanStatus = dhanOrder.orderStatus;

      // ── FILLED ───────────────────────────────────────────────────────────────
      if (dhanStatus === 'FILLED' && localOrder.status !== 'complete') {
        const tradedQty = dhanOrder.filledQty ?? localOrder.quantity;
        const tradedPrice = String(dhanOrder.averageTradedPrice ?? 0);

        // Atomic guard: only write if not already complete — eliminates the
        // TOCTOU race with DhanOrderUpdateClient (both detect fills independently).
        const updateResult = await this.ordersRepo.update(
          { id: localOrder.id, status: Not('complete') },
          {
            status: 'complete' as Order['status'],
            filled_quantity: tradedQty,
            average_fill_price: tradedPrice,
          },
        );

        if (!updateResult.affected || updateResult.affected === 0) {
          this.logger.debug(
            `[OrderPoller] Fill for order ${localOrder.id} already processed — skipping duplicate`,
          );
          continue;
        }

        this.logger.log(
          `[OrderPoller] FILLED: orderId=${localOrder.id}, ` +
            `dhanOrderId=${dhanOrder.orderId}, qty=${tradedQty}@${tradedPrice}`,
        );

        // Emit fill event for position management.
        this.eventEmitter.emit(ORDER_FILL_DETECTED_EVENT, {
          orderId: localOrder.id,
          dhanOrderId: dhanOrder.orderId,
          fillQuantity: tradedQty,
          fillPrice: tradedPrice,
          engine: localOrder.engine,
          instrumentId: localOrder.instrument_id,
          fillTimestamp: new Date(),
        });
      }

      // ── PARTIALLY_FILLED ─────────────────────────────────────────────────────
      else if (dhanStatus === 'PARTIALLY_FILLED') {
        const tradedQty = dhanOrder.filledQty ?? 0;
        if (tradedQty > 0) {
          const tradedPrice = String(dhanOrder.averageTradedPrice ?? 0);
          const prevFilled = localOrder.filled_quantity; // snapshot before atomic update

          // Atomic guard: only write if our tradedQty is strictly greater than the
          // current DB value — eliminates duplicate partial-fill events.
          const updateResult = await this.ordersRepo.update(
            { id: localOrder.id, filled_quantity: LessThan(tradedQty) },
            {
              status: 'partial' as Order['status'],
              filled_quantity: tradedQty,
              average_fill_price: tradedPrice,
            },
          );

          if (!updateResult.affected || updateResult.affected === 0) {
            continue; // stale or already processed
          }

          const newFill = tradedQty - prevFilled;
          this.eventEmitter.emit(ORDER_FILL_DETECTED_EVENT, {
            orderId: localOrder.id,
            dhanOrderId: dhanOrder.orderId,
            fillQuantity: newFill,
            fillPrice: tradedPrice,
            engine: localOrder.engine,
            instrumentId: localOrder.instrument_id,
            fillTimestamp: new Date(),
          });

          this.logger.log(
            `[OrderPoller] PARTIAL_FILL: orderId=${localOrder.id}, ` +
              `filled=${tradedQty}/${localOrder.quantity}`,
          );
        }
      }

      // ── REJECTED / CANCELLED ─────────────────────────────────────────────────
      else if (
        (dhanStatus === 'REJECTED' || dhanStatus === 'CANCELLED') &&
        localOrder.status !== 'rejected' &&
        localOrder.status !== 'cancelled'
      ) {
        const newStatus = dhanStatus === 'REJECTED' ? 'rejected' : 'cancelled';
        localOrder.status = newStatus as Order['status'];
        localOrder.rejection_reason = null; // DhanOrder has no error description field
        await this.ordersRepo.save(localOrder);

        // Alert once per order.
        if (!this.alertedOrders.has(localOrder.id)) {
          this.alertedOrders.add(localOrder.id);
          await this.notificationService.publish({
            id: uuidv4(),
            priority: 'WARNING',
            title: `Order ${newStatus.toUpperCase()}: ${dhanOrder.tradingSymbol}`,
            message:
              `Order ${localOrder.id.slice(0, 8)} for ${dhanOrder.tradingSymbol} was ` +
              `${newStatus} by Dhan.`,
            metadata: {
              orderId: localOrder.id,
              dhanOrderId: dhanOrder.orderId,
              status: dhanStatus,
            },
            createdAt: new Date(),
          });
        }

        this.logger.warn(`[OrderPoller] ${dhanStatus}: orderId=${localOrder.id}`);
      }
    }
  }
}
