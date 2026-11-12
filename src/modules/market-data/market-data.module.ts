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
 *  - CandleQueryService — typed OHLCV[] read helper over the historical_candles
 *    table; exported so SignalScannerModule can compute real indicators.
 *
 * Exports:
 *  - MarketDataService — consumed by RiskEngine, LiveTradingService, and
 *    PaperTradingService as a synchronous staleness gate (isMarketDataStale()).
 *  - MarketDataCacheService — consumed by SignalDispatcherService and others
 *    for Redis market snapshot reads.
 *  - CandleQueryService — consumed by SignalScannerService for real indicator
 *    computation (DEFECT-002 fix).
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
import { CandleQueryService } from './candle-query.service';
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
    // Read-only OHLCV[] query helper — exported for use by SignalScannerModule
    // (DEFECT-002: real indicator computation in signal scanner).
    CandleQueryService,
  ],
  controllers: [MarketIntelligenceController],
  exports: [MarketDataService, MarketDataCacheService, CandleQueryService],
})
export class MarketDataModule {}
