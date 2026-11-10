/**
 * session-manager.module.ts
 *
 * NestJS module for NSE trading session phase management.
 *
 * Provides:
 *  - SessionManagerService — phase detection, Redis updates, event publishing
 *
 * Exports SessionManagerService so other CloudEngine modules can call:
 *  - sessionManagerService.getCurrentPhase()           — current phase (sync)
 *  - sessionManagerService.isOpeningVolatilityPhase()  — OPENING_VOLATILITY check (sync)
 *  - sessionManagerService.isWithinMarketHours()       — market-hours check (sync)
 *  - sessionManagerService.determinePhase(date)        — phase for arbitrary timestamp
 *
 * Dependencies:
 *  - RedisModule (global) — command and pub/sub clients via RedisService
 *  - ScheduleModule       — must be imported in AppModule or this module
 *  - EventEmitterModule   — must be imported in AppModule
 *
 * Requirements: 17.1, 17.2, 17.5
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SessionManagerService } from './session-manager.service';

@Module({
  imports: [
    // ScheduleModule enables the @Cron decorator used by SessionManagerService.
    ScheduleModule.forRoot(),
    // EventEmitterModule enables intra-process NestJS event broadcasting.
    EventEmitterModule.forRoot(),
  ],
  providers: [SessionManagerService],
  exports: [SessionManagerService],
})
export class SessionManagerModule {}
