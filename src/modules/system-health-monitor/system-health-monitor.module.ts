/**
 * system-health-monitor.module.ts
 *
 * NestJS module for CloudEngine operational health monitoring.
 *
 * Provides:
 *  - SystemHealthMonitorService — 30-second metric polling, Redis key
 *    persistence, transition alerting, and passive status intake via
 *    updateMetricStatus().
 *
 * Exports:
 *  - SystemHealthMonitorService — consumed by any module that needs to query
 *    getHealthSnapshot() or report its own status via updateMetricStatus().
 *
 * Dependencies:
 *  - ScheduleModule.forRoot()  — enables the @Cron every-30-second decorator.
 *    Safe to import in multiple modules; NestJS deduplicates forRoot() calls.
 *  - RedisModule (global)      — provides RedisService for health:{metric} key
 *    writes and the isHealthy() PING check.
 *  - NotificationModule        — provides NotificationService for CRITICAL
 *    transition alerts and periodic INFO summaries.
 *
 * TypeORM DataSource is injected optionally (@Optional) so the module starts
 * cleanly even when TypeORM is not configured in the host application (e.g.
 * during isolated unit tests).
 *
 * Requirements: 2.7, 2.8, 20.8, 20.9
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NotificationModule } from '../notification/notification.module';
import { SystemHealthMonitorService } from './system-health-monitor.service';

@Module({
  imports: [
    // Enables the @Cron('*/30 * * * * *') decorator on pollHealth().
    // NestJS deduplicates multiple forRoot() calls across modules.
    ScheduleModule.forRoot(),

    // Provides NotificationService for CRITICAL alerts and INFO summaries.
    NotificationModule,
  ],
  providers: [SystemHealthMonitorService],
  exports: [SystemHealthMonitorService],
})
export class SystemHealthMonitorModule {}
