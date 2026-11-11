/**
 * paper-trading.module.ts
 *
 * NestJS module for the PaperEngine — fully isolated paper-trading simulation.
 *
 * Isolation guarantees (Requirement 10.1):
 *  - Registers its own TypeORM repositories for the four dedicated paper tables:
 *    `paper_orders`, `paper_executions`, `paper_positions`, `paper_trades`.
 *    The live `orders`, `executions`, `positions`, `trades` repositories are
 *    NOT imported here.
 *  - Does NOT import LiveTradingModule, ExecutionModule, or any LiveEngine service.
 *  - Uses the global RedisModule exclusively for `paper:*` key writes and
 *    `events:paper:*` channel publishes.
 *
 * Providers:
 *  - PaperTradingService — the simulation engine.
 *
 * Exports:
 *  - PaperTradingService — available for StrategyModule, SignalScoringModule,
 *    and AnalyticsModule to inject without creating duplicate instances.
 *
 * Requirements: 10.1
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PaperOrder } from '../../database/entities/paper-orders.entity';
import { PaperExecution } from '../../database/entities/paper-executions.entity';
import { PaperPosition } from '../../database/entities/paper-positions.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { UserSettings } from '../../database/entities/user-settings.entity';

import { TradingChargesModule } from '../charges/trading-charges.module';
import { PaperTradingService } from './paper-trading.service';
import { PaperTradingController } from './paper-trading.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([PaperOrder, PaperExecution, PaperPosition, PaperTrade]),
    TradingChargesModule,
    TypeOrmModule.forFeature([UserSettings]),
  ],
  controllers: [PaperTradingController],
  providers: [PaperTradingService],
  exports: [PaperTradingService],
})
export class PaperTradingModule {}
