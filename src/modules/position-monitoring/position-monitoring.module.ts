/**
 * position-monitoring.module.ts
 *
 * PositionMonitoringModule — NestJS feature module for real-time position
 * monitoring, MFE/MAE tracking, exit-condition evaluation, and unrealized
 * P&L feed to the RiskEngine.
 *
 * Provides:
 *   - PositionMonitoringService: tick-driven position monitor.
 *
 * Exports:
 *   - PositionMonitoringService: consumed by LiveTradingModule, PaperTradingModule,
 *     ExecutionService, and TrailingStopModule to register / deregister positions
 *     and to listen for POSITION_EXIT_EVENT / UNREALIZED_PNL_UPDATED_EVENT.
 *
 * Dependencies:
 *   - TypeOrmModule.forFeature([Position]): provides the Position repository
 *     used to load open positions on startup and to look up positions by ID.
 *   - RedisModule (global): supplies RedisService for pub/sub tick subscription.
 *   - EventEmitterModule: supplies EventEmitter2 for intra-process event emission
 *     (POSITION_EXIT_EVENT, UNREALIZED_PNL_UPDATED_EVENT).
 *   - ConfigModule (global): ConfigService available without explicit import.
 *
 * Requirements: 7.4, 9.4, 12.2
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { Position } from '../../database/entities/positions.entity';
import { PositionMonitoringService } from './position-monitoring.service';
import { GreedyTrailService } from './greedy-trail.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Position]),
    EventEmitterModule.forRoot(),
  ],
  providers: [PositionMonitoringService, GreedyTrailService],
  exports: [PositionMonitoringService],
})
export class PositionMonitoringModule {}
