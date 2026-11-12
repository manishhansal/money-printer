/**
 * backtest.module.ts
 *
 * BacktestModule — NestJS module for the BacktestEngine.
 *
 * Provides and exports BacktestService so that ComplianceModule and any
 * other orchestration modules can run walk-forward validation and compute
 * bootstrap confidence intervals before permitting live deployment
 * (Requirements 15.1, 15.2, 15.4, 15.6).
 *
 * BacktestController exposes:
 *   POST /backtest/run       — walk-forward backtest from provided trades
 *   GET  /backtest/charges   — charge rates reference for cost-model validation
 *   GET  /backtest/historical — fetch DB trades in BacktestTrade format for use
 *                              with /backtest/run (Phase 9)
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestService } from './backtest.service';
import { BacktestController } from './backtest.controller';
import { TradingChargesModule } from '../charges/trading-charges.module';
import { Trade } from '../../database/entities/trades.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';

@Module({
  imports: [
    TradingChargesModule,
    // Trade + PaperTrade repositories for the GET /backtest/historical endpoint.
    TypeOrmModule.forFeature([Trade, PaperTrade]),
  ],
  controllers: [BacktestController],
  providers: [BacktestService],
  exports: [BacktestService],
})
export class BacktestModule {}
