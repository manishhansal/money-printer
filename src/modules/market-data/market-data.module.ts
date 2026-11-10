/**
 * market-data.module.ts
 *
 * NestJS module for the MarketDataModule feed-staleness sub-system (task 6.3).
 *
 * Provides:
 *  - MarketDataService — tick tracking, isMarketDataStale(), getDataAge(),
 *    and the EVERY_5_SECONDS cron-based staleness monitor.
 *
 * Exports:
 *  - MarketDataService — consumed by RiskEngine, LiveTradingService, and
 *    PaperTradingService as a synchronous staleness gate (isMarketDataStale()).
 *
 * Dependencies:
 *  - ScheduleModule   — enables @Cron decorator used by MarketDataService
 *  - EventEmitterModule — enables @OnEvent and eventEmitter.emit
 *  - NotificationModule — provides NotificationService for alert publishing
 *  - ConfigModule (global) — provides ConfigService for MAX_MARKET_DATA_AGE_MS
 *
 * Requirements: 9.6
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { NotificationModule } from '../notification/notification.module';
import { MarketDataService } from './market-data.service';

@Module({
  imports: [
    // Enables @Cron decorators in MarketDataService.
    ScheduleModule.forRoot(),
    // Enables @OnEvent listeners and intra-process event emission.
    EventEmitterModule.forRoot(),
    // Provides NotificationService for WARNING / INFO alert publishing.
    NotificationModule,
  ],
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
