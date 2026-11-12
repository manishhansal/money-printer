/**
 * risk-state.controller.ts
 *
 * GET /risk/state/:engine — returns current daily loss machine state for
 * the React RiskCenter panel.
 */

import { Controller, Get, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DailyLossStateMachineService } from './daily-loss-state-machine.service';
import { PortfolioService } from '../portfolio/portfolio.service';

export interface RiskStateResponse {
  engine: string;
  dailyLossState: string;
  losingTradeCount: number;
  dailyLossLimitRupees: number;
  currentDailyLoss: number;
  openPositionsCount: number;
  maxConcurrentTrades: number;
}

@Controller('risk')
export class RiskStateController {
  constructor(
    private readonly dailyLossStateMachine: DailyLossStateMachineService,
    private readonly portfolioService: PortfolioService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * GET /risk/state/:engine
   *
   * Returns real-time risk engine state for the React RiskCenter panel.
   *
   *  - dailyLossState     → DailyLossStateMachineService.getCurrentState()
   *  - losingTradeCount   → DailyLossStateMachineService.getLosingTradeCount()
   *  - currentDailyLoss   → DailyLossStateMachineService.getCurrentDailyLoss()
   *  - openPositionsCount → PortfolioService.getOpenPositions().length
   *  - dailyLossLimitRupees / maxConcurrentTrades → ConfigService env vars
   */
  @Get('state/:engine')
  getRiskState(@Param('engine') engine: string): RiskStateResponse {
    const eng = (engine === 'LIVE' ? 'LIVE' : 'PAPER') as 'LIVE' | 'PAPER';

    return {
      engine: eng,
      dailyLossState: this.dailyLossStateMachine.getCurrentState(eng),
      losingTradeCount: this.dailyLossStateMachine.getLosingTradeCount(eng),
      dailyLossLimitRupees: this.configService.get<number>('DAILY_LOSS_LIMIT_RUPEES', 10000),
      currentDailyLoss: this.dailyLossStateMachine.getCurrentDailyLoss(eng),
      openPositionsCount: this.portfolioService.getOpenPositions(eng).length,
      maxConcurrentTrades: this.configService.get<number>('MAX_CONCURRENT_TRADES', 5),
    };
  }
}
