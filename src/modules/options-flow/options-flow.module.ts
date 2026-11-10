/**
 * options-flow.module.ts
 *
 * NestJS module for the Options Flow Dashboard (task 31.2).
 *
 * Provides and exports:
 *  - OptionsFlowService — periodic aggregator for netOiChange, putCallRatio,
 *    ivSkew, and largeBlockDetected; exposes getDashboard() with staleness
 *    indicators and suppressOptionsFuturesScore flag.
 *
 * Controllers:
 *  - OptionsFlowController — GET /options-flow/dashboard (requires JWT auth).
 *
 * Dependencies:
 *  - RedisModule (global)  — provides RedisService for option-chain reads.
 *  - ConfigModule (global) — provides ConfigService for threshold config.
 *  - ScheduleModule        — enables @Cron decorator on refreshFlow().
 *                            Safe to import in multiple modules; NestJS deduplicates.
 *  - AuthModule            — provides JwtAuthGuard for the controller endpoint.
 *
 * Requirements: 20.6, 20.7
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OptionsFlowService } from './options-flow.service';
import { OptionsFlowController } from './options-flow.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    // Enables @Cron decorator on OptionsFlowService.refreshFlow().
    // NestJS deduplicates multiple forRoot() calls across modules.
    ScheduleModule.forRoot(),
    // Provides JwtAuthGuard for the GET /options-flow/dashboard endpoint.
    AuthModule,
  ],
  controllers: [OptionsFlowController],
  providers: [OptionsFlowService],
  exports: [OptionsFlowService],
})
export class OptionsFlowModule {}
