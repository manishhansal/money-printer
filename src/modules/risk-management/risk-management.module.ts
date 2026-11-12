/**
 * RiskManagementModule — authoritative pre-entry risk gatekeeper.
 *
 * Provides:
 *   - RiskManagementService:          position sizing (Req 9.2) and 8-gate pre-entry
 *                                     evaluation (Req 9.5).
 *   - DailyLossStateMachineService:   per-engine daily loss state machine
 *                                     (TWO_LOSS_LOCKOUT / EMERGENCY_HALT / KILL_SWITCH_ACTIVE)
 *                                     with RiskEvents persistence and NotificationService
 *                                     integration (Req 9.3, 9.4, 9.8).
 *   - RiskEventRecorderService:       persists ZERO_PER_UNIT_RISK and INVALID_LOT_SIZE
 *                                     rejection events to the RiskEvents table (Req 9.9, 9.11).
 *
 * Dependencies:
 *   - ConfigModule (global): ConfigService available without explicit import.
 *   - TypeOrmModule.forFeature([RiskEvents]): RiskEvents repository for audit log.
 *   - NotificationModule: NotificationService for priority alert delivery.
 *   - ScheduleModule.forRoot(): enables @Cron decorator on resetDailyState().
 *
 * Usage:
 *   Import RiskManagementModule in any feature module that needs risk
 *   gating — e.g. LiveTradingModule, PaperTradingModule, ExecutionModule.
 *
 * Requirements: 9.2, 9.3, 9.4, 9.5, 9.8, 9.9, 9.11
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { RiskEvents } from '../../database/entities/risk-events.entity';
import { NotificationModule } from '../notification/notification.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { RiskManagementService } from './risk-management.service';
import { DailyLossStateMachineService } from './daily-loss-state-machine.service';
import { RiskEventRecorderService } from './risk-event-recorder.service';
import { RiskStateController } from './risk-state.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([RiskEvents]),
    NotificationModule,
    ScheduleModule.forRoot(),
    // Provides PortfolioService for real openPositionsCount in RiskStateController.
    PortfolioModule,
  ],
  providers: [RiskManagementService, DailyLossStateMachineService, RiskEventRecorderService],
  controllers: [RiskStateController],
  exports: [RiskManagementService, DailyLossStateMachineService, RiskEventRecorderService],
})
export class RiskManagementModule {}
