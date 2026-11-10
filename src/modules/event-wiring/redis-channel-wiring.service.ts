/**
 * redis-channel-wiring.service.ts
 *
 * RedisChannelWiringService — bridges Redis pub/sub channels to in-process
 * NestJS service handlers.
 *
 * Responsibility (task 35.1):
 *   Wire Redis pub/sub channels across the CloudEngine event pipeline:
 *
 *   1. `events:regime_change` (published by MarketRegimeModule)
 *      Consumers: StrategyModule, RiskManagementModule, OptionsIntelligenceModule,
 *      and LiveTradingService (re-syncs the session phase state after a regime
 *      transition so entry-blocking logic stays current).
 *
 *   2. `events:session_phase` (published by SessionManagerModule)
 *      Consumers: StrategyModule, RiskManagementModule, LiveTradingModule,
 *      OptionsIntelligenceModule.
 *      → Directly calls `LiveTradingService.onSessionPhaseChanged()` to bridge
 *        the Redis message to the in-process handler.
 *
 *   3. `events:tick:{instrument_id}` (published by MarketDataModule)
 *      Consumers: TechnicalAnalysisModule, OptionsIntelligenceModule,
 *      PositionMonitoringModule.
 *      → `PositionMonitoringService` self-subscribes via its own `onModuleInit()`.
 *        Injecting it here ensures it is instantiated before this service runs
 *        so its tick subscriptions are registered as part of the same startup wave.
 *
 * Requirements: 2.1, 5.3, 17.5
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import { PositionMonitoringService } from '../position-monitoring/position-monitoring.service';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { LiveTradingService } from '../live-trading/live-trading.service';

import { REGIME_CHANGE_CHANNEL, RegimeChangeEvent } from '../market-regime/market-regime.types';
import {
  SESSION_PHASE_CHANNEL,
  SessionPhaseChangeEvent,
} from '../session-manager/session-manager.types';

@Injectable()
export class RedisChannelWiringService implements OnModuleInit {
  private readonly logger = new Logger(RedisChannelWiringService.name);

  constructor(
    private readonly redisService: RedisService,
    /**
     * Injected to guarantee PositionMonitoringService is instantiated during
     * the same NestJS startup wave as this service, so its own onModuleInit()
     * registers all events:tick:{instrument_id} Redis subscriptions before
     * the first market tick arrives.  No direct calls are made to this service
     * from within RedisChannelWiringService.
     */
    private readonly positionMonitoringService: PositionMonitoringService,
    private readonly sessionManagerService: SessionManagerService,
    private readonly liveTradingService: LiveTradingService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Wire all Redis pub/sub channel subscriptions on module startup.
   *
   * Called automatically by NestJS after all module dependencies are resolved.
   * By this point, PositionMonitoringService.onModuleInit() has already run
   * (NestJS initialises providers in dependency order), so tick subscriptions
   * are active before the first wiring subscription is added.
   *
   * Requirements: 2.1, 5.3, 17.5
   */
  async onModuleInit(): Promise<void> {
    await this.wireRegimeChangeChannel();
    await this.wireSessionPhaseChannel();

    this.logger.log(
      'RedisChannelWiringService initialised. ' +
        `Subscribed to: [${REGIME_CHANGE_CHANNEL}], [${SESSION_PHASE_CHANNEL}]. ` +
        `PositionMonitoringService is managing tick subscriptions for ` +
        `${this.positionMonitoringService.getTrackedPositionIds().length} position(s).`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private wiring methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to `events:regime_change` and bridge each message to
   * `LiveTradingService.onSessionPhaseChanged()`.
   *
   * When a regime transition arrives over Redis, LiveTradingService is
   * re-notified with the CURRENT session phase so its entry-blocking state
   * remains in sync.  The regime payload's `classifiedAt` timestamp is used
   * as the event timestamp to preserve causality ordering in audit logs.
   *
   * Requirement 5.3: regime-change events must be consumed within 30 seconds
   * of the triggering classification.
   */
  private async wireRegimeChangeChannel(): Promise<void> {
    await this.redisService.subscribe(
      REGIME_CHANGE_CHANNEL,
      (_channel: string, message: string) => {
        try {
          const payload = JSON.parse(message) as RegimeChangeEvent;

          // Revive classifiedAt string → proper Date object.
          const classifiedAt = new Date(payload.classifiedAt);

          // Re-sync LiveTradingService with the current session phase.
          // The session phase itself has not changed; we re-send it so
          // any entry-blocking logic that depends on both regime and phase
          // is evaluated with fresh context after the regime transition.
          const currentPhase = this.sessionManagerService.getCurrentPhase();

          this.liveTradingService.onSessionPhaseChanged({
            phase: currentPhase,
            previousPhase: currentPhase,
            timestamp: classifiedAt,
          });

          this.logger.debug(
            `[${REGIME_CHANGE_CHANNEL}] Regime change: ` +
              `${String(payload.previousRegime) ?? 'none'} → ${payload.regime}. ` +
              `LiveTradingService notified — current session phase: ${currentPhase}.`,
          );
        } catch (err) {
          this.logger.error(
            `[${REGIME_CHANGE_CHANNEL}] Failed to process message: ` + `${(err as Error).message}`,
          );
        }
      },
    );
  }

  /**
   * Subscribe to `events:session_phase` and bridge each message directly to
   * `LiveTradingService.onSessionPhaseChanged()`.
   *
   * This wires the Redis pub/sub message (published by SessionManagerService)
   * to the in-process LiveTradingService handler so that the phase is updated
   * even if the intra-process NestJS EventEmitter is unavailable or the
   * modules run in separate contexts.
   *
   * Requirement 17.5: session-phase-change events SHALL be consumed by
   * LiveTradingModule.
   */
  private async wireSessionPhaseChannel(): Promise<void> {
    await this.redisService.subscribe(
      SESSION_PHASE_CHANNEL,
      (_channel: string, message: string) => {
        try {
          const payload = JSON.parse(message) as SessionPhaseChangeEvent;

          // Revive timestamp string → proper Date object (JSON.parse returns
          // Date fields as ISO-8601 strings).
          payload.timestamp = new Date(payload.timestamp);

          this.liveTradingService.onSessionPhaseChanged(payload);

          this.logger.debug(
            `[${SESSION_PHASE_CHANNEL}] Session phase: ` +
              `${payload.previousPhase} → ${payload.phase}. ` +
              `LiveTradingService notified.`,
          );
        } catch (err) {
          this.logger.error(
            `[${SESSION_PHASE_CHANNEL}] Failed to process message: ` + `${(err as Error).message}`,
          );
        }
      },
    );
  }
}
