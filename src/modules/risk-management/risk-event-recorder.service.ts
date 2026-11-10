/**
 * RiskEventRecorderService — persists pre-entry gate rejection events.
 *
 * Records ZERO_PER_UNIT_RISK and INVALID_LOT_SIZE rejections to the
 * RiskEvents table whenever RiskManagementService.evaluatePreEntryGates()
 * rejects on gates 2 or 3.
 *
 * Both methods are fire-and-forget: DB failures are logged at ERROR level
 * but are caught internally and do not propagate to the caller.
 *
 * Requirements: 9.9, 9.11
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RiskEvents } from '../../database/entities/risk-events.entity';
import { EngineType } from '../../database/entities/capital-ledgers.entity';

@Injectable()
export class RiskEventRecorderService {
  private readonly logger = new Logger(RiskEventRecorderService.name);

  constructor(
    @InjectRepository(RiskEvents)
    private readonly riskEventsRepo: Repository<RiskEvents>,
  ) {}

  /**
   * Records a ZERO_PER_UNIT_RISK rejection to the RiskEvents table.
   *
   * Triggered when |entry_price − stop_loss_price| = 0 (Req 9.9).
   *
   * Persisted fields:
   *   event_type:              'ZERO_PER_UNIT_RISK'
   *   reason:                  'zero per-unit risk'
   *   triggering_metric_name:  'entry_stop_difference'
   *   triggering_metric_value: '0'
   *   initiating_actor:        'RiskManagementService'
   *
   * @param engine        Trading engine context ('LIVE' | 'PAPER').
   * @param entryPrice    Proposed entry price at the time of rejection.
   * @param stopLossPrice Proposed stop-loss price (equals entryPrice when this fires).
   */
  async recordZeroPerUnitRisk(
    engine: EngineType,
    entryPrice: string,
    stopLossPrice: string,
  ): Promise<void> {
    try {
      const event = this.riskEventsRepo.create({
        engine,
        event_type: 'ZERO_PER_UNIT_RISK',
        reason: 'zero per-unit risk',
        triggering_metric_name: 'entry_stop_difference',
        triggering_metric_value: '0',
        threshold_value: null,
        affected_instrument_id: null,
        affected_strategy_id: null,
        initiating_actor: 'RiskManagementService',
        occurred_at: new Date(),
      });
      await this.riskEventsRepo.save(event);
      this.logger.debug(
        `[${engine}] Persisted ZERO_PER_UNIT_RISK RiskEvent (entry=${entryPrice}, stop=${stopLossPrice})`,
      );
    } catch (err) {
      this.logger.error(
        `[${engine}] Failed to persist ZERO_PER_UNIT_RISK RiskEvent: ` +
          `${(err as Error).message}`,
      );
    }
  }

  /**
   * Records an INVALID_LOT_SIZE rejection to the RiskEvents table.
   *
   * Triggered when lot_size ≤ 0 or is not configured (Req 9.11).
   *
   * Persisted fields:
   *   event_type:              'INVALID_LOT_SIZE'
   *   reason:                  'invalid lot_size configuration'
   *   triggering_metric_name:  'lot_size'
   *   triggering_metric_value: lotSize.toString()
   *   initiating_actor:        'RiskManagementService'
   *
   * @param engine  Trading engine context ('LIVE' | 'PAPER').
   * @param lotSize The invalid lot_size value that triggered the rejection.
   */
  async recordInvalidLotSize(engine: EngineType, lotSize: number): Promise<void> {
    try {
      const event = this.riskEventsRepo.create({
        engine,
        event_type: 'INVALID_LOT_SIZE',
        reason: 'invalid lot_size configuration',
        triggering_metric_name: 'lot_size',
        triggering_metric_value: lotSize.toString(),
        threshold_value: null,
        affected_instrument_id: null,
        affected_strategy_id: null,
        initiating_actor: 'RiskManagementService',
        occurred_at: new Date(),
      });
      await this.riskEventsRepo.save(event);
      this.logger.debug(`[${engine}] Persisted INVALID_LOT_SIZE RiskEvent (lot_size=${lotSize})`);
    } catch (err) {
      this.logger.error(
        `[${engine}] Failed to persist INVALID_LOT_SIZE RiskEvent: ` + `${(err as Error).message}`,
      );
    }
  }
}
