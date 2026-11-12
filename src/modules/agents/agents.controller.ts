/**
 * agents.controller.ts
 *
 * REST API for the multi-agent intelligence engine.
 *
 * Routes:
 *   POST /agents/research      — trigger a full research workflow
 *   GET  /agents/status        — LLM provider status and config
 *
 * Requirements: Phase 3, 4
 */

import { Controller, Post, Get, Body, BadRequestException } from '@nestjs/common';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { LlmClientService } from './llm-client.service';
import { MarketContext } from './agent.types';
import { IsString, IsNumber, IsIn, IsOptional, Min, Max } from 'class-validator';

class TriggerResearchDto {
  @IsString()
  underlying!: string;

  @IsNumber()
  @Min(1)
  currentLtp!: number;

  @IsNumber()
  vwap!: number;

  @IsNumber()
  @Min(0)
  atr14!: number;

  @IsNumber()
  openingRangeHigh!: number;

  @IsNumber()
  openingRangeLow!: number;

  @IsNumber()
  dayOpen!: number;

  @IsNumber()
  dayHigh!: number;

  @IsNumber()
  dayLow!: number;

  @IsString()
  marketRegime!: string;

  @IsNumber()
  @Min(0)
  vix!: number;

  @IsNumber()
  @Min(0)
  pcr!: number;

  @IsNumber()
  @Min(0)
  ivAtm!: number;

  @IsIn(['EXPANDING', 'CONTRACTING', 'NEUTRAL'])
  ivRegime!: 'EXPANDING' | 'CONTRACTING' | 'NEUTRAL';

  @IsNumber()
  @Min(0)
  relativeVolume!: number;

  @IsNumber()
  ema9!: number;

  @IsNumber()
  ema21!: number;

  @IsNumber()
  ema50!: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  rsi14!: number;

  @IsIn(['BULLISH', 'BEARISH', 'NEUTRAL'])
  macdSignal!: 'BULLISH' | 'BEARISH' | 'NEUTRAL';

  @IsNumber()
  netOiChange!: number;

  @IsString()
  @IsOptional()
  sessionPhase?: string;
}

@Controller('agents')
export class AgentsController {
  constructor(
    private readonly orchestrator: AgentOrchestratorService,
    private readonly llm: LlmClientService,
  ) {}

  /**
   * POST /agents/research
   * Trigger a full 6-phase research workflow with the provided market context.
   * Returns a ResearchDecision — not a broker order.
   */
  @Post('research')
  async triggerResearch(@Body() dto: TriggerResearchDto) {
    if (!dto.underlying || dto.currentLtp <= 0) {
      throw new BadRequestException('underlying and currentLtp are required');
    }

    const context: MarketContext = {
      snapshotAt: new Date(),
      underlying: dto.underlying,
      currentLtp: dto.currentLtp,
      vwap: dto.vwap,
      atr14: dto.atr14,
      openingRange: { high: dto.openingRangeHigh, low: dto.openingRangeLow },
      dayOpen: dto.dayOpen,
      dayHigh: dto.dayHigh,
      dayLow: dto.dayLow,
      marketRegime: dto.marketRegime,
      vix: dto.vix,
      pcr: dto.pcr,
      ivAtm: dto.ivAtm,
      ivRegime: dto.ivRegime,
      relativeVolume: dto.relativeVolume,
      ema9: dto.ema9,
      ema21: dto.ema21,
      ema50: dto.ema50,
      rsi14: dto.rsi14,
      macdSignal: dto.macdSignal,
      netOiChange: dto.netOiChange,
      sessionPhase: dto.sessionPhase ?? 'UNKNOWN',
    };

    const decision = await this.orchestrator.runWorkflow(context);
    return decision;
  }

  /**
   * GET /agents/status
   * Returns current LLM provider configuration (no secrets exposed).
   *
   * availabilityStatus breakdown:
   *   DISABLED            — rule-based mode, no API calls
   *   CREDENTIALS_MISSING — provider configured but API key absent
   *   CONFIGURED          — key present, connectivity not verified
   */
  @Get('status')
  async getStatus() {
    const availabilityStatus = await this.llm.getAvailabilityStatus();
    return {
      provider: this.llm.getProvider(),
      availabilityStatus,
      /** @deprecated use availabilityStatus instead */
      available: availabilityStatus === 'CONFIGURED',
      fallbackMode: availabilityStatus !== 'CONFIGURED' ? 'rule-based analysis' : null,
    };
  }
}
