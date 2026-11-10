/**
 * ComplianceModule — enforces live-deployment profitability gates.
 *
 * Provides:
 *   - ComplianceService: evaluates 4 ordered profitability gates before a
 *     strategy is permitted to trade live, and records gate failures in the
 *     Strategies table (Requirements 15.3, 15.5).
 *
 * Exports:
 *   - ComplianceService: consumed by any module that orchestrates strategy
 *     deployment (e.g. BacktestEngine, StrategyModule).
 *
 * Dependencies:
 *   - TypeOrmModule.forFeature([Strategies, StrategyPerformance]): provides the
 *     TypeORM repositories injected into ComplianceService.
 *
 * Requirements: 15.3, 15.5
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Strategies } from '../../database/entities/strategies.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';
import { ComplianceService } from './compliance.service';

@Module({
  imports: [
    // Provides the Strategies and StrategyPerformance repositories for
    // injection into ComplianceService.
    TypeOrmModule.forFeature([Strategies, StrategyPerformance]),
  ],
  providers: [ComplianceService],
  exports: [ComplianceService],
})
export class ComplianceModule {}
