/**
 * signal-scanner.module.ts
 *
 * SignalScannerModule — wires the signal scanning and dispatch pipeline.
 *
 * Requirements: 9.1, 9.2, 11.3, Phase 6 (SniperEntryService)
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

import { SignalScannerService } from './signal-scanner.service';
import { SignalDispatcherService } from './signal-dispatcher.service';
import { SniperEntryService } from './sniper-entry.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // Instruments + UserSettings repositories for live dispatch instrument lookup.
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
  ],
  providers: [SignalScannerService, SignalDispatcherService, SniperEntryService],
  exports: [SignalScannerService, SignalDispatcherService, SniperEntryService],
})
export class SignalScannerModule {}
