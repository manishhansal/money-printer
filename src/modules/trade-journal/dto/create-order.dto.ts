/**
 * CreateOrderDto — payload for journaling a new order record.
 *
 * Maps to the `Order` entity.  The TradeJournal only ever INSERTs;
 * order status updates are applied by the ExecutionService directly.
 *
 * Requirements: 13.1
 */

import {
  Engine,
  OrderType,
  TransactionType,
  OrderStatus,
} from '../../../database/entities/orders.entity';

export class CreateOrderDto {
  /**
   * Client-assigned idempotency key (UUID).
   * Stored as a UNIQUE constraint on the Orders table.
   */
  idempotencyKey!: string;

  /** Trading engine context. */
  engine!: Engine;

  /** FK → signals.id — NULL for system-triggered orders. */
  signalId?: string | null;

  /** FK → instruments.id */
  instrumentId!: string;

  /** Order variety. */
  orderType!: OrderType;

  /** Transaction direction. */
  transactionType!: TransactionType;

  /** Number of lots/units ordered. */
  quantity!: number;

  /** Limit price — NULL for MARKET orders. */
  price?: string | null;

  /** Trigger price — NULL for MARKET and LIMIT orders. */
  triggerPrice?: string | null;

  /** Dhan platform order ID — NULL until submitted. */
  dhanOrderId?: string | null;

  /** Dhan correlation ID for WebSocket feed tracking. */
  dhanCorrelationId?: string | null;

  /** Initial lifecycle status. */
  status!: OrderStatus;

  /** Rejection reason from the broker — NULL unless status = 'rejected'. */
  rejectionReason?: string | null;

  /** UTC timestamp when the order was forwarded to the broker. */
  submittedAt?: Date | null;
}
