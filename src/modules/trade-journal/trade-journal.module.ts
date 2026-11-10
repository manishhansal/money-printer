/**
 * TradeJournalModule — NestJS module wrapping the append-only trade journal.
 *
 * Registers TypeORM repositories for all 8 journal record sets and exports
 * TradeJournalService so other modules can inject it for audit writes.
 *
 * Record set → entity mapping:
 *   signals              → Signals
 *   rejected_signals     → Signals (status = 'rejected')
 *   orders               → Order
 *   fills                → Execution
 *   positions            → Position
 *   completed_trades     → Trade
 *   risk_events          → RiskEvents
 *   system_errors        → SystemHealthEvents
 *   configuration_changes → AuditLogs
 *
 * Alert forwarding (Requirement 13.7):
 *   TradeJournalAlertListener subscribes to JOURNAL_WRITE_FAILED_EVENT and
 *   forwards it to NotificationService as a CRITICAL-priority alert.
 *   NotificationModule is imported here so that NotificationService is
 *   available to the listener.  The listener uses @Optional() injection so
 *   the module degrades gracefully if NotificationModule is absent.
 *
 * The EventEmitterModule must be registered globally (via AppModule) for the
 * retry-failure alert path to function.  RedisModule provides the command
 * client if needed for future rate-limited alert de-duplication.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Signals } from '../../database/entities/signals.entity';
import { Order } from '../../database/entities/orders.entity';
import { Execution } from '../../database/entities/executions.entity';
import { Position } from '../../database/entities/positions.entity';
import { Trade } from '../../database/entities/trades.entity';
import { RiskEvents } from '../../database/entities/risk-events.entity';
import { SystemHealthEvents } from '../../database/entities/system-health-events.entity';
import { AuditLogs } from '../../database/entities/audit-logs.entity';

import { NotificationModule } from '../notification/notification.module';

import { TradeJournalService } from './trade-journal.service';
import { TradeJournalAlertListener } from './trade-journal-alert.listener';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Signals,
      Order,
      Execution,
      Position,
      Trade,
      RiskEvents,
      SystemHealthEvents,
      AuditLogs,
    ]),
    // Provides NotificationService to TradeJournalAlertListener so that
    // all-retry-failure events are forwarded as CRITICAL operator alerts.
    NotificationModule,
  ],
  providers: [TradeJournalService, TradeJournalAlertListener],
  exports: [TradeJournalService],
})
export class TradeJournalModule {}
