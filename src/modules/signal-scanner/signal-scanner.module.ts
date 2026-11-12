/**
 * signal-scanner.module.ts
 *
 * SignalScannerModule — wires the signal scanning and dispatch pipeline.
 *
 * Changes in this version (DEFECT-002, DEFECT-003, DEFECT-014 fixes):
 *   - Added MarketDataModule: provides CandleQueryService (historical_candles
 *     query helper) and MarketDataCacheService; both consumed by
 *     SignalScannerService for real indicator computation.
 *   - Added TechnicalAnalysisModule: provides TechnicalAnalysisService used
 *     by SignalScannerService to compute VWAP, RSI, MACD, EMA9/21, ATR, RelVol.
 *   - Added RiskManagementModule: provides RiskManagementService used by
 *     SignalDispatcherService to compute risk-proportional position sizes.
 *
 * Requirements: 9.1, 9.2, 11.3, Phase 6 (SniperEntryService),
 *               DEFECT-002, DEFECT-003, DEFECT-014
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { Instruments } from '../../database/entities/instruments.entity';
import { UserSettings } from '../../database/entities/user-settings.entity';
import { StrategyModule } from '../strategy/strategy.module';
import { MarketRegimeModule } from '../market-regime/market-regime.module';
import { SessionManagerModule } from '../session-manager/session-manager.module';
import { PaperTradingModule } from '../paper-trading/paper-trading.module';
import { ExecutionModule } from '../execution/execution.module';
import { LiveTradingModule } from '../live-trading/live-trading.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { DhanApiModule } from '../dhan/dhan-api.module';
// DEFECT-002/003: CandleQueryService and TechnicalAnalysisService for real indicators.
import { MarketDataModule } from '../market-data/market-data.module';
import { TechnicalAnalysisModule } from '../technical-analysis/technical-analysis.module';
// DEFECT-014: RiskManagementService for risk-proportional position sizing.
import { RiskManagementModule } from '../risk-management/risk-management.module';

import { SignalScannerService } from './signal-scanner.service';
import { SignalDispatcherService } from './signal-dispatcher.service';
import { SniperEntryService } from './sniper-entry.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // Instruments + UserSettings repositories for instrument lookup and settings.
    TypeOrmModule.forFeature([Instruments, UserSettings]),
    StrategyModule,
    MarketRegimeModule,
    SessionManagerModule,
    PaperTradingModule,
    ExecutionModule,
    LiveTradingModule,
    // Portfolio: provides real Dynamic_Capital and open-position list for risk gates.
    PortfolioModule,
    // DhanApiModule: provides DhanApiClient for calculateMargin() pre-trade margin check.
    DhanApiModule,
    // MarketDataModule: provides CandleQueryService (historical candle reads) and
    // MarketDataCacheService for the DEFECT-002/003 real indicator computation.
    MarketDataModule,
    // TechnicalAnalysisModule: provides TechnicalAnalysisService for VWAP, RSI,
    // MACD, EMA, ATR, RelVol computation in the signal scanner.
    TechnicalAnalysisModule,
    // RiskManagementModule: provides RiskManagementService for risk-proportional
    // position sizing in the dispatcher (DEFECT-014).
    RiskManagementModule,
  ],
  providers: [SignalScannerService, SignalDispatcherService, SniperEntryService],
  exports: [SignalScannerService, SignalDispatcherService, SniperEntryService],
})
export class SignalScannerModule {}
