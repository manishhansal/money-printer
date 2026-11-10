/**
 * notification.module.ts
 *
 * NestJS module for alert delivery to the Chrome Extension.
 *
 * Provides:
 *  - NotificationGateway  — manages the ws WebSocket server (port WS_PORT, default 3001)
 *  - NotificationService  — priority queue, Redis buffer, retry, ACK tracking
 *
 * Exports NotificationService so other CloudEngine modules can call:
 *  - notificationService.publish(alert)       — deliver or buffer an alert
 *  - notificationService.acknowledge(alertId) — ACK a MAX-priority alert
 *  - notificationService.getPendingAlerts()   — read Redis buffer
 *
 * Dependencies:
 *  - RedisModule (global) — provides REDIS_CLIENT injection token
 *  - ConfigModule (global) — provides ConfigService for WS_PORT lookup
 *
 * Requirements: 12.7, 12.8, 20.9
 */

import { Module } from '@nestjs/common';
import { NotificationGateway } from './notification.gateway';
import { NotificationService } from './notification.service';

@Module({
  providers: [
    // Service must be listed before gateway because the gateway injects it
    NotificationService,
    NotificationGateway,
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
