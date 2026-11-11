/**
 * signal-dispatcher.service.ts
 *
 * SignalDispatcherService — routes accepted signals (score ≥ 80) to the
 * appropriate execution engine.
 *
 * Listens to the `signal.accepted` NestJS event emitted by PipelineWiringService
 * after a signal has been scored and persisted to the signals table.
 *
 * Routing logic:
 *   engine === 'PAPER'                 → PaperTradingService.submitPaperOrder()
 *   engine === 'LIVE' + isArmed()      → ExecutionService.placeOrder()
 *   engine === 'LIVE' + !isArmed()     → log and skip (no order placed)
 */

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { Instruments } from '../../database/entities/instruments.entity';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { ExecutionService } from '../execution/execution.service';
import { LiveTradingService } from '../live-trading/live-trading.service';
import { SIGNAL_ACCEPTED_EVENT, SignalAcceptedEventPayload } from './signal-scanner.types';

/** Map Instruments.exchange + segment → DhanExchangeSegment */
function toDhanSegment(exchange: string, segment: string): string {
  const key = `${exchange.toUpperCase()}_${segment.toUpperCase()}`;
  const MAP: Record<string, string> = {
    NSE_FO: 'NSE_FNO',
    NSE_EQ: 'NSE_EQ',
    BSE_FO: 'BSE_FNO',
    BSE_EQ: 'BSE_EQ',
    MCX_COMM: 'MCX_COMM',
    IDX_I: 'IDX_I',
  };
  return MAP[key] ?? 'NSE_FNO';
}

@Injectable()
export class SignalDispatcherService {
  private readonly logger = new Logger(SignalDispatcherService.name);

  constructor(
    private readonly paperTradingService: PaperTradingService,
    private readonly executionService: ExecutionService,
    private readonly liveTradingService: LiveTradingService,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  /**
   * Handle an accepted signal by routing it to paper or live execution.
   *
   * Requirements: 9.2, 10.1, 11.3
   */
  @OnEvent(SIGNAL_ACCEPTED_EVENT)
  async onSignalAccepted(payload: unknown): Promise<void> {
    if (!isSignalAcceptedPayload(payload)) {
      this.logger.warn(
        `[Dispatcher] Received malformed ${SIGNAL_ACCEPTED_EVENT} payload — skipping`,
      );
      return;
    }

    this.logger.log(
      `[Dispatcher] Routing signal=${payload.signalId} engine=${payload.engine} ` +
        `direction=${payload.direction} instrument=${payload.instrumentId} ` +
        `score=${payload.compositeScore}`,
    );

    try {
      if (payload.engine === 'PAPER') {
        await this.dispatchToPaper(payload);
      } else if (payload.engine === 'LIVE') {
        await this.dispatchToLive(payload);
      }
    } catch (err) {
      this.logger.error(
        `[Dispatcher] Dispatch failed for signal=${payload.signalId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  // ─── Paper execution ────────────────────────────────────────────────────────

  private async dispatchToPaper(payload: SignalAcceptedEventPayload): Promise<void> {
    const idempotencyKey = `signal-${payload.signalId}-${Date.now()}`;

    // ── Idempotency guard: skip if an open LONG position already exists ─────
    // The scanner evaluates every instrument every 2 minutes; without this guard
    // the same instrument gets a new BUY signal each cycle and the position
    // scales in unboundedly.  One open position per instrument is enough.
    const openPositions = await this.paperTradingService.getOpenPaperPositions();
    const alreadyOpen = openPositions.some(
      (p) => p.instrument_id === payload.instrumentId && p.direction === 'LONG',
    );
    if (alreadyOpen && payload.direction === 'BUY') {
      this.logger.debug(
        `[Dispatcher] Skipping BUY signal for ${payload.instrumentId} — LONG position already open`,
      );
      return;
    }

    const result = await this.paperTradingService.submitPaperOrder({
      idempotencyKey,
      instrumentId: payload.instrumentId,
      strategyId: payload.strategyId,
      signalId: payload.signalId,
      transactionType: payload.direction as 'BUY' | 'SELL',
      orderType: 'MARKET',
      quantity: payload.positionSize,
      signalScore: payload.compositeScore,
      // securityId is the Redis key suffix for mkt:snapshot:{securityId}.
      // Without this, fetchMarketSnapshot would use the DB UUID and find nothing.
      marketDataKey: payload.securityId || undefined,
      slippageConfig: { model: 'fixed_rupee', fixedRupee: 0.5 },
      latencyConfig: { distribution: 'normal', meanMs: 150 },
      rejectionProbability: 0,
    });

    if (result.status === 'complete') {
      this.logger.log(
        `[Dispatcher] PAPER order filled — orderId=${result.orderId} ` +
          `fill=${result.fillPrice} latency=${result.simulatedLatencyMs}ms`,
      );
    } else {
      this.logger.warn(`[Dispatcher] PAPER order rejected — reason=${result.rejectionReason}`);
    }
  }

  // ─── Live execution ─────────────────────────────────────────────────────────

  private async dispatchToLive(payload: SignalAcceptedEventPayload): Promise<void> {
    if (!this.liveTradingService.isArmed()) {
      this.logger.warn(
        `[Dispatcher] LIVE signal=${payload.signalId} skipped — engine not ARMED ` +
          `(state=${this.liveTradingService.getArmedState()})`,
      );
      return;
    }

    if (this.liveTradingService.isNewEntryBlocked()) {
      this.logger.warn(
        `[Dispatcher] LIVE signal=${payload.signalId} skipped — new entries are blocked`,
      );
      return;
    }

    const instrument = await this.instrumentsRepo.findOne({
      where: { id: payload.instrumentId },
    });

    if (!instrument) {
      this.logger.error(
        `[Dispatcher] LIVE signal=${payload.signalId}: instrument ${payload.instrumentId} not found`,
      );
      return;
    }

    const result = await this.executionService.placeOrder({
      idempotencyKey: uuidv4(),
      engine: 'LIVE',
      signalId: payload.signalId,
      compositeScore: payload.compositeScore,
      instrumentId: payload.instrumentId,
      securityId: instrument.securityId,
      exchangeSegment: toDhanSegment(instrument.exchange, instrument.segment) as 'NSE_FNO',
      productType: 'INTRADAY',
      orderType: 'MARKET',
      transactionType: payload.direction as 'BUY' | 'SELL',
      quantity: payload.positionSize,
      entryPrice: payload.entryPrice,
      stopLossPrice: payload.stopLossPrice,
      lotSize: instrument.lotSize,
      dynamicCapital: '100000.00',
      riskPercentage: '1.00',
      currentTotalExposure: '0.00',
      currentCorrelatedExposure: '0.00',
      currentInstrumentExposure: '0.00',
      openPositionsCount: 0,
      requiredMargin: parseFloat(payload.entryPrice) * payload.positionSize * instrument.lotSize,
    });

    if (result.status === 'submitted') {
      this.logger.log(
        `[Dispatcher] LIVE order submitted — orderId=${result.orderId} dhanOrderId=${result.dhanOrderId}`,
      );
    } else {
      this.logger.warn(
        `[Dispatcher] LIVE order rejected — gate=${result.rejectedBy} reason=${result.rejectionReason}`,
      );
    }
  }
}

// ─── Type guard ─────────────────────────────────────────────────────────────

function isSignalAcceptedPayload(value: unknown): value is SignalAcceptedEventPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['signalId'] === 'string' &&
    typeof p['strategyId'] === 'string' &&
    typeof p['instrumentId'] === 'string' &&
    (p['engine'] === 'LIVE' || p['engine'] === 'PAPER') &&
    (p['direction'] === 'BUY' || p['direction'] === 'SELL') &&
    typeof p['entryPrice'] === 'string' &&
    typeof p['compositeScore'] === 'number'
  );
}
