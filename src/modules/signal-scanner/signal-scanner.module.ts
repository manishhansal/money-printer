/**
 * signal-scanner.module.ts
 *
 * SignalScannerModule — wires the two missing pipeline links:
 *
 *   1. SignalScannerService  — cron every 2 min, reads Redis mkt:snapshot:*,
 *      evaluates live instruments against StrategyService.evaluateSignalCandidate().
 *
 *   2. SignalDispatcherService — listens to `signal.accepted` events emitted by
 *      PipelineWiringService after a signal scores ≥ 80, then routes to:
 *        engine === 'PAPER' → PaperTradingService.submitPaperOrder()
 *        engine === 'LIVE'  → ExecutionService.placeOrder()  (requires ARMED)
 *
 * Dependencies:
 *   - StrategyModule       — provides StrategyService for evaluateSignalCandidate
 *   - MarketRegimeModule   — provides MarketRegimeService.getCurrentRegime()
 *   - SessionManagerModule — provides SessionManagerService.getCurrentPhase()
 *   - PaperTradingModule   — provides PaperTradingService for paper dispatch
 *   - ExecutionModule      — provides ExecutionService for live dispatch
 *   - LiveTradingModule    — provides LiveTradingService for armed-state checks
 *   - TypeOrmModule        — registers Instruments repository for instrument lookup
 *   - ScheduleModule       — required for @Cron decorator
 *   - RedisModule (global) — provides RedisService for snapshot key discovery
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { Instruments } from '../../database/entities/instruments.entity';
import { StrategyModule } from '../strategy/strategy.module';
import { MarketRegimeModule } from '../market-regime/market-regime.module';
import { SessionManagerModule } from '../session-manager/session-manager.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { ExecutionModule } from '../execution/execution.module';
import { LiveTradingModule } from '../live-trading/live-trading.module';

import { SignalScannerService } from './signal-scanner.service';
import { SignalDispatcherService } from './signal-dispatcher.service';

@Module({
  imports: [
    // Cron scheduler — safe to import multiple times; NestJS deduplicates.
    ScheduleModule.forRoot(),

    // Instruments repository for live dispatch instrument lookup.
    TypeOrmModule.forFeature([Instruments]),

    // Strategy evaluation pipeline.
    StrategyModule,

    // Regime and session phase for scan eligibility.
    MarketRegimeModule,
    SessionManagerModule,

    // Execution engines.
    PaperTradingModule,
    ExecutionModule,
    LiveTradingModule,
  ],
  providers: [SignalScannerService, SignalDispatcherService],
  exports: [SignalScannerService, SignalDispatcherService],
})
export class SignalScannerModule {}
