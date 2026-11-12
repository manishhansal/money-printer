/**
 * paper-trading.service.ts
 *
 * PaperTradingService — fully isolated paper-trading simulation engine.
 *
 * Isolation guarantees (Requirement 10.1):
 *  - ALL database writes go exclusively to `paper_orders`, `paper_executions`,
 *    `paper_positions`, and `paper_trades` tables. The live `orders`,
 *    `executions`, `positions`, and `trades` tables are NEVER accessed.
 *  - ALL Redis writes use the `paper:*` key namespace (e.g. `paper:portfolio:balance`,
 *    `paper:orders:{id}`). Live engine Redis keys are NEVER written.
 *  - ALL Redis pub/sub events are published to `events:paper:*` channels
 *    (e.g. `events:paper:fill`, `events:paper:order`). Live channels such as
 *    `events:fill` are NEVER published to.
 *  - No LiveEngine services (LiveTradingService, ExecutionService, etc.) are
 *    imported or injected.
 *
 * Key responsibilities:
 *  1. Accept paper orders from SignalScoringModule / callers.
 *  2. Look up current bid/ask prices from the shared market data Redis cache
 *     (`mkt:snapshot:{instrumentId}`) — read-only access to shared infrastructure.
 *  3. Apply configurable slippage (fixed-rupee, percentage, market-impact).
 *  4. Evaluate configurable rejection probability for realistic simulation.
 *  5. Simulate execution latency before recording fills.
 *  6. Record fills in `paper_executions` and update `paper_positions`.
 *  7. Close positions when exit orders reduce quantity to zero; record
 *     completed trades in `paper_trades` with full P&L breakdown.
 *  8. Update `paper:portfolio:balance` in Redis after every closed trade.
 *  9. Publish fill and trade events to `events:paper:*` Redis channels.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PaperOrder } from '../../database/entities/paper-orders.entity';
import { PaperExecution } from '../../database/entities/paper-executions.entity';
import { PaperPosition } from '../../database/entities/paper-positions.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { UserSettings } from '../../database/entities/user-settings.entity';
import { Instruments } from '../../database/entities/instruments.entity';

import { RedisService } from '../redis/redis.service';
import { MarketSnapshot } from '../market-data/market-data.types';
import { TradingChargesService } from '../charges/trading-charges.service';

import {
  PAPER_PORTFOLIO_BALANCE_KEY,
  PAPER_FILL_EVENT_CHANNEL,
  PAPER_ORDER_EVENT_CHANNEL,
  PAPER_TRADE_EVENT_CHANNEL,
  paperOrderKey,
  paperOrderIdempotencyKey,
  paperPositionKey,
  PaperOrderRequest,
  PaperOrderResult,
  PaperSlippageConfig,
  PaperLatencyConfig,
  PaperFillEventPayload,
  PaperOrderEventPayload,
  PaperTradeEventPayload,
} from './paper-trading.types';

/** TTL in seconds for paper order idempotency keys stored in Redis (5 minutes). */
const PAPER_IDEMPOTENCY_TTL_SECONDS = 300;

/** TTL in seconds for paper order/position snapshots in Redis. */
const PAPER_ORDER_SNAPSHOT_TTL_SECONDS = 3600; // 1 hour

/** Redis key prefix for market data snapshots (read-only, written by MarketDataCacheService). */
const MARKET_SNAPSHOT_KEY_PREFIX = 'mkt:snapshot:';

/**
 * Default latency configuration: uniform distribution with mean 200 ms.
 * Requirement 10.9: zero-latency instantaneous fills SHALL NOT be the default.
 */
const DEFAULT_LATENCY_CONFIG: PaperLatencyConfig = {
  distribution: 'uniform',
  meanMs: 200,
};

/**
 * Default slippage configuration: fixed-rupee with 0.00 rupees.
 * Requirement 10.5.
 */
const DEFAULT_SLIPPAGE_CONFIG: PaperSlippageConfig = {
  model: 'fixed_rupee',
  fixedRupee: 0.0,
};

/** Default rejection probability — no random rejection. Requirement 10.7. */
const DEFAULT_REJECTION_PROBABILITY = 0.0;

/** NestJS event emitted when a paper trade is closed. PipelineWiringService handles this. */
export const PAPER_TRADE_CLOSED_EVENT = 'paper.trade.closed';

/** Payload for PAPER_TRADE_CLOSED_EVENT. */
export interface PaperTradeClosedPayload {
  engine: 'PAPER';
  netPnl: string;
  tradeId: string;
}

/** Starting capital for a fresh paper portfolio (INR). */
export const PAPER_STARTING_CAPITAL = '1000000.00'; // ₹10,00,000 (10 lakhs)

/** Payload for PAPER_TRADE_CLOSED_EVENT. */
export interface PaperTradeClosedPayload {
  engine: 'PAPER';
  netPnl: string; // e.g. "-150.00" or "+360.40"
  tradeId: string;
}

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);

  constructor(
    @InjectRepository(PaperOrder)
    private readonly paperOrdersRepo: Repository<PaperOrder>,

    @InjectRepository(PaperExecution)
    private readonly paperExecutionsRepo: Repository<PaperExecution>,

    @InjectRepository(PaperPosition)
    private readonly paperPositionsRepo: Repository<PaperPosition>,

    @InjectRepository(PaperTrade)
    private readonly paperTradesRepo: Repository<PaperTrade>,

    // ── RedisService (global) — paper: namespace writes only ─────────────────
    // This is the ONLY non-charges service injected here. No LiveEngine services.
    private readonly redisService: RedisService,

    // ── TradingChargesService — single source of truth for NSE F&O costs ─────
    private readonly chargesService: TradingChargesService,

    // ── UserSettings — paper starting capital is read from DB, not hardcoded ──
    @InjectRepository(UserSettings)
    private readonly userSettingsRepo: Repository<UserSettings>,

    // ── EventEmitter2 — emits PAPER_TRADE_CLOSED_EVENT for DailyLossMachine ──
    private readonly eventEmitter: EventEmitter2,

    // ── Instruments — for securityId lookup in PnL update cron ───────────────
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  /** In-memory cache: instrument UUID → Dhan securityId for fast PnL lookups. */
  private readonly securityIdCache = new Map<string, string>();

  // ─────────────────────────────────────────────────────────────────────────
  // Paper Position PnL Monitoring — cron-based, every 15 seconds
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Update unrealized PnL for all open paper positions every 15 seconds.
   *
   * For each open position:
   *  1. Look up the instrument's Dhan securityId (cached in memory).
   *  2. Read the latest LTP from Redis `mkt:snapshot:{securityId}`.
   *  3. Compute PnL: (LTP - entryPrice) × qty for LONG, reversed for SHORT.
   *  4. Persist unrealized_pnl, MFE, MAE to DB.
   *  5. Check SL/target — close the position immediately if breached.
   *
   * Requirements: Paper PnL tracking
   */
  @Cron('*/15 * * * * *', { timeZone: 'Asia/Kolkata' })
  async updatePaperPositionPnl(): Promise<void> {
    const openPositions = await this.paperPositionsRepo.find({ where: { is_open: true } });
    if (openPositions.length === 0) return;

    for (const pos of openPositions) {
      try {
        // Resolve securityId from cache or DB
        let securityId = this.securityIdCache.get(pos.instrument_id);
        if (!securityId) {
          const instr = await this.instrumentsRepo.findOne({
            where: { id: pos.instrument_id },
            select: { securityId: true },
          });
          if (!instr) continue;
          securityId = instr.securityId;
          this.securityIdCache.set(pos.instrument_id, securityId);
        }

        // Get current LTP from Redis
        const raw = await this.redisService.get(`mkt:snapshot:${securityId}`);
        if (!raw) continue;
        const ltp = parseFloat((JSON.parse(raw) as { ltp: string }).ltp);
        if (!ltp || ltp <= 0) continue;

        // Compute PnL
        const entryPrice = parseFloat(pos.average_entry_price);
        const qty = pos.quantity;
        const pnl = pos.direction === 'LONG' ? (ltp - entryPrice) * qty : (entryPrice - ltp) * qty;
        const mfe = Math.max(parseFloat(pos.mfe), pnl);
        const mae = Math.min(parseFloat(pos.mae), pnl);

        // Persist to DB
        await this.paperPositionsRepo.update(pos.id, {
          unrealized_pnl: pnl.toFixed(2),
          mfe: mfe.toFixed(2),
          mae: mae.toFixed(2),
        });

        // Check SL hit
        if (pos.current_sl) {
          const sl = parseFloat(pos.current_sl);
          const slHit = pos.direction === 'LONG' ? ltp <= sl : ltp >= sl;
          if (slHit) {
            this.logger.log(
              `[PaperMonitor] SL hit — pos=${pos.id.slice(0, 8)} ltp=₹${ltp} sl=₹${sl}`,
            );
            await this.forcePaperClose(pos, ltp, 'SL_HIT');
            continue;
          }
        }

        // Check target hit
        if (pos.target_price) {
          const target = parseFloat(pos.target_price);
          const targetHit = pos.direction === 'LONG' ? ltp >= target : ltp <= target;
          if (targetHit) {
            this.logger.log(
              `[PaperMonitor] Target hit — pos=${pos.id.slice(0, 8)} ltp=₹${ltp} target=₹${target}`,
            );
            await this.forcePaperClose(pos, ltp, 'TARGET_HIT');
          }
        }
      } catch (err) {
        this.logger.debug(
          `[PaperMonitor] Error updating position ${pos.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * EOD mandatory square-off at 15:25 IST — close all open paper positions
   * at the last available market price.
   *
   * Fires 5 minutes before mandatory exchange close to ensure all paper
   * positions are closed with a known price before data stops flowing.
   */
  @Cron('25 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async eodSquareOff(): Promise<void> {
    const openPositions = await this.paperPositionsRepo.find({ where: { is_open: true } });
    if (openPositions.length === 0) {
      this.logger.log('[PaperEngine] EOD 15:25: no open positions to square off');
      return;
    }

    this.logger.log(
      `[PaperEngine] EOD 15:25 IST — force-closing ${openPositions.length} paper position(s)`,
    );

    for (const pos of openPositions) {
      try {
        let ltp = parseFloat(pos.average_entry_price); // fallback to entry price
        const securityId = this.securityIdCache.get(pos.instrument_id);
        if (securityId) {
          const raw = await this.redisService.get(`mkt:snapshot:${securityId}`);
          if (raw) {
            const parsed = parseFloat((JSON.parse(raw) as { ltp: string }).ltp);
            if (parsed > 0) ltp = parsed;
          }
        }
        await this.forcePaperClose(pos, ltp, 'EOD_MANDATORY_EXIT');
      } catch (err) {
        this.logger.error(
          `[PaperEngine] EOD close failed for pos=${pos.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Force-close a paper position at the given price without going through the
   * full order simulation pipeline. Used for SL hit, target hit, and EOD square-off.
   */
  private async forcePaperClose(
    pos: PaperPosition,
    exitPrice: number,
    reason: string,
  ): Promise<void> {
    const entryPrice = parseFloat(pos.average_entry_price);
    const costs = this.chargesService.calculate(entryPrice, exitPrice, pos.quantity);
    const grossPnl =
      pos.direction === 'LONG'
        ? (exitPrice - entryPrice) * pos.quantity
        : (entryPrice - exitPrice) * pos.quantity;
    const netPnl = grossPnl - costs.total;
    const now = new Date();

    // Close position
    await this.paperPositionsRepo.update(pos.id, {
      is_open: false,
      closed_at: now,
      unrealized_pnl: '0',
    });

    // Record PaperTrade
    const trade = this.paperTradesRepo.create({
      engine: 'PAPER',
      position_id: pos.id,
      instrument_id: pos.instrument_id,
      strategy_id: null,
      signal_id: pos.signal_id,
      direction: pos.direction as 'LONG' | 'SHORT',
      quantity: pos.quantity,
      lot_size: 1,
      entry_price: entryPrice.toFixed(2),
      exit_price: exitPrice.toFixed(2),
      entry_time: pos.opened_at,
      exit_time: now,
      mfe: pos.mfe,
      mae: pos.mae,
      gross_pnl: grossPnl.toFixed(2),
      brokerage: costs.brokerage.toFixed(4),
      stt: costs.stt.toFixed(4),
      exchange_charges: costs.exchangeCharges.toFixed(4),
      gst: costs.gst.toFixed(4),
      sebi_charges: costs.sebiCharges.toFixed(4),
      stamp_duty: costs.stampDuty.toFixed(4),
      net_pnl: netPnl.toFixed(2),
      exit_reason: reason,
      execution_slippage: '0',
      signal_score: null,
      dhan_entry_order_id: null,
      dhan_exit_order_id: null,
      qcr: null,
      exit_classification: null,
      execution_quality: null,
    });
    const savedTrade = await this.paperTradesRepo.save(trade);

    // Update portfolio balance
    const currentBalance = parseFloat(await this.getPortfolioBalance());
    const newBalance = (currentBalance + netPnl).toFixed(2);
    await this.redisService.set(PAPER_PORTFOLIO_BALANCE_KEY, newBalance);

    // Emit for DailyLossStateMachine
    this.eventEmitter.emit(PAPER_TRADE_CLOSED_EVENT, {
      engine: 'PAPER',
      netPnl: savedTrade.net_pnl,
      tradeId: savedTrade.id,
    });

    // Evict from securityId cache so position is no longer monitored
    this.securityIdCache.delete(pos.instrument_id);

    this.logger.log(
      `[PaperEngine] Closed pos=${pos.id.slice(0, 8)} reason=${reason} ` +
        `exit=₹${exitPrice.toFixed(2)} netPnL=₹${netPnl.toFixed(2)} balance=₹${newBalance}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Submit a paper order for simulated execution.
   *
   * Flow:
   *  1. Idempotency check — reject immediately if the key was already processed.
   *  2. Persist a PaperOrder record (status = 'submitted').
   *  3. Publish `events:paper:order` (status = 'submitted').
   *  4. Look up current market snapshot from `mkt:snapshot:{instrumentId}`.
   *  5. If snapshot unavailable → reject with "market data unavailable".
   *  6. Evaluate rejection probability — randomly reject if activated.
   *  7. Simulate execution latency.
   *  8. Compute fill price with slippage applied.
   *  9. Persist PaperExecution record.
   * 10. Update (or create) PaperPosition.
   * 11. If position is fully closed → persist PaperTrade, update portfolio balance.
   * 12. Store order snapshot under `paper:orders:{id}`.
   * 13. Publish `events:paper:fill` with full fill payload.
   * 14. Return PaperOrderResult.
   *
   * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 10.8, 10.9
   */
  async submitPaperOrder(request: PaperOrderRequest): Promise<PaperOrderResult> {
    const {
      idempotencyKey,
      instrumentId,
      strategyId,
      signalId,
      transactionType,
      orderType,
      quantity,
      lotSize = 1,
      price,
      signalScore,
      stopLossPrice,
      targetPrice,
      slippageConfig = DEFAULT_SLIPPAGE_CONFIG,
      rejectionProbability = DEFAULT_REJECTION_PROBABILITY,
      latencyConfig = DEFAULT_LATENCY_CONFIG,
    } = request;

    // ── Lot-size invariant check ──────────────────────────────────────────────
    // quantity MUST be in units (lots × lotSize).  When lotSize > 1 this guards
    // against accidental lots-as-units submissions (e.g. 1 lot of NIFTY sent as
    // quantity=1 instead of quantity=75).
    if (lotSize > 1 && quantity % lotSize !== 0) {
      this.logger.error(
        `[PaperOrder] Rejected: quantity=${quantity} is not a multiple of ` +
          `lot_size=${lotSize} for instrument=${instrumentId}. ` +
          `quantity must equal selectedLots × lotSize.`,
      );
      return {
        orderId: `rejected-lot-align-${Date.now()}`,
        status: 'rejected',
        rejectionReason:
          `Quantity ${quantity} is not a valid multiple of lot size ${lotSize} ` +
          `— quantity must equal selectedLots × lotSize`,
      };
    }

    // ── Step 1: Idempotency check ────────────────────────────────────────────
    const idempotencyRedisKey = paperOrderIdempotencyKey(idempotencyKey);
    const existingOrderId = await this.redisService.get(idempotencyRedisKey);
    if (existingOrderId) {
      this.logger.warn(
        `[PaperOrder] Duplicate idempotency key "${idempotencyKey}" — ` +
          `returning existing orderId=${existingOrderId}`,
      );
      return {
        orderId: existingOrderId,
        status: 'rejected',
        rejectionReason: 'duplicate idempotency key',
      };
    }

    // ── Options-buying-only guard ─────────────────────────────────────────────
    // The paper engine only supports LONG (buy) entries. A SELL order is only
    // valid as a closing transaction for an existing LONG position.
    if (transactionType === 'SELL') {
      const hasOpenPosition = await this.paperPositionsRepo.findOne({
        where: { instrument_id: instrumentId, is_open: true },
      });
      if (!hasOpenPosition) {
        this.logger.warn(
          `[PaperOrder] Rejected SHORT entry for ${instrumentId} — ` +
            `paper engine is configured for options-buying only.`,
        );
        return {
          orderId: `rejected-short-${Date.now()}`,
          status: 'rejected',
          rejectionReason: 'short selling is disabled — options buying only',
          fillPrice: undefined,
          fillTimestamp: undefined,
          simulatedLatencyMs: undefined,
          slippageApplied: undefined,
        };
      }
    }

    // ── Step 2: Persist PaperOrder (status = 'submitted') ───────────────────
    const paperOrder = this.paperOrdersRepo.create({
      idempotency_key: idempotencyKey,
      engine: 'PAPER',
      instrument_id: instrumentId,
      signal_id: signalId ?? null,
      order_type: orderType,
      transaction_type: transactionType,
      quantity,
      price: price ?? null,
      trigger_price: null,
      dhan_order_id: null,
      dhan_correlation_id: null,
      status: 'submitted',
      submitted_at: new Date(),
      filled_quantity: 0,
      average_fill_price: null,
    });

    const savedOrder = await this.paperOrdersRepo.save(paperOrder);
    const orderId = savedOrder.id;

    // Store idempotency key → orderId mapping with TTL
    await this.redisService.set(idempotencyRedisKey, orderId, PAPER_IDEMPOTENCY_TTL_SECONDS);

    this.logger.log(`[PaperOrder] Created paper order ${orderId} for instrument ${instrumentId}`);

    // ── Step 3: Publish 'submitted' order event ──────────────────────────────
    await this.publishOrderEvent({
      orderId,
      instrumentId,
      status: 'submitted',
      timestamp: new Date().toISOString(),
    });

    // ── Step 4: Fetch market snapshot from Redis ─────────────────────────────
    // Use marketDataKey (Dhan securityId) if supplied, otherwise fall back to
    // instrumentId (DB UUID). Redis snapshots are keyed by securityId.
    const snapshotKey = request.marketDataKey ?? instrumentId;
    const snapshot = await this.fetchMarketSnapshot(snapshotKey);

    if (!snapshot) {
      // Requirement 10.4: reject with "market data unavailable"
      await this.rejectOrder(savedOrder, 'market data unavailable');
      this.logger.warn(
        `[PaperOrder] Rejected order ${orderId} — market data unavailable for ${instrumentId}`,
      );
      return {
        orderId,
        status: 'rejected',
        rejectionReason: 'market data unavailable',
      };
    }

    // ── Step 5: Evaluate rejection probability ───────────────────────────────
    // Requirement 10.7: configurable 0.00–1.00 rejection probability
    if (rejectionProbability > 0 && Math.random() < rejectionProbability) {
      await this.rejectOrder(savedOrder, 'simulated rejection');
      this.logger.log(
        `[PaperOrder] Randomly rejected order ${orderId} ` +
          `(probability=${rejectionProbability.toFixed(4)})`,
      );
      // Requirement 10.8: no costs deducted, no P&L change
      return {
        orderId,
        status: 'rejected',
        rejectionReason: 'simulated rejection',
      };
    }

    // ── Step 6: Simulate execution latency ───────────────────────────────────
    // Requirement 10.9
    const simulatedLatencyMs = this.sampleLatency(latencyConfig);
    await this.sleep(simulatedLatencyMs);

    // ── Step 7: Compute fill price with slippage ─────────────────────────────
    // Requirement 10.2: BUY → best ask; Requirement 10.3: SELL → best bid
    const referencePrice = this.selectReferencePrice(transactionType, snapshot);

    if (referencePrice === null) {
      await this.rejectOrder(savedOrder, 'market data unavailable');
      this.logger.warn(
        `[PaperOrder] Rejected order ${orderId} — ` +
          `bid/ask unavailable for ${transactionType} in snapshot`,
      );
      return {
        orderId,
        status: 'rejected',
        rejectionReason: 'market data unavailable',
      };
    }

    const { fillPrice, slippageAmount } = this.applySlippage(
      referencePrice,
      transactionType,
      quantity,
      slippageConfig,
    );

    // ── Simulate partial fill (realistic) ────────────────────────────────────
    // With low probability (5% default when not explicitly configured), simulate
    // a partial fill where only 50-80% of the order fills initially.
    // This improves paper trading realism for large orders near the spread.
    const isLargeOrder = lotSize > 1 && quantity > lotSize;
    const partialFillProbability = isLargeOrder ? 0.15 : 0.0; // 15% for multi-lot orders
    const isPartialFill = partialFillProbability > 0 && Math.random() < partialFillProbability;
    const actualFillQty = isPartialFill
      ? Math.max(lotSize, Math.floor(quantity * (0.5 + Math.random() * 0.3))) // 50-80%
      : quantity;

    const fillTimestamp = new Date();

    // ── Step 8: Persist PaperExecution ───────────────────────────────────────
    const paperExecution = this.paperExecutionsRepo.create({
      order_id: orderId,
      engine: 'PAPER',
      dhan_trade_id: null,
      fill_price: fillPrice.toFixed(2),
      fill_quantity: actualFillQty, // actual fill (may be partial)
      fill_timestamp: fillTimestamp,
      slippage: slippageAmount.toFixed(4),
    });
    const savedExecution = await this.paperExecutionsRepo.save(paperExecution);

    // ── Step 9: Update PaperOrder to 'complete' ───────────────────────────────
    savedOrder.status = actualFillQty < quantity ? 'partial' : 'complete';
    savedOrder.filled_quantity = actualFillQty;
    savedOrder.average_fill_price = fillPrice.toFixed(2);
    await this.paperOrdersRepo.save(savedOrder);

    // ── Step 10: Update or create PaperPosition ───────────────────────────────
    const { position, tradeClosed, closedTrade } = await this.updatePosition(
      instrumentId,
      strategyId ?? null,
      signalId ?? null,
      transactionType,
      actualFillQty,
      fillPrice,
      fillTimestamp,
      slippageAmount,
      lotSize,
      signalScore,
      stopLossPrice,
      targetPrice,
    );

    // ── Step 11: Update portfolio balance + emit trade-closed event ──────────
    let portfolioBalance = await this.getPortfolioBalance();
    if (tradeClosed && closedTrade) {
      const netPnl = parseFloat(closedTrade.net_pnl);
      const currentBalance = parseFloat(portfolioBalance);
      portfolioBalance = (currentBalance + netPnl).toFixed(2);
      await this.redisService.set(PAPER_PORTFOLIO_BALANCE_KEY, portfolioBalance);

      // Emit trade-closed event so DailyLossStateMachineService.onTradeClosed()
      // can count losing trades and potentially activate TWO_LOSS_LOCKOUT.
      this.eventEmitter.emit(PAPER_TRADE_CLOSED_EVENT, {
        engine: 'PAPER',
        netPnl: closedTrade.net_pnl,
        tradeId: closedTrade.id,
      });

      this.logger.log(
        `[PaperTrade] Trade ${closedTrade.id} closed. Net P&L=${closedTrade.net_pnl}. ` +
          `Portfolio balance updated to ${portfolioBalance}`,
      );

      // Publish trade event to events:paper:trade
      await this.publishTradeEvent({
        tradeId: closedTrade.id,
        positionId: position.id,
        instrumentId,
        direction: position.direction,
        entryPrice: closedTrade.entry_price,
        exitPrice: closedTrade.exit_price,
        quantity: closedTrade.quantity,
        grossPnl: closedTrade.gross_pnl,
        netPnl: closedTrade.net_pnl,
        exitReason: closedTrade.exit_reason,
        entryTime: closedTrade.entry_time.toISOString(),
        exitTime: closedTrade.exit_time.toISOString(),
        portfolioBalance,
      });
    }

    // ── Step 12: Store order snapshot in Redis under paper:orders:{id} ────────
    const orderSnapshot = {
      orderId,
      status: 'complete',
      instrumentId,
      transactionType,
      quantity,
      fillPrice: fillPrice.toFixed(2),
      fillTimestamp: fillTimestamp.toISOString(),
      executionId: savedExecution.id,
      positionId: position.id,
      portfolioBalance,
    };
    await this.redisService.set(
      paperOrderKey(orderId),
      JSON.stringify(orderSnapshot),
      PAPER_ORDER_SNAPSHOT_TTL_SECONDS,
    );

    // Store position snapshot under paper:positions:{id}
    await this.redisService.set(
      paperPositionKey(position.id),
      JSON.stringify({
        positionId: position.id,
        instrumentId: position.instrument_id,
        direction: position.direction,
        quantity: position.quantity,
        averageEntryPrice: position.average_entry_price,
        isOpen: position.is_open,
        unrealizedPnl: position.unrealized_pnl,
      }),
      PAPER_ORDER_SNAPSHOT_TTL_SECONDS,
    );

    // ── Step 13: Publish fill event to events:paper:fill ─────────────────────
    await this.publishFillEvent({
      orderId,
      executionId: savedExecution.id,
      instrumentId,
      transactionType,
      fillPrice: fillPrice.toFixed(2),
      fillQuantity: quantity,
      slippage: slippageAmount.toFixed(4),
      fillTimestamp: fillTimestamp.toISOString(),
      positionId: position.id,
      portfolioBalance,
    });

    this.logger.log(
      `[PaperOrder] Filled: orderId=${orderId}, executionId=${savedExecution.id}, ` +
        `${transactionType} ${quantity} @ ${fillPrice.toFixed(2)}, ` +
        `latency=${simulatedLatencyMs}ms, slippage=${slippageAmount.toFixed(4)}`,
    );

    return {
      orderId,
      status: 'complete',
      executionId: savedExecution.id,
      fillPrice: fillPrice.toFixed(2),
      fillTimestamp,
      simulatedLatencyMs,
      slippageApplied: slippageAmount.toFixed(4),
    };
  }

  /**
   * Returns the current paper portfolio balance from Redis.
   * Lazily initialises from UserSettings.paperStartingCapital (DB-configured).
   * Falls back to ₹50,000 if no UserSettings row exists.
   *
   * Key: `paper:portfolio:balance`
   */
  async getPortfolioBalance(): Promise<string> {
    const stored = await this.redisService.get(PAPER_PORTFOLIO_BALANCE_KEY);
    if (!stored) {
      const startingCapital = await this.getPaperStartingCapital();
      await this.redisService.set(PAPER_PORTFOLIO_BALANCE_KEY, startingCapital);
      return startingCapital;
    }
    return stored;
  }

  /**
   * Reads paperStartingCapital from UserSettings DB row.
   * Falls back to PAPER_STARTING_CAPITAL constant if no settings row exists.
   */
  async getPaperStartingCapital(): Promise<string> {
    const settings = await this.userSettingsRepo.findOne({ where: {} });
    return settings?.paperStartingCapital ?? PAPER_STARTING_CAPITAL;
  }

  /**
   * Explicitly sets the paper portfolio starting balance.
   * Useful for resetting a paper trading session.
   *
   * Key: `paper:portfolio:balance`
   */
  async initializePortfolioBalance(startingCapital: string): Promise<void> {
    await this.redisService.set(PAPER_PORTFOLIO_BALANCE_KEY, startingCapital);
    this.logger.log(`[PaperPortfolio] Balance initialised to ${startingCapital}`);
  }

  /**
   * Returns all currently open paper positions from the database.
   * Uses `paper_positions` table exclusively.
   */
  async getOpenPaperPositions(): Promise<PaperPosition[]> {
    return this.paperPositionsRepo.find({ where: { is_open: true } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetches a MarketSnapshot from the Redis market data cache.
   *
   * Key: `mkt:snapshot:{instrumentId}` (written by MarketDataCacheService).
   * This is a READ-ONLY access to shared infrastructure data (market prices).
   * The PaperEngine never WRITES to `mkt:*` keys.
   *
   * Returns null if the key is absent or has expired (TTL = 2 s).
   */
  private async fetchMarketSnapshot(instrumentId: string): Promise<MarketSnapshot | null> {
    try {
      const raw = await this.redisService.get(`${MARKET_SNAPSHOT_KEY_PREFIX}${instrumentId}`);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as MarketSnapshot;
    } catch (err) {
      this.logger.error(
        `[PaperOrder] Failed to fetch market snapshot for ${instrumentId}: ` +
          `${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Selects the reference price for a simulated fill.
   *
   * Requirements 10.2 & 10.3:
   *  - BUY  → best ask price (askPrice)
   *  - SELL → best bid price (bidPrice)
   *
   * Returns null if the required price field is unavailable in the snapshot.
   */
  private selectReferencePrice(
    transactionType: 'BUY' | 'SELL',
    snapshot: MarketSnapshot,
  ): number | null {
    const raw = transactionType === 'BUY' ? snapshot.askPrice : snapshot.bidPrice;
    if (!raw) {
      return null;
    }
    const parsed = parseFloat(raw);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Applies the configured slippage model to compute the actual fill price.
   *
   * Slippage is applied adversely:
   *  - BUY  → fill_price = reference_price + slippage (you pay more)
   *  - SELL → fill_price = reference_price − slippage (you receive less)
   *
   * Requirement 10.5.
   */
  private applySlippage(
    referencePrice: number,
    transactionType: 'BUY' | 'SELL',
    quantity: number,
    config: PaperSlippageConfig,
  ): { fillPrice: number; slippageAmount: number } {
    let slippageAmount = 0;

    switch (config.model) {
      case 'fixed_rupee': {
        // Clamp to valid range 0.00 – 50.00
        slippageAmount = Math.min(Math.max(config.fixedRupee ?? 0, 0), 50);
        break;
      }
      case 'percentage': {
        // Clamp to valid range 0.00 – 2.00%
        const pct = Math.min(Math.max(config.percentage ?? 0, 0), 0.02);
        slippageAmount = referencePrice * pct;
        break;
      }
      case 'market_impact': {
        // market_impact_factor × sqrt(quantity) × reference_price / 10000
        const factor = config.marketImpactFactor ?? 0.001;
        slippageAmount = factor * Math.sqrt(quantity) * referencePrice;
        break;
      }
    }

    const fillPrice =
      transactionType === 'BUY' ? referencePrice + slippageAmount : referencePrice - slippageAmount;

    return { fillPrice: Math.max(fillPrice, 0.01), slippageAmount };
  }

  /**
   * Samples a latency value from the configured distribution.
   *
   * Requirement 10.9: uniform, normal, or log-normal with configurable mean
   * between 10 ms and 5000 ms.
   *
   * @returns Latency in milliseconds (integer, >= 0).
   */
  private sampleLatency(config: PaperLatencyConfig): number {
    const mean = Math.min(Math.max(config.meanMs, 10), 5000);

    switch (config.distribution) {
      case 'uniform': {
        // Uniform[0, 2*mean] — expected value = mean
        return Math.floor(Math.random() * 2 * mean);
      }
      case 'normal': {
        // Box-Muller transform to generate a Normal(mean, mean/3) sample
        const u1 = Math.random();
        const u2 = Math.random();
        const stddev = mean / 3;
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return Math.max(0, Math.floor(mean + stddev * z));
      }
      case 'log_normal': {
        // Log-normal with median = mean: mu = ln(mean), sigma = 0.5
        const sigma = 0.5;
        const mu = Math.log(mean);
        const u1 = Math.random();
        const u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return Math.max(0, Math.floor(Math.exp(mu + sigma * z)));
      }
    }
  }

  /**
   * Returns a Promise that resolves after `ms` milliseconds.
   * Used to simulate order execution latency.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Updates or creates a PaperPosition based on the fill.
   *
   * - Entry (BUY on new position → LONG): creates a new PaperPosition.
   * - Exit (SELL on existing LONG): reduces quantity; closes position when qty = 0.
   * - On close: creates a PaperTrade record with full P&L breakdown.
   *
   * Returns the updated/created position, a flag indicating if the trade was
   * closed, and the resulting PaperTrade (if any).
   */
  private async updatePosition(
    instrumentId: string,
    strategyId: string | null,
    signalId: string | null,
    transactionType: 'BUY' | 'SELL',
    quantity: number,
    fillPrice: number,
    fillTimestamp: Date,
    slippageAmount: number,
    lotSize: number,
    signalScore?: number,
    stopLossPrice?: string,
    targetPrice?: string,
  ): Promise<{ position: PaperPosition; tradeClosed: boolean; closedTrade: PaperTrade | null }> {
    // Look for an open position in the same instrument (simplistic: one position per instrument)
    const openPosition = await this.paperPositionsRepo.findOne({
      where: { instrument_id: instrumentId, is_open: true },
    });

    // ── Opening a new position (BUY) ─────────────────────────────────────────
    if (transactionType === 'BUY' && !openPosition) {
      const newPosition = this.paperPositionsRepo.create({
        engine: 'PAPER',
        instrument_id: instrumentId,
        signal_id: signalId,
        direction: 'LONG',
        quantity,
        average_entry_price: fillPrice.toFixed(2),
        // Set SL and target from signal for automatic exit monitoring.
        current_sl: stopLossPrice && parseFloat(stopLossPrice) > 0 ? stopLossPrice : null,
        target_price: targetPrice && parseFloat(targetPrice) > 0 ? targetPrice : null,
        trailing_stop_mechanism: null,
        unrealized_pnl: '0',
        mfe: '0',
        mae: '0',
        opened_at: fillTimestamp,
        closed_at: null,
        is_open: true,
      });
      const savedPosition = await this.paperPositionsRepo.save(newPosition);
      return { position: savedPosition, tradeClosed: false, closedTrade: null };
    }

    // ── Adding to an existing LONG position (scale-in BUY) ───────────────────
    if (transactionType === 'BUY' && openPosition && openPosition.direction === 'LONG') {
      const totalQty = openPosition.quantity + quantity;
      const prevVwap = parseFloat(openPosition.average_entry_price);
      const newVwap = (prevVwap * openPosition.quantity + fillPrice * quantity) / totalQty;

      openPosition.quantity = totalQty;
      openPosition.average_entry_price = newVwap.toFixed(2);
      const savedPosition = await this.paperPositionsRepo.save(openPosition);
      return { position: savedPosition, tradeClosed: false, closedTrade: null };
    }

    // ── Closing / reducing a LONG position (SELL) ────────────────────────────
    if (transactionType === 'SELL' && openPosition && openPosition.direction === 'LONG') {
      const entryPrice = parseFloat(openPosition.average_entry_price);
      const exitQty = Math.min(quantity, openPosition.quantity);
      const remainingQty = openPosition.quantity - exitQty;

      openPosition.quantity = remainingQty;
      openPosition.is_open = remainingQty > 0;
      openPosition.closed_at = remainingQty === 0 ? fillTimestamp : null;
      const savedPosition = await this.paperPositionsRepo.save(openPosition);

      // If fully closed, record the PaperTrade
      if (remainingQty === 0) {
        const costs = this.chargesService.calculate(entryPrice, fillPrice, exitQty);
        const grossPnl = (fillPrice - entryPrice) * exitQty;
        const netPnl = grossPnl - costs.total;

        const paperTrade = this.paperTradesRepo.create({
          engine: 'PAPER',
          position_id: savedPosition.id,
          instrument_id: instrumentId,
          strategy_id: strategyId,
          signal_id: signalId,
          direction: 'LONG',
          quantity: exitQty,
          lot_size: lotSize, // actual exchange lot size, not hardcoded 1
          entry_price: entryPrice.toFixed(2),
          exit_price: fillPrice.toFixed(2),
          entry_time: savedPosition.opened_at,
          exit_time: fillTimestamp,
          mfe: savedPosition.mfe,
          mae: savedPosition.mae,
          gross_pnl: grossPnl.toFixed(2),
          brokerage: costs.brokerage.toFixed(4),
          stt: costs.stt.toFixed(4),
          exchange_charges: costs.exchangeCharges.toFixed(4),
          gst: costs.gst.toFixed(4),
          sebi_charges: costs.sebiCharges.toFixed(4),
          stamp_duty: costs.stampDuty.toFixed(4),
          net_pnl: netPnl.toFixed(2),
          exit_reason: 'MANUAL',
          execution_slippage: (slippageAmount * 2).toFixed(4), // entry + exit
          signal_score: signalScore != null ? signalScore.toFixed(2) : null,
          dhan_entry_order_id: null,
          dhan_exit_order_id: null,
          qcr: null,
          exit_classification: null,
          execution_quality: null,
        });

        const savedTrade = await this.paperTradesRepo.save(paperTrade);
        return { position: savedPosition, tradeClosed: true, closedTrade: savedTrade };
      }

      return { position: savedPosition, tradeClosed: false, closedTrade: null };
    }

    // ── Opening a SHORT position (SELL with no existing position) ─────────────
    if (transactionType === 'SELL' && !openPosition) {
      const newPosition = this.paperPositionsRepo.create({
        engine: 'PAPER',
        instrument_id: instrumentId,
        signal_id: signalId,
        direction: 'SHORT',
        quantity,
        average_entry_price: fillPrice.toFixed(2),
        current_sl: null,
        target_price: null,
        trailing_stop_mechanism: null,
        unrealized_pnl: '0',
        mfe: '0',
        mae: '0',
        opened_at: fillTimestamp,
        closed_at: null,
        is_open: true,
      });
      const savedPosition = await this.paperPositionsRepo.save(newPosition);
      return { position: savedPosition, tradeClosed: false, closedTrade: null };
    }

    // ── Closing a SHORT position (BUY to cover) ───────────────────────────────
    if (transactionType === 'BUY' && openPosition && openPosition.direction === 'SHORT') {
      const entryPrice = parseFloat(openPosition.average_entry_price);
      const exitQty = Math.min(quantity, openPosition.quantity);
      const remainingQty = openPosition.quantity - exitQty;

      openPosition.quantity = remainingQty;
      openPosition.is_open = remainingQty > 0;
      openPosition.closed_at = remainingQty === 0 ? fillTimestamp : null;
      const savedPosition = await this.paperPositionsRepo.save(openPosition);

      if (remainingQty === 0) {
        const costs = this.chargesService.calculate(entryPrice, fillPrice, exitQty);
        // SHORT P&L: entry - exit (positive when price drops)
        const grossPnl = (entryPrice - fillPrice) * exitQty;
        const netPnl = grossPnl - costs.total;

        const paperTrade = this.paperTradesRepo.create({
          engine: 'PAPER',
          position_id: savedPosition.id,
          instrument_id: instrumentId,
          strategy_id: strategyId,
          signal_id: signalId,
          direction: 'SHORT',
          quantity: exitQty,
          lot_size: lotSize, // actual exchange lot size, not hardcoded 1
          entry_price: entryPrice.toFixed(2),
          exit_price: fillPrice.toFixed(2),
          entry_time: savedPosition.opened_at,
          exit_time: fillTimestamp,
          mfe: savedPosition.mfe,
          mae: savedPosition.mae,
          gross_pnl: grossPnl.toFixed(2),
          brokerage: costs.brokerage.toFixed(4),
          stt: costs.stt.toFixed(4),
          exchange_charges: costs.exchangeCharges.toFixed(4),
          gst: costs.gst.toFixed(4),
          sebi_charges: costs.sebiCharges.toFixed(4),
          stamp_duty: costs.stampDuty.toFixed(4),
          net_pnl: netPnl.toFixed(2),
          exit_reason: 'MANUAL',
          execution_slippage: (slippageAmount * 2).toFixed(4),
          signal_score: signalScore != null ? signalScore.toFixed(2) : null,
          dhan_entry_order_id: null,
          dhan_exit_order_id: null,
          qcr: null,
          exit_classification: null,
          execution_quality: null,
        });

        const savedTrade = await this.paperTradesRepo.save(paperTrade);
        return { position: savedPosition, tradeClosed: true, closedTrade: savedTrade };
      }

      return { position: savedPosition, tradeClosed: false, closedTrade: null };
    }

    // Fallback: should not reach here in normal flow; create a neutral position
    this.logger.warn(
      `[PaperOrder] Unhandled position state: transactionType=${transactionType}, ` +
        `openPosition=${openPosition ? openPosition.direction : 'none'}. ` +
        `Creating new LONG position as fallback.`,
    );
    const fallbackPosition = this.paperPositionsRepo.create({
      engine: 'PAPER',
      instrument_id: instrumentId,
      signal_id: signalId,
      direction: transactionType === 'BUY' ? 'LONG' : 'SHORT',
      quantity,
      average_entry_price: fillPrice.toFixed(2),
      current_sl: null,
      target_price: null,
      trailing_stop_mechanism: null,
      unrealized_pnl: '0',
      mfe: '0',
      mae: '0',
      opened_at: fillTimestamp,
      closed_at: null,
      is_open: true,
    });
    const savedFallback = await this.paperPositionsRepo.save(fallbackPosition);
    return { position: savedFallback, tradeClosed: false, closedTrade: null };
  }

  /**
   * Calculates NSE F&O trading costs using the identical formulas applied by
   * the LiveEngine (Requirement 10.6).
   *
   * Assumptions (Dhan F&O intraday pricing, NSE options):
   *  - Brokerage:         ₹20 flat per executed order (both entry and exit).
   *  - STT:               0.05% of sell-side turnover (premium value).
   *  - Exchange charges:  0.053% of total turnover (NSE options).
   *  - GST:               18% on (brokerage + exchange charges).
   *  - SEBI charges:      ₹10 per crore of total turnover.
  /**
   * Marks a PaperOrder as 'rejected' and publishes an order event.
   */
  private async rejectOrder(order: PaperOrder, reason: string): Promise<void> {
    order.status = 'rejected';
    order.rejection_reason = reason;
    await this.paperOrdersRepo.save(order);

    await this.publishOrderEvent({
      orderId: order.id,
      instrumentId: order.instrument_id,
      status: 'rejected',
      rejectionReason: reason,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Publishes a fill event to the `events:paper:fill` Redis channel.
   * Requirement 10.1: channel name is `events:paper:fill`, NOT `events:fill`.
   */
  private async publishFillEvent(payload: PaperFillEventPayload): Promise<void> {
    try {
      await this.redisService.publish(PAPER_FILL_EVENT_CHANNEL, JSON.stringify(payload));
    } catch (err) {
      this.logger.error(
        `[PaperEvents] Failed to publish fill event to ${PAPER_FILL_EVENT_CHANNEL}: ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Publishes an order status event to the `events:paper:order` Redis channel.
   */
  private async publishOrderEvent(payload: PaperOrderEventPayload): Promise<void> {
    try {
      await this.redisService.publish(PAPER_ORDER_EVENT_CHANNEL, JSON.stringify(payload));
    } catch (err) {
      this.logger.error(
        `[PaperEvents] Failed to publish order event to ${PAPER_ORDER_EVENT_CHANNEL}: ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Publishes a trade-closed event to the `events:paper:trade` Redis channel.
   */
  private async publishTradeEvent(payload: PaperTradeEventPayload): Promise<void> {
    try {
      await this.redisService.publish(PAPER_TRADE_EVENT_CHANNEL, JSON.stringify(payload));
    } catch (err) {
      this.logger.error(
        `[PaperEvents] Failed to publish trade event to ${PAPER_TRADE_EVENT_CHANNEL}: ` +
          `${(err as Error).message}`,
      );
    }
  }
}
