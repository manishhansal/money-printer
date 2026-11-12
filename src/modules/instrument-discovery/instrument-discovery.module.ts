/**
 * instrument-discovery.module.ts
 *
 * NestJS module for the InstrumentDiscovery subsystem.
 *
 * Provides:
 *  - InstrumentDiscoveryService  — classification logic, cron-triggered scan,
 *    and active-universe query.
 *  - LiquidityScoreService       — composite liquidity score computation.
 *  - SubscriptionRotationService — WebSocket subscription quota management
 *    and quality-based feed rotation.
 *
 * Exports:
 *  - InstrumentDiscoveryService  — consumed by StrategyEngine, OptionsIntelligence,
 *    RiskEngine, and any module that needs to verify instrument tradability.
 *  - LiquidityScoreService       — consumed by downstream scoring modules.
 *  - SubscriptionRotationService — consumed by MarketData for feed management.
 *
 * Dependencies:
 *  - TypeOrmModule.forFeature([Instruments, SystemHealthEvents])
 *                                     — registers the Instruments and
 *                                       SystemHealthEvents repositories for
 *                                       injection into the services.
 *  - ScheduleModule                   — enables the @Cron decorator on
 *                                       scanInstruments() (09:15 IST) and
 *                                       updateLiquidityRankings() (every 5 min).
 *  - EventEmitterModule               — enables EventEmitter2 for emitting
 *                                       'instruments.universe.updated' and
 *                                       'instruments.scan.failed'.
 *  - DhanApiModule                    — provides DhanWebSocketClient so
 *                                       SubscriptionRotationService can
 *                                       subscribe/unsubscribe feeds.
 *  - NotificationModule               — provides NotificationService so
 *                                       InstrumentDiscoveryService can publish
 *                                       CRITICAL alerts on scan failure
 *                                       (Requirement 4.7).
 *  - ConfigModule (global)            — provides ConfigService for all
 *                                       env-driven thresholds.
 *
 * Requirements: 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Instruments } from '../../database/entities/instruments.entity';
import { SystemHealthEvents } from '../../database/entities/system-health-events.entity';
import { InstrumentDiscoveryService } from './instrument-discovery.service';
import { LiquidityScoreService } from './liquidity-score.service';
import { SubscriptionRotationService } from './subscription-rotation.service';
import { InstrumentMasterService } from './instrument-master.service';
import { DhanApiModule } from '../dhan/dhan-api.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    // Register the Instruments and SystemHealthEvents entity repositories.
    TypeOrmModule.forFeature([Instruments, SystemHealthEvents]),
    // Enable @Cron decorators (09:15 IST scan + every-5-min ranking refresh).
    ScheduleModule.forRoot(),
    // Enable EventEmitter2 for intra-process event emission.
    EventEmitterModule.forRoot(),
    // Provides DhanWebSocketClient for SubscriptionRotationService.
    DhanApiModule,
    // Provides NotificationService for CRITICAL scan-failure alerts (Req 4.7).
    NotificationModule,
  ],
  providers: [
    InstrumentDiscoveryService,
    LiquidityScoreService,
    SubscriptionRotationService,
    InstrumentMasterService,
  ],
  exports: [
    InstrumentDiscoveryService,
    LiquidityScoreService,
    SubscriptionRotationService,
    InstrumentMasterService,
  ],
})
export class InstrumentDiscoveryModule {}
