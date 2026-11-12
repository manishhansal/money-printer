/**
 * session-manager.module.ts
 *
 * NestJS module for NSE trading session phase management.
 *
 * Providers:
 *  - SessionManagerService      — phase detection, Redis updates, event publishing
 *  - NseHolidayCalendarService  — NSE holiday calendar for FY2025-2026
 *
 * Requirements: 17.1, 17.2, 17.5, Phase 10 (NSE holiday calendar)
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SessionManagerService } from './session-manager.service';
import { NseHolidayCalendarService } from './nse-holiday-calendar.service';

@Module({
  imports: [
    // ScheduleModule enables the @Cron decorator used by SessionManagerService.
    ScheduleModule.forRoot(),
    // EventEmitterModule enables intra-process NestJS event broadcasting.
    EventEmitterModule.forRoot(),
  ],
  providers: [SessionManagerService, NseHolidayCalendarService],
  exports: [SessionManagerService, NseHolidayCalendarService],
})
export class SessionManagerModule {}
