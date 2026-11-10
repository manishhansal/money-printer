/**
 * redis-channel-wiring.module.ts
 *
 * RedisChannelWiringModule — NestJS feature module that wires all Redis pub/sub
 * channels to the in-process service handlers that consume them.
 *
 * This module acts as the integration layer between Redis event streams and the
 * NestJS service graph, ensuring that:
 *
 *   - `events:regime_change` messages (from MarketRegimeModule) are bridged to
 *     LiveTradingService so its entry-blocking state stays current after regime
 *     transitions.
 *
 *   - `events:session_phase` messages (from SessionManagerModule) are bridged to
 *     LiveTradingService.onSessionPhaseChanged() for phase-aware order gating.
 *
 *   - `events:tick:{instrument_id}` messages (from MarketDataModule) are handled
 *     by PositionMonitoringService via its own onModuleInit() subscriptions.
 *     Importing PositionMonitoringModule here guarantees that service is
 *     instantiated and its tick subscriptions are active before the first tick.
 *
 * Provides:
 *   - RedisChannelWiringService — the wiring service (not exported; this module
 *     is a leaf in the dependency graph with no consumers needing its service).
 *
 * Dependencies:
 *   - PositionMonitoringModule — provides PositionMonitoringService (self-subscribes
 *     to tick channels in its own onModuleInit).
 *   - SessionManagerModule     — provides SessionManagerService (getCurrentPhase).
 *   - LiveTradingModule        — provides LiveTradingService (onSessionPhaseChanged).
 *   - RedisModule (global)     — provides RedisService (subscribe/publish).
 *
 * Requirements: 2.1, 5.3, 17.5
 */

import { Module } from '@nestjs/common';

import { PositionMonitoringModule } from '../position-monitoring/position-monitoring.module';
import { SessionManagerModule } from '../session-manager/session-manager.module';
import { LiveTradingModule } from '../live-trading/live-trading.module';

import { RedisChannelWiringService } from './redis-channel-wiring.service';

@Module({
  imports: [
    // Provides PositionMonitoringService — subscribes to events:tick:{id} channels.
    PositionMonitoringModule,

    // Provides SessionManagerService — getCurrentPhase() used in regime handler.
    SessionManagerModule,

    // Provides LiveTradingService — onSessionPhaseChanged() bridged from Redis.
    LiveTradingModule,
  ],
  providers: [RedisChannelWiringService],
  // Not exported — this module is a wiring leaf with no downstream consumers.
})
export class RedisChannelWiringModule {}
