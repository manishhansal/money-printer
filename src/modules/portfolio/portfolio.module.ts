/**
 * PortfolioModule — in-memory portfolio state and Dynamic_Capital tracking.
 *
 * Provides:
 *   - PortfolioService: maintains open positions (per engine) and Dynamic_Capital,
 *     backed by PostgreSQL via CapitalLedgers, Position, and UserSettings repositories.
 *
 * Dynamic_Capital formula:
 *   starting_capital + SUM(realized net_pnl for all closed trades for this engine)
 *
 * The EventEmitterModule must be registered globally (via AppModule) for the
 * `capital.ledger.failure` signal-halt path to function.
 *
 * Import this module in any feature module that needs to read Dynamic_Capital
 * (e.g., RiskManagementModule for position sizing) or manage open positions
 * (e.g., ExecutionService, PaperEngine).
 *
 * Requirements: 9.1, 18.2, 18.3, 18.4
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CapitalLedgers } from '../../database/entities/capital-ledgers.entity';
import { Position } from '../../database/entities/positions.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { Trade } from '../../database/entities/trades.entity';
import { UserSettings } from '../../database/entities/user-settings.entity';
import { SystemHealthEvents } from '../../database/entities/system-health-events.entity';

import { PortfolioService } from './portfolio.service';
import { PortfolioController } from './portfolio.controller';
import { SettingsController } from './settings.controller';
import { TradesController } from './trades.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CapitalLedgers,
      Position,
      PaperTrade,
      Trade,
      UserSettings,
      SystemHealthEvents,
    ]),
  ],
  controllers: [PortfolioController, SettingsController, TradesController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
