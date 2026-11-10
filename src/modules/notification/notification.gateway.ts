/**
 * notification.gateway.ts
 *
 * WebSocket gateway for real-time alert delivery to the Chrome Extension.
 *
 * Implemented with the `ws` library directly (a supported alternative to
 * @nestjs/websockets decorators) so the gateway is self-contained — no
 * adapter setup is required in main.ts.
 *
 * Transport protocol:
 *   Server → Client push:
 *     { "event": "notification", "data": <NotificationAlert> }
 *
 *   Client → Server acknowledgment (MAX-priority only):
 *     { "event": "ack", "data": { "alertId": "<uuid>" } }
 *
 * Port: WS_PORT env var (default: 3001).
 *
 * Requirements: 12.7, 12.8, 20.9
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket, Server as WsServer, RawData } from 'ws';
import { NotificationService } from './notification.service';
import { NotificationAlert } from './notification.types';

interface WsMessage {
  event: string;
  data: unknown;
}

/**
 * NotificationGateway manages the WebSocket server lifecycle, tracks connected
 * Extension clients, broadcasts alert payloads, and forwards acknowledgments to
 * NotificationService.
 *
 * On new client connection → triggers NotificationService.flushBuffer() so
 * buffered alerts are replayed in priority order (MAX → CRITICAL → WARNING → INFO).
 */
@Injectable()
export class NotificationGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationGateway.name);
  private server!: WsServer;
  private readonly clients = new Set<WebSocket>();

  constructor(
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  onModuleInit(): void {
    const port = this.configService.get<number>('WS_PORT', 3001);

    this.server = new WsServer({ port });

    this.server.on('connection', (client: WebSocket) => {
      this.handleConnection(client);
    });

    this.server.on('error', (err: Error) => {
      this.logger.error(`WebSocket server error: ${err.message}`);
    });

    this.logger.log(`WebSocket notification gateway started on port ${port}`);

    // Register delivery callbacks with the service so publish() can
    // broadcast without creating a circular module dependency.
    this.notificationService.registerDelivery(
      (alert: NotificationAlert) => this.broadcast(alert),
      () => this.hasConnectedClients(),
    );
  }

  onModuleDestroy(): void {
    // Cleanly close all client connections then shut down the server
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();

    this.server.close(() => {
      this.logger.log('WebSocket notification gateway closed');
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Connection management
  // ─────────────────────────────────────────────────────────────────────────

  private handleConnection(client: WebSocket): void {
    this.clients.add(client);
    this.logger.log(`Extension client connected — total clients: ${this.clients.size}`);

    client.on('message', (data: RawData) => {
      void this.handleMessage(client, data);
    });

    client.on('close', () => {
      this.clients.delete(client);
      this.logger.log(`Extension client disconnected — total clients: ${this.clients.size}`);
    });

    client.on('error', (err: Error) => {
      this.logger.error(`Client WebSocket error: ${err.message}`);
      this.clients.delete(client);
    });

    // Replay buffered alerts from Redis in priority order now that a client
    // has reconnected (Requirement 12.7 — no alert silently dropped).
    void this.notificationService.flushBuffer();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message handling
  // ─────────────────────────────────────────────────────────────────────────

  private async handleMessage(_client: WebSocket, raw: RawData): Promise<void> {
    try {
      const msg = JSON.parse(raw.toString()) as WsMessage;

      if (msg.event === 'ack') {
        const payload = msg.data as { alertId?: string };
        if (!payload?.alertId) {
          this.logger.warn('Received ack event without alertId');
          return;
        }
        // Forward to service — tracks acknowledgment for MAX-priority alerts
        // (Requirements 12.8, 12.9: enables TrailingStopEngine SL counter reset)
        await this.notificationService.acknowledge(payload.alertId);
      }
    } catch (err) {
      this.logger.error(`Failed to parse incoming WebSocket message: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Broadcast
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send an alert to all currently open Extension clients.
   *
   * @returns true if the alert was sent to at least one connected client.
   *          false if no clients are connected or all connections are closed.
   */
  broadcast(alert: NotificationAlert): boolean {
    if (this.clients.size === 0) return false;

    const payload = JSON.stringify({ event: 'notification', data: alert });
    let sentToAtLeastOne = false;

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sentToAtLeastOne = true;
      } else if (
        client.readyState === WebSocket.CLOSED ||
        client.readyState === WebSocket.CLOSING
      ) {
        // Prune stale references
        this.clients.delete(client);
      }
    }

    return sentToAtLeastOne;
  }

  /** Returns true if at least one Extension client is actively connected */
  hasConnectedClients(): boolean {
    return this.clients.size > 0;
  }

  /** Returns the current count of connected Extension clients */
  getConnectedClientCount(): number {
    return this.clients.size;
  }
}
