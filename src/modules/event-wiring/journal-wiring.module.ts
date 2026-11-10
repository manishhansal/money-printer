/**
 * journal-wiring.module.ts
 *
 * JournalWiringModule — NestJS module that wires intra-process domain events to
 * the TradeJournal's append-only write paths and installs the GlobalExceptionFilter.
 *
 * Responsibilities:
 *
 *   JournalWiringService
 *     Subscribes to `position.exit` and `risk.daily_loss_state_changed` events
 *     via the NestJS EventEmitter2 bus and forwards each event to the appropriate
 *     TradeJournal write method.
 *
 *   GlobalExceptionFilter (APP_FILTER)
 *     Installed as a global HTTP exception filter.  Intercepts every unhandled
 *     exception, calls SystemHealthMonitorService.updateMetricStatus() to mark
 *     'cloudengine_modules' as Degraded, and journals the error via
 *     TradeJournalService.recordSystemError().
 *
 * Dependencies:
 *   - EventEmitterModule.forRoot() — enables @OnEvent decorators in JournalWiringService.
 *     NestJS deduplicates forRoot() calls so re-importing is safe.
 *   - TradeJournalModule       — provides TradeJournalService (exported).
 *   - SystemHealthMonitorModule — provides SystemHealthMonitorService (exported).
 *
 * This module is imported once in AppModule to activate all wiring globally.
 *
 * Requirements: 13.1, 10.1
 */

import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_FILTER } from '@nestjs/core';

import { TradeJournalModule } from '../trade-journal/trade-journal.module';
import { SystemHealthMonitorModule } from '../system-health-monitor/system-health-monitor.module';
import { JournalWiringService } from './journal-wiring.service';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';

@Module({
  imports: [
    // Provides EventEmitter2 for @OnEvent decorators in JournalWiringService.
    // NestJS deduplicates multiple forRoot() invocations across the app.
    EventEmitterModule.forRoot(),

    // Provides TradeJournalService for all append-only journal write paths.
    TradeJournalModule,

    // Provides SystemHealthMonitorService for degradation reporting.
    SystemHealthMonitorModule,
  ],
  providers: [
    // Event-to-journal bridge.
    JournalWiringService,

    // Global catch-all HTTP exception filter.
    // Registered as APP_FILTER so NestJS applies it to every route.
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class JournalWiringModule {}
