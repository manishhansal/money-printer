/**
 * live-trading.controller.ts
 *
 * REST endpoints for the live trading engine arm/disarm controls.
 * Called by the React dashboard LiveControls panel and the popup.ts.
 *
 * POST /live-trading/arm/request  → DISARMED → ARMED_PENDING
 * POST /live-trading/arm/confirm  → ARMED_PENDING → ARMED
 * POST /live-trading/arm/disarm   → any → DISARMED
 * POST /live-trading/kill-switch  → activates kill switch
 * GET  /live-trading/status        → current armed state
 */

import { Controller, Get, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { LiveTradingService } from './live-trading.service';
import { ArmedState } from './live-trading.types';

export interface LiveStatusResponse {
  armedState: ArmedState;
  isKillSwitchActive: boolean;
  isNewEntryBlocked: boolean;
}

@Controller('live-trading')
export class LiveTradingController {
  constructor(private readonly liveTradingService: LiveTradingService) {}

  /**
   * GET /live-trading/status
   * Returns the current engine armed state for the React dashboard.
   */
  @Get('status')
  getStatus(): LiveStatusResponse {
    return {
      armedState: this.liveTradingService.getArmedState(),
      isKillSwitchActive: this.liveTradingService.isKillSwitchActive(),
      isNewEntryBlocked: this.liveTradingService.isNewEntryBlocked(),
    };
  }

  /**
   * POST /live-trading/arm/request
   * Step 1 of the two-step arm sequence: DISARMED → ARMED_PENDING.
   */
  @Post('arm/request')
  @HttpCode(HttpStatus.OK)
  requestArm(): LiveStatusResponse {
    this.liveTradingService.requestArm();
    return this.getStatus();
  }

  /**
   * POST /live-trading/arm/confirm
   * Step 2: ARMED_PENDING → ARMED.
   */
  @Post('arm/confirm')
  @HttpCode(HttpStatus.OK)
  confirmArm(): LiveStatusResponse {
    this.liveTradingService.confirmArm();
    return this.getStatus();
  }

  /**
   * POST /live-trading/arm/disarm
   * Unconditional disarm from any state.
   */
  @Post('arm/disarm')
  @HttpCode(HttpStatus.OK)
  disarm(): LiveStatusResponse {
    this.liveTradingService.disarm();
    return this.getStatus();
  }

  /**
   * POST /live-trading/kill-switch
   * Activate the emergency kill switch — cancels all open orders and
   * exits all LIVE positions.
   */
  @Post('kill-switch')
  @HttpCode(HttpStatus.ACCEPTED)
  async killSwitch(): Promise<{ message: string }> {
    await this.liveTradingService.activateKillSwitch();
    return {
      message: 'Kill switch activated — all open orders cancelled, positions being closed.',
    };
  }
}
