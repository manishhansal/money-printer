/**
 * market-data.module.ts
 *
 * NestJS module for the MarketDataModule feed-staleness sub-system (task 6.3).
 *
 * Provides:
 *  - MarketDataService — tick tracking, isMarketDataStale(), getDataAge(),
 *    and the EVERY_5_SECONDS cron-based staleness monitor.
 *  - MarketIntelligenceController — GET /market-data/intelligence,
 *    GET /market-data/candles/:instrumentId (React dashboard endpoints).
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
 *  - TypeOrmModule.forFeature([HistoricalCandles]) — candles repo for /candles endpoint
 *  - MarketRegimeModule — provides MarketRegimeService for /intelligence endpoint
 *
 * Requirements: 9.6
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationModule } from '../notification/notification.module';
import { MarketRegimeModule } from '../market-regime/market-regime.module';
import { DhanApiModule } from '../dhan/dhan-api.module';
import { HistoricalCandles } from '../../database/entities/historical-candles.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { MarketDataService } from './market-data.service';
import { MarketDataCacheService } from './market-data-cache.service';
import { MarketIntelligenceController } from './market-intelligence.controller';
import { HistoricalCandleIngestionService } from './historical-candle-ingestion.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    NotificationModule,
    TypeOrmModule.forFeature([HistoricalCandles, Instruments]),
    MarketRegimeModule,
    // DhanApiModule: provides DhanApiClient for HistoricalCandleIngestionService.
    DhanApiModule,
  ],
  providers: [
    MarketDataService,
    MarketDataCacheService,
    // Fetches 1m intraday candles on startup + daily at 15:35 IST.
    HistoricalCandleIngestionService,
  ],
  controllers: [MarketIntelligenceController],
  exports: [MarketDataService, MarketDataCacheService],
})
export class MarketDataModule {}
