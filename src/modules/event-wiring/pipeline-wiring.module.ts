/**
 * PipelineWiringModule — wires the signal-to-execution NestJS EventEmitter
 * pipeline across all trading modules.
 *
 * This module is the single place where cross-module event subscriptions are
 * registered, keeping individual feature modules free of cross-cutting
 * event-forwarding concerns.
 *
 * Pipeline wired (Requirements 9.1, 9.2, 11.3):
 *
 *   StrategyModule     →[strategy.signal.candidate]→   SignalScoringModule
 *   PositionMonitoringModule →[risk.unrealized_pnl_updated]→ RiskManagementModule
 *
 * Imports:
 *   - EventEmitterModule.forRoot() — registers the global EventEmitter2 singleton
 *     and enables @OnEvent decorators in PipelineWiringService.
 *   - SignalScoringModule         — provides SignalScoringService.
 *   - RiskManagementModule        — provides DailyLossStateMachineService.
 *
 * Requirements: 9.1, 9.2, 11.3
 */

import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { SignalScoringModule } from '../signal-scoring/signal-scoring.module';
import { RiskManagementModule } from '../risk-management/risk-management.module';
import { PipelineWiringService } from './pipeline-wiring.service';

@Module({
  imports: [
    // Registers the global EventEmitter2 singleton required by @OnEvent decorators.
    // NestJS de-duplicates forRoot() calls so registering it here is safe even
    // when other modules (StrategyModule, MarketRegimeModule, etc.) also call
    // EventEmitterModule.forRoot().
    EventEmitterModule.forRoot(),

    // Provides SignalScoringService for the strategy.signal.candidate handler.
    SignalScoringModule,

    // Provides DailyLossStateMachineService for the risk.unrealized_pnl_updated handler.
    RiskManagementModule,
  ],
  providers: [PipelineWiringService],
  exports: [PipelineWiringService],
})
export class PipelineWiringModule {}
