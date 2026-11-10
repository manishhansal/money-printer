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
 * No external database or Redis dependencies are required: BacktestService
 * operates entirely on the trade arrays passed by the caller, keeping it
 * free of I/O side-effects and straightforwardly unit-testable.
 */

import { Module } from '@nestjs/common';
import { BacktestService } from './backtest.service';
import { TradingChargesModule } from '../charges/trading-charges.module';

@Module({
  imports: [TradingChargesModule],
  providers: [BacktestService],
  exports: [BacktestService],
})
export class BacktestModule {}
