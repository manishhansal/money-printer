/**
 * market-regime.module.ts
 *
 * NestJS module for market regime classification and event publishing.
 *
 * Provides:
 *  - MarketRegimeService — regime classification, cron-driven re-evaluation,
 *    Redis publishing, database persistence, and NestJS event emission.
 *
 * Exports:
 *  - MarketRegimeService — consumed by StrategyEngine, RiskEngine, and
 *    OptionsIntelligence to query the current regime and subscribe to
 *    regime-change events.
 *
 * Dependencies:
 *  - TypeOrmModule.forFeature([MarketRegimes]) — provides the TypeORM
 *    repository for the `market_regimes` table.
 *  - ScheduleModule.forRoot()  — enables @Cron decorator in MarketRegimeService.
 *  - EventEmitterModule.forRoot() — enables intra-process NestJS event emission.
 *  - RedisModule (global)      — provides RedisService for pub/sub and cache writes.
 *  - ConfigModule (global)     — provides ConfigService for threshold configuration.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.7
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MarketRegimes } from '../../database/entities/market-regimes.entity';
import { MarketRegimeService } from './market-regime.service';

@Module({
  imports: [
    // Registers the MarketRegimes entity repository for injection.
    TypeOrmModule.forFeature([MarketRegimes]),

    // Enables @Cron decorators — required by the every-minute updateRegime() job.
    ScheduleModule.forRoot(),

    // Enables @OnEvent listeners and intra-process event broadcasting.
    EventEmitterModule.forRoot(),
  ],
  providers: [MarketRegimeService],
  exports: [MarketRegimeService],
})
export class MarketRegimeModule {}
