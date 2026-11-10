/**
 * AnalyticsModule — performance metrics for LIVE and PAPER trading engines.
 *
 * Registers TypeORM repositories for the `trades`, `paper_trades`,
 * `strategies`, `instruments`, `signals`, `strategy_performance`,
 * `capital_ledgers`, and `market_regimes` tables consumed by the analytics
 * services.
 *
 * Export AnalyticsService so other modules (e.g., the Chrome Extension API,
 * Daily Intelligence Report generator) can inject it without declaring their
 * own forFeature() imports.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Trade } from '../../database/entities/trades.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { Strategies } from '../../database/entities/strategies.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { Signals } from '../../database/entities/signals.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';
import { CapitalLedgers } from '../../database/entities/capital-ledgers.entity';
import { MarketRegimes } from '../../database/entities/market-regimes.entity';
import { AnalyticsService } from './analytics.service';
import { TradeQualityForensicsService } from './trade-quality-forensics.service';
import { DailyIntelligenceReportService } from './daily-intelligence-report.service';
import { CapitalSimulatorService } from './capital-simulator.service';
import { MarketActivityHeatmapService } from './market-activity-heatmap.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Trade,
      PaperTrade,
      Strategies,
      Instruments,
      Signals,
      StrategyPerformance,
      CapitalLedgers,
      MarketRegimes,
    ]),
  ],
  providers: [
    AnalyticsService,
    TradeQualityForensicsService,
    DailyIntelligenceReportService,
    CapitalSimulatorService,
    MarketActivityHeatmapService,
  ],
  exports: [
    AnalyticsService,
    TradeQualityForensicsService,
    DailyIntelligenceReportService,
    CapitalSimulatorService,
    MarketActivityHeatmapService,
  ],
})
export class AnalyticsModule {}
