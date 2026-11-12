/**
 * debug.controller.ts
 *
 * Provides two lightweight debug/diagnostics endpoints consumed by the
 * MoneyPrinter dashboard HTML:
 *
 *   GET /debug/stats  — returns counters: signalEvals, paperOrders,
 *                        paperFills, instruments
 *   GET /debug/scan   — fires an on-demand signal scan by emitting the
 *                        'debug.trigger_scan' event (picked up by
 *                        SignalScannerService.onDebugTriggerScan())
 *
 * These routes are excluded from CSRF validation in AppModule (read-only GETs).
 *
 * Requirements: Dashboard diagnostics panel
 */

import { Controller, Get, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';

import { Instruments } from '../../database/entities/instruments.entity';
import { Signals } from '../../database/entities/signals.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { getISTStartOfDay } from '../../common/utils/ist-time.utils';

/** Event name consumed by SignalScannerService.onDebugTriggerScan(). */
export const DEBUG_TRIGGER_SCAN_EVENT = 'debug.trigger_scan';

export interface DebugStatsResponse {
  signalEvals: number;
  paperOrders: number;
  paperFills: number;
  instruments: number;
  asOf: string;
}

export interface DebugScanResponse {
  triggeredAt: string;
  message: string;
}

@Controller('debug')
export class DebugController {
  private readonly logger = new Logger(DebugController.name);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
    @InjectRepository(Signals)
    private readonly signalsRepo: Repository<Signals>,
    @InjectRepository(PaperTrade)
    private readonly paperTradesRepo: Repository<PaperTrade>,
  ) {}

  /**
   * GET /debug/stats
   *
   * Returns diagnostic counters for the dashboard footer stats bar:
   *   - signalEvals:  Signals generated today (since midnight IST)
   *   - paperOrders:  Paper trades entered today (all statuses)
   *   - paperFills:   Paper trades closed today (each row = a completed fill)
   *   - instruments:  Total instruments loaded in DB
   */
  @Get('stats')
  async getStats(): Promise<DebugStatsResponse> {
    const startOfDay = getISTStartOfDay();

    const [instruments, signalEvals, paperTodayCount] = await Promise.all([
      this.instrumentsRepo.count(),
      this.signalsRepo.count({
        where: { signalTimestamp: MoreThanOrEqual(startOfDay) },
      }),
      this.paperTradesRepo.count({
        where: { entry_time: MoreThanOrEqual(startOfDay) },
      }),
    ]);

    return {
      signalEvals,
      // Both paperOrders and paperFills map to PaperTrade rows — each row
      // represents one completed round-trip (entry + exit = fill).
      paperOrders: paperTodayCount,
      paperFills: paperTodayCount,
      instruments,
      asOf: new Date().toISOString(),
    };
  }

  /**
   * GET /debug/scan
   *
   * Fires an on-demand scan by emitting DEBUG_TRIGGER_SCAN_EVENT.
   * SignalScannerService.onDebugTriggerScan() picks this up and calls
   * scanForSignals() asynchronously (fire-and-forget from HTTP perspective).
   *
   * Returns immediately with { triggeredAt } so the dashboard can display
   * the scan timestamp without waiting for the full scan to complete.
   */
  @Get('scan')
  triggerScan(): DebugScanResponse {
    const triggeredAt = new Date().toISOString();
    this.logger.log('[Debug] On-demand scan triggered by dashboard');

    // Fire-and-forget: the EventEmitter2 listener runs asynchronously.
    this.eventEmitter.emit(DEBUG_TRIGGER_SCAN_EVENT, { triggeredAt });

    return {
      triggeredAt,
      message: 'Scan event dispatched — check server logs for results',
    };
  }
}
