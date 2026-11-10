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

import { PaperOrder } from '../../database/entities/paper-orders.entity';
import { PaperExecution } from '../../database/entities/paper-executions.entity';
import { PaperPosition } from '../../database/entities/paper-positions.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';

import { RedisService } from '../redis/redis.service';
import { MarketSnapshot } from '../market-data/market-data.types';

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
  PaperTradingCosts,
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

/** Starting capital for a fresh paper portfolio (INR). */
export const PAPER_STARTING_CAPITAL = '1000000.00'; // ₹10,00,000 (10 lakhs)

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
    // This is the ONLY service injected here. No LiveEngine services are used.
    private readonly redisService: RedisService,
  ) {}

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
      price,
      signalScore,
      slippageConfig = DEFAULT_SLIPPAGE_CONFIG,
      rejectionProbability = DEFAULT_REJECTION_PROBABILITY,
      latencyConfig = DEFAULT_LATENCY_CONFIG,
    } = request;

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
    const snapshot = await this.fetchMarketSnapshot(instrumentId);

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

    const fillTimestamp = new Date();

    // ── Step 8: Persist PaperExecution ───────────────────────────────────────
    const paperExecution = this.paperExecutionsRepo.create({
      order_id: orderId,
      engine: 'PAPER',
      dhan_trade_id: null,
      fill_price: fillPrice.toFixed(2),
      fill_quantity: quantity,
      fill_timestamp: fillTimestamp,
      slippage: slippageAmount.toFixed(4),
    });
    const savedExecution = await this.paperExecutionsRepo.save(paperExecution);

    // ── Step 9: Update PaperOrder to 'complete' ───────────────────────────────
    savedOrder.status = 'complete';
    savedOrder.filled_quantity = quantity;
    savedOrder.average_fill_price = fillPrice.toFixed(2);
    await this.paperOrdersRepo.save(savedOrder);

    // ── Step 10: Update or create PaperPosition ───────────────────────────────
    const { position, tradeClosed, closedTrade } = await this.updatePosition(
      instrumentId,
      strategyId ?? null,
      signalId ?? null,
      transactionType,
      quantity,
      fillPrice,
      fillTimestamp,
      slippageAmount,
      signalScore,
    );

    // ── Step 11: Update portfolio balance if trade closed ─────────────────────
    let portfolioBalance = await this.getPortfolioBalance();
    if (tradeClosed && closedTrade) {
      const netPnl = parseFloat(closedTrade.net_pnl);
      const currentBalance = parseFloat(portfolioBalance);
      portfolioBalance = (currentBalance + netPnl).toFixed(2);
      await this.redisService.set(PAPER_PORTFOLIO_BALANCE_KEY, portfolioBalance);

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
   * If no balance has been initialised, returns the default starting capital.
   *
   * Key: `paper:portfolio:balance`
   */
  async getPortfolioBalance(): Promise<string> {
    const stored = await this.redisService.get(PAPER_PORTFOLIO_BALANCE_KEY);
    if (!stored) {
      // Lazy-initialise the balance on first access
      await this.redisService.set(PAPER_PORTFOLIO_BALANCE_KEY, PAPER_STARTING_CAPITAL);
      return PAPER_STARTING_CAPITAL;
    }
    return stored;
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
    signalScore?: number,
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
        const costs = this.calculateTradingCosts(entryPrice, fillPrice, exitQty);

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
          lot_size: 1,
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
        const costs = this.calculateTradingCosts(entryPrice, fillPrice, exitQty);
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
          lot_size: 1,
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
   *  - Stamp duty:        0.003% of buy-side turnover only.
   */
  private calculateTradingCosts(
    entryPrice: number,
    exitPrice: number,
    quantity: number,
  ): PaperTradingCosts {
    const buyTurnover = entryPrice * quantity;
    const sellTurnover = exitPrice * quantity;
    const totalTurnover = buyTurnover + sellTurnover;

    // ₹20 flat per side (entry + exit = ₹40 total)
    const brokerage = 40;

    // STT: 0.05% of sell-side premium
    const stt = sellTurnover * 0.0005;

    // NSE exchange charges: 0.053% of total turnover
    const exchangeCharges = totalTurnover * 0.00053;

    // GST: 18% of (brokerage + exchange charges)
    const gst = (brokerage + exchangeCharges) * 0.18;

    // SEBI charges: ₹10 per crore = 0.000001 × turnover
    const sebiCharges = totalTurnover * 0.000001;

    // Stamp duty: 0.003% of buy-side only
    const stampDuty = buyTurnover * 0.00003;

    const total = brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty;

    return {
      brokerage,
      stt,
      exchangeCharges,
      gst,
      sebiCharges,
      stampDuty,
      total,
    };
  }

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
