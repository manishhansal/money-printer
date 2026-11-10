/**
 * dhan-api.module.ts
 *
 * NestJS module that registers both the REST client and the WebSocket client
 * for the Dhan/DhanHQ API integration.
 *
 * Providers:
 *  - DhanApiClient        — typed HTTP client for all Dhan REST endpoints.
 *  - DhanWebSocketClient  — persistent WebSocket client for the Dhan market
 *                           feed with exponential-backoff reconnection.
 *
 * Imports:
 *  - NotificationModule   — provides NotificationService, used by
 *                           DhanWebSocketClient to publish connectivity-failure
 *                           and staleness alerts (Requirements 3.4, 3.8).
 *
 * The SecretsModule and ConfigModule are @Global(), so SecretsService and
 * ConfigService are available to all providers without an explicit import.
 *
 * EventEmitter2 is provided globally once EventEmitterModule.forRoot() is
 * invoked (by SessionManagerModule or equivalent); no re-import is needed.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7
 */

import { Module } from '@nestjs/common';
import { DhanApiClient } from './dhan-api.client';
import { DhanWebSocketClient } from './dhan-websocket.client';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    // NotificationModule exports NotificationService, which DhanWebSocketClient
    // uses to publish connectivity-failure and staleness alerts.
    NotificationModule,
  ],
  providers: [DhanApiClient, DhanWebSocketClient],
  exports: [DhanApiClient, DhanWebSocketClient],
})
export class DhanApiModule {}
