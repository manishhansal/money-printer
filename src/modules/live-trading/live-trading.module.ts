/**
 * live-trading.module.ts
 *
 * NestJS module for the live execution engine.
 *
 * Provides:
 *  - LiveTradingService — armed-state machine, session-critical enforcement,
 *    and mandatory intraday square-off at 15:15 IST.
 *
 * Dependencies:
 *  - TypeOrmModule.forFeature([Position, Instruments]) — open-position queries
 *    and instrument look-ups for mandatory square-off orders.
 *  - DhanApiModule         — MARKET exit order submission and orderbook queries.
 *  - TradeJournalModule    — records `mandatory-exit` compliance events.
 *  - NotificationModule    — CRITICAL alerts for unconfirmed square-off orders.
 *  - RedisModule (global)  — persists `trading:armed_state` key.
 *  - SecretsModule (global) — provides DHAN_CLIENT_ID for order submission.
 *  - ScheduleModule        — required for @Cron decorator (registered globally in
 *                            AppModule or SessionManagerModule; re-importing is safe).
 *  - EventEmitterModule    — required for @OnEvent decorator (registered globally).
 *
 * The module exports LiveTradingService so that ExecutionModule (task 18) and
 * other consumers can inject it to call `isNewEntryBlocked()`, `activateLiveMode()`,
 * `confirmArm()`, and `disarm()`.
 *
 * Requirements: 17.3, 17.4, 17.7, 11.1, 11.2
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { Position } from '../../database/entities/positions.entity';
import { Instruments } from '../../database/entities/instruments.entity';

import { DhanApiModule } from '../dhan/dhan-api.module';
import { TradeJournalModule } from '../trade-journal/trade-journal.module';
import { NotificationModule } from '../notification/notification.module';

import { LiveTradingService } from './live-trading.service';

@Module({
  imports: [
    // TypeORM repositories for open-position queries and instrument look-ups.
    TypeOrmModule.forFeature([Position, Instruments]),

    // Dhan HTTP client for order placement and orderbook retrieval.
    DhanApiModule,

    // TradeJournal for mandatory-exit compliance event recording.
    TradeJournalModule,

    // Notification delivery for unconfirmed square-off alerts.
    NotificationModule,

    // Cron scheduler — safe to import multiple times; NestJS deduplicates.
    ScheduleModule.forRoot(),
  ],
  providers: [LiveTradingService],
  exports: [LiveTradingService],
})
export class LiveTradingModule {}
