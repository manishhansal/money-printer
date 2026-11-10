/**
 * super-order-sl.service.ts
 *
 * SuperOrderSlService — manages broker-side stop-loss registration via Dhan
 * and maintains an internal SL registry independent of broker state.
 *
 * Responsibilities:
 *  1. Register a stop-loss order with Dhan when a trailing stop is activated
 *     (must complete within 5 seconds — callers schedule verification after
 *     SL_CONFIRMATION_TIMEOUT_MS).
 *  2. Verify the registered order is ACTIVE on Dhan's side after the timeout.
 *     If not confirmed → treat broker SL as inactive and submit a replacement.
 *  3. Expose per-position SL status for the TrailingStopEngine and
 *     ReconciliationService to query.
 *  4. Clean up registry entries when positions are closed.
 *
 * Requirements: 12.3, 12.5
 */

import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { DhanApiClient } from '../dhan/dhan-api.client';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationService } from '../notification/notification.service';
import { DhanExchangeSegment, DhanOrderStatus, DhanProductType } from '../dhan/dhan-api.types';
import { PositionDirection } from './trailing-stop.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Milliseconds callers should wait before calling verifyBrokerSlConfirmation().
 * Requirement 12.3 — SL must be registered within 5 seconds of activation.
 */
export const SL_CONFIRMATION_TIMEOUT_MS = 5_000;

/**
 * Dhan order statuses that indicate a stop-loss order is live and waiting
 * to be triggered.  TRANSIT = order en route to exchange, PENDING = resting
 * at exchange awaiting trigger.
 */
const ACTIVE_SL_STATUSES: ReadonlySet<DhanOrderStatus> = new Set<DhanOrderStatus>([
  'TRANSIT',
  'PENDING',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-position entry stored in the internal registry.
 *
 * All fields needed to query Dhan for confirmation *and* to reconstruct a
 * replacement order without an extra round-trip are captured at registration.
 */
export interface PositionSlRegistryEntry {
  /** Dhan order ID returned by placeOrder(). */
  dhanOrderId: string;
  /** UTC timestamp when registerBrokerSl() was called. */
  registeredAt: Date;
  /**
   * True once verifyBrokerSlConfirmation() finds the order in an ACTIVE status.
   * Remains false until confirmed; callers must not treat the broker SL as
   * reliable until this flag is set.
   */
  confirmed: boolean;
  /** Stop-loss trigger price (INR). */
  slPrice: number;
  // ── Stored to enable replacement order without additional API lookups ──
  /** Dhan security ID of the instrument. */
  instrumentId: string;
  /** Whether the original position is long or short. */
  direction: PositionDirection;
  /** Position size in units/lots. */
  quantity: number;
  /** Exchange segment for the instrument. */
  exchangeSegment: DhanExchangeSegment;
  /** Product type (INTRADAY / MARGIN / CNC / …). */
  productType: DhanProductType;
}

/** Result returned by registerBrokerSl(). */
export interface RegisterBrokerSlResult {
  /** True when the order was successfully submitted to Dhan. */
  success: boolean;
  /** Dhan order ID; present only when success = true. */
  dhanOrderId?: string;
  /** Error message; present only when success = false. */
  error?: string;
}

/** Result returned by verifyBrokerSlConfirmation(). */
export interface VerifyBrokerSlResult {
  /**
   * True when the original order is ACTIVE on Dhan.
   * False when the broker SL was found to be inactive and a replacement was
   * submitted (or when the replacement itself failed).
   */
  active: boolean;
  /**
   * Dhan order ID of the replacement order.
   * Present only when active = false AND a replacement was successfully placed.
   */
  replacementOrderId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SuperOrderSlService {
  private readonly logger = new Logger(SuperOrderSlService.name);

  /**
   * Internal SL registry.
   * Key: positionId (string UUID matching the internal position record).
   */
  private readonly positionSlRegistry = new Map<string, PositionSlRegistryEntry>();

  constructor(
    private readonly dhanApiClient: DhanApiClient,
    private readonly secrets: SecretsService,
    private readonly notificationService: NotificationService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register a broker-side stop-loss order with Dhan for a given position.
   *
   * Places a STOP_LOSS_MARKET order on the exchange so that Dhan acts as a
   * second line of defence even if the CloudEngine is temporarily unreachable.
   * The returned `dhanOrderId` is stored in `positionSlRegistry`; callers
   * should schedule `verifyBrokerSlConfirmation()` after SL_CONFIRMATION_TIMEOUT_MS
   * (5 seconds) to confirm the order reached the exchange.
   *
   * Requirement 12.3
   *
   * @param positionId        Internal CloudEngine position UUID.
   * @param instrumentId      Dhan security ID of the instrument.
   * @param slPrice           Stop-loss trigger price (INR).
   * @param direction         LONG or SHORT — determines transaction type.
   * @param quantity          Number of units/lots to sell/buy on SL trigger.
   * @param exchangeSegment   Exchange segment (default NSE_FNO for F&O).
   * @param productType       Dhan product type (default INTRADAY).
   */
  async registerBrokerSl(
    positionId: string,
    instrumentId: string,
    slPrice: number,
    direction: PositionDirection,
    quantity: number,
    exchangeSegment: DhanExchangeSegment = 'NSE_FNO',
    productType: DhanProductType = 'INTRADAY',
  ): Promise<RegisterBrokerSlResult> {
    const clientId = await this.secrets.get('DHAN_CLIENT_ID');

    // For a LONG position the SL exits via a SELL; SHORT exits via a BUY.
    const transactionType = direction === 'LONG' ? 'SELL' : 'BUY';

    try {
      const response = await this.dhanApiClient.placeOrder({
        dhanClientId: clientId,
        correlationId: `sl-${positionId.slice(0, 8)}-${uuidv4().slice(0, 8)}`,
        transactionType,
        exchangeSegment,
        productType,
        orderType: 'STOP_LOSS_MARKET',
        validity: 'DAY',
        securityId: instrumentId,
        quantity,
        triggerPrice: slPrice,
      });

      const entry: PositionSlRegistryEntry = {
        dhanOrderId: response.orderId,
        registeredAt: new Date(),
        confirmed: false,
        slPrice,
        instrumentId,
        direction,
        quantity,
        exchangeSegment,
        productType,
      };

      this.positionSlRegistry.set(positionId, entry);

      this.logger.log(
        `Broker SL registered for positionId=${positionId} ` +
          `dhanOrderId=${response.orderId} slPrice=${slPrice}`,
      );

      return { success: true, dhanOrderId: response.orderId };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Failed to register broker SL for positionId=${positionId}: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Verify the broker-side SL is active on Dhan.
   *
   * Should be called after SL_CONFIRMATION_TIMEOUT_MS (5 seconds) has elapsed
   * since registerBrokerSl().  Checks the Dhan orderbook for the registered
   * orderId:
   *
   *   - Found in TRANSIT / PENDING → mark `confirmed = true`, return { active: true }.
   *   - Not found, or in CANCELLED / REJECTED / EXPIRED → broker SL is inactive;
   *     submit a replacement STOP_LOSS_MARKET order and return
   *     { active: false, replacementOrderId }.
   *
   * Requirements: 12.3, 12.5
   *
   * @param positionId  Internal CloudEngine position UUID.
   */
  async verifyBrokerSlConfirmation(positionId: string): Promise<VerifyBrokerSlResult> {
    const entry = this.positionSlRegistry.get(positionId);

    if (!entry) {
      this.logger.warn(
        `verifyBrokerSlConfirmation called for positionId=${positionId} ` +
          `which has no registry entry — treating broker SL as inactive`,
      );
      return { active: false };
    }

    try {
      const orderbook = await this.dhanApiClient.getOrderbook();
      const order = orderbook.find((o) => o.orderId === entry.dhanOrderId);

      if (order && ACTIVE_SL_STATUSES.has(order.orderStatus)) {
        // SL order is resting at the exchange — confirmation received.
        entry.confirmed = true;
        this.positionSlRegistry.set(positionId, entry);

        this.logger.log(
          `Broker SL confirmed for positionId=${positionId} ` +
            `orderId=${entry.dhanOrderId} status=${order.orderStatus}`,
        );
        return { active: true };
      }

      // Broker SL is not active — log, then submit a replacement.
      const reason = order
        ? `order status is ${order.orderStatus}`
        : `order ${entry.dhanOrderId} not found in orderbook`;

      this.logger.warn(
        `Broker SL inactive for positionId=${positionId} — submitting replacement (${reason})`,
      );

      return this.submitReplacementSl(positionId, entry);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Failed to verify broker SL for positionId=${positionId}: ${message}`);
      return { active: false };
    }
  }

  /**
   * Returns the current registry entry for a position, or undefined when the
   * position has no registered broker SL.
   *
   * @param positionId  Internal CloudEngine position UUID.
   */
  getBrokerSlStatus(positionId: string): PositionSlRegistryEntry | undefined {
    return this.positionSlRegistry.get(positionId);
  }

  /**
   * Remove the registry entry for a closed position.
   *
   * Should be called whenever a position is fully exited so that the internal
   * map does not grow unboundedly over a trading session.
   *
   * @param positionId  Internal CloudEngine position UUID.
   */
  removeBrokerSl(positionId: string): void {
    const existed = this.positionSlRegistry.delete(positionId);
    if (existed) {
      this.logger.log(`Broker SL registry entry removed for positionId=${positionId}`);
    } else {
      this.logger.debug(`removeBrokerSl: no entry found for positionId=${positionId} — no-op`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Place a replacement STOP_LOSS_MARKET order using the context captured at
   * registration time.  Updates the registry entry with the new Dhan order ID
   * so subsequent verification calls target the replacement order.
   *
   * Requirement 12.5
   */
  private async submitReplacementSl(
    positionId: string,
    entry: PositionSlRegistryEntry,
  ): Promise<VerifyBrokerSlResult> {
    const clientId = await this.secrets.get('DHAN_CLIENT_ID');
    const transactionType = entry.direction === 'LONG' ? 'SELL' : 'BUY';

    try {
      const replacementResponse = await this.dhanApiClient.placeOrder({
        dhanClientId: clientId,
        correlationId: `sl-repl-${positionId.slice(0, 8)}-${uuidv4().slice(0, 8)}`,
        transactionType,
        exchangeSegment: entry.exchangeSegment,
        productType: entry.productType,
        orderType: 'STOP_LOSS_MARKET',
        validity: 'DAY',
        securityId: entry.instrumentId,
        quantity: entry.quantity,
        triggerPrice: entry.slPrice,
      });

      // Overwrite registry entry with replacement order details.
      const updatedEntry: PositionSlRegistryEntry = {
        ...entry,
        dhanOrderId: replacementResponse.orderId,
        registeredAt: new Date(),
        confirmed: false,
      };
      this.positionSlRegistry.set(positionId, updatedEntry);

      this.logger.log(
        `Replacement SL order submitted for positionId=${positionId} ` +
          `newOrderId=${replacementResponse.orderId} slPrice=${entry.slPrice}`,
      );

      return { active: false, replacementOrderId: replacementResponse.orderId };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Failed to submit replacement SL for positionId=${positionId}: ${message}`);
      return { active: false };
    }
  }
}
