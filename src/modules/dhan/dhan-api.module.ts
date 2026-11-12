/**
 * dhan-api.module.ts
 *
 * NestJS module that registers both the REST client, the market-data WebSocket
 * client, the order-update WebSocket client, and the token watcher service.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, Phase 10
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DhanApiClient } from './dhan-api.client';
import { DhanWebSocketClient } from './dhan-websocket.client';
import { DhanTokenWatcherService } from './dhan-token-watcher.service';
import { DhanOrderUpdateClient } from './dhan-order-update.client';
import { NotificationModule } from '../notification/notification.module';
import { Order } from '../../database/entities/orders.entity';

@Module({
  imports: [
    // NotificationService for connectivity-failure, staleness, and token-expiry alerts.
    NotificationModule,
    // Orders repository for DhanOrderUpdateClient fill reconciliation.
    TypeOrmModule.forFeature([Order]),
    // Note: LiveTradingModule is NOT imported here to avoid circular dependency.
    // DhanTokenWatcherService emits `dhan.token.expired` which LiveTradingService handles.
  ],
  providers: [DhanApiClient, DhanWebSocketClient, DhanTokenWatcherService, DhanOrderUpdateClient],
  exports: [DhanApiClient, DhanWebSocketClient, DhanTokenWatcherService, DhanOrderUpdateClient],
})
export class DhanApiModule {}
