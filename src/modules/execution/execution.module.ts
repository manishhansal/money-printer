/**
 * execution.module.ts
 *
 * ExecutionModule — full order lifecycle management with 5-check pre-trade
 * validation chain, broker submission, and fill handling.
 *
 * Imports:
 *  - DhanApiModule         — provides DhanApiClient for order placement,
 *                            modification, cancellation, and margin checks.
 *  - RiskManagementModule  — provides RiskManagementService for 8-gate
 *                            pre-entry evaluation (gate check 2 in the chain).
 *  - SessionManagerModule  — provides SessionManagerService for session-phase
 *                            timing checks (check 5 in the chain).
 *  - TypeOrmModule         — registers Orders and Executions repositories.
 *
 * The SecretsModule and ConfigModule are @Global(), so SecretsService is
 * available to ExecutionService without an explicit import here.
 *
 * Requirements: 11.3, 11.4
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Order } from '../../database/entities/orders.entity';
import { Execution } from '../../database/entities/executions.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { Position } from '../../database/entities/positions.entity';
import { DhanApiModule } from '../dhan/dhan-api.module';
import { RiskManagementModule } from '../risk-management/risk-management.module';
import { SessionManagerModule } from '../session-manager/session-manager.module';
import { LiveTradingModule } from '../live-trading/live-trading.module';
import { ExecutionService } from './execution.service';
import { OrdersController } from './orders.controller';

@Module({
  imports: [
    // Provides DhanApiClient for all broker interactions.
    DhanApiModule,

    // Provides RiskManagementService for pre-entry gate evaluation.
    RiskManagementModule,

    // Provides SessionManagerService for session-phase timing checks.
    SessionManagerModule,

    // Provides LiveTradingService for armed-state and new-entry-blocked checks
    // (Requirements 11.1, 11.3 — LIVE orders must not be submitted when DISARMED).
    LiveTradingModule,

    // Registers Orders, Executions, Instruments, and Positions TypeORM repositories.
    TypeOrmModule.forFeature([Order, Execution, Instruments, Position]),
  ],
  providers: [ExecutionService],
  controllers: [OrdersController],
  exports: [ExecutionService],
})
export class ExecutionModule {}
