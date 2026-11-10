/**
 * reconciliation.module.ts
 *
 * NestJS module for the ReconciliationService.
 *
 * Provides:
 *  - ReconciliationService — EOD reconciliation, reconnection reconciliation,
 *    SL status verification, and discrepancy acknowledgment.
 *
 * Exports:
 *  - ReconciliationService — so TrailingStopEngine, LiveTradingService, and
 *    ExecutionService can call `isNewOrdersHalted()`,
 *    `verifySLStatusAfterReconnect()`, and `acknowledgeDiscrepancy()`.
 *
 * Dependencies:
 *  - TypeOrmModule.forFeature([Order, Execution, Position, AuditLogs])
 *    — provides the four TypeORM repositories injected by ReconciliationService.
 *  - ScheduleModule.forRoot()
 *    — enables the @Cron('30 15 * * 1-5') EOD reconciliation trigger.
 *    Safe to import in multiple modules; NestJS deduplicates.
 *  - DhanApiModule
 *    — provides DhanApiClient for orderbook, tradebook, and positions lookups.
 *  - NotificationModule
 *    — provides NotificationService for CRITICAL alert delivery on discrepancy
 *      and timeout.
 *
 * Requirements: 12.4, 17.6, 19.1, 19.2, 19.3, 19.4
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { Order } from '../../database/entities/orders.entity';
import { Execution } from '../../database/entities/executions.entity';
import { Position } from '../../database/entities/positions.entity';
import { AuditLogs } from '../../database/entities/audit-logs.entity';

import { DhanApiModule } from '../dhan/dhan-api.module';
import { NotificationModule } from '../notification/notification.module';

import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    // Provides repositories for Order, Execution, Position, and AuditLogs.
    TypeOrmModule.forFeature([Order, Execution, Position, AuditLogs]),

    // Enables the @Cron decorator on runEodReconciliation().
    // NestJS deduplicates multiple forRoot() calls across modules.
    ScheduleModule.forRoot(),

    // Provides DhanApiClient for all Dhan broker state lookups.
    DhanApiModule,

    // Provides NotificationService for CRITICAL alert delivery.
    NotificationModule,
  ],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
