/**
 * strategy.module.ts
 *
 * NestJS module for the StrategyEngine.
 *
 * Provides:
 *  - StrategyService — seeds all 8 strategy configurations on startup and
 *    exposes regime-compatibility query helpers used by the SignalScoringModule,
 *    RiskEngine, and the Adaptive StrategyEngine.  Also runs the 5-gate
 *    sequential signal-candidate evaluation (Task 13.2).
 *
 * Exports:
 *  - StrategyService — consumed by any module that needs to query or filter
 *    strategies (e.g. SignalScoring, RiskManagement, LiveTrading, PaperTrading).
 *
 * Dependencies:
 *  - TypeOrmModule.forFeature([Strategies, SignalEvaluations, StrategyPerformance]) —
 *    provides the TypeORM repositories for the `strategies`, `signal_evaluations`,
 *    and `strategy_performance` tables.
 *  - EventEmitterModule.forRoot() — enables EventEmitter2 injection for
 *    publishing SIGNAL_CANDIDATE_EVENT and STRATEGY_DEGRADATION_EVENT.
 *  - ConfigModule (global) — provides ConfigService for threshold configuration
 *    used by the Adaptive StrategyEngine.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 20.2
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { Strategies } from '../../database/entities/strategies.entity';
import { SignalEvaluations } from '../../database/entities/signal-evaluations.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';
import { StrategyService } from './strategy.service';

@Module({
  imports: [
    // Registers the Strategies, SignalEvaluations, and StrategyPerformance entity
    // repositories for injection into StrategyService.
    TypeOrmModule.forFeature([Strategies, SignalEvaluations, StrategyPerformance]),

    // Enables EventEmitter2 intra-process event emission used by Gate 5 of the
    // sequential evaluation to forward signal candidates to SignalScoringModule.
    EventEmitterModule.forRoot(),
  ],
  providers: [StrategyService],
  exports: [StrategyService],
})
export class StrategyModule {}
