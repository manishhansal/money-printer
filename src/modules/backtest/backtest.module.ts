/**
 * backtest.module.ts
 *
 * BacktestModule — NestJS module for the BacktestEngine.
 *
 * Provides and exports BacktestService so that ComplianceModule and any
 * other orchestration modules can run walk-forward validation and compute
 * bootstrap confidence intervals before permitting live deployment.
 *
 * Also provides DhanHistoricalBackfillService for on-demand Dhan API
 * historical data ingestion — resolves DEFECT-005.
 *
 * BacktestController exposes:
 *   POST /backtest/run       — walk-forward backtest from provided trades
 *   GET  /backtest/charges   — charge rates reference for cost-model validation
 *   GET  /backtest/historical — fetch DB trades in BacktestTrade format
 *   POST /backtest/backfill  — fetch historical candles from Dhan API (DEFECT-005)
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestService } from './backtest.service';
import { BacktestController } from './backtest.controller';
import { DhanHistoricalBackfillService } from './dhan-historical-backfill.service';
import { DhanRollingOptionBackfillService } from './dhan-rolling-option-backfill.service';
import { TradingChargesModule } from '../charges/trading-charges.module';
import { DhanApiModule } from '../dhan/dhan-api.module';
import { Trade } from '../../database/entities/trades.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { HistoricalCandles } from '../../database/entities/historical-candles.entity';
import { RollingOptionCandles } from '../../database/entities/rolling-option-candles.entity';
import { Instruments } from '../../database/entities/instruments.entity';

@Module({
  imports: [
    TradingChargesModule,
    // DhanApiModule: provides DhanApiClient for both backfill services.
    DhanApiModule,
    TypeOrmModule.forFeature([
      Trade,
      PaperTrade,
      HistoricalCandles,
      RollingOptionCandles,
      Instruments,
    ]),
  ],
  controllers: [BacktestController],
  providers: [BacktestService, DhanHistoricalBackfillService, DhanRollingOptionBackfillService],
  exports: [BacktestService, DhanHistoricalBackfillService, DhanRollingOptionBackfillService],
})
export class BacktestModule {}
