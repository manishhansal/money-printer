/**
 * watchdog.module.ts
 *
 * WatchdogModule — wires together the LocalMarketWatchdogService,
 * IssueClassifierService, AutoRemediationService, and WatchdogController.
 *
 * Registers the MonitoringIssues entity for TypeORM injection.
 *
 * Requirements: Phase 16
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MonitoringIssues } from '../../database/entities/monitoring-issues.entity';
import { LocalMarketWatchdogService } from './local-market-watchdog.service';
import { IssueClassifierService } from './issue-classifier.service';
import { AutoRemediationService } from './auto-remediation.service';
import { WatchdogController } from './watchdog.controller';

// Peer module imports — WatchdogModule needs these services
import { RedisModule } from '../redis/redis.module';
import { NotificationModule } from '../notification/notification.module';
import { SystemHealthMonitorModule } from '../system-health-monitor/system-health-monitor.module';
import { DhanApiModule } from '../dhan/dhan-api.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([MonitoringIssues]),
    RedisModule,
    NotificationModule,
    SystemHealthMonitorModule,
    DhanApiModule,
  ],
  controllers: [WatchdogController],
  providers: [LocalMarketWatchdogService, IssueClassifierService, AutoRemediationService],
  exports: [LocalMarketWatchdogService, AutoRemediationService],
})
export class WatchdogModule {}
