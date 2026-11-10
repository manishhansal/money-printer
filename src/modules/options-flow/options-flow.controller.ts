/**
 * options-flow.controller.ts
 *
 * REST endpoint for the Options Flow Dashboard.
 *
 * Endpoints:
 *   GET /options-flow/dashboard — returns aggregated options-flow metrics for
 *                                  all monitored instruments with staleness
 *                                  indicators.
 *
 * All endpoints require a valid JWT (JwtAuthGuard).
 *
 * Requirements: 20.6, 20.7
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionsFlowService } from './options-flow.service';
import { OptionsFlowDashboard } from './options-flow.types';

@Controller('options-flow')
export class OptionsFlowController {
  constructor(private readonly optionsFlowService: OptionsFlowService) {}

  /**
   * Returns the current Options Flow Dashboard.
   *
   * The response includes:
   *  - One OptionsFlowSnapshot per subscribed instrument with computed
   *    netOiChange, putCallRatio, ivSkew, and largeBlockDetected values.
   *  - isStale=true for any snapshot whose data is older than 60 seconds.
   *  - suppressOptionsFuturesScore=true when any snapshot is stale, signalling
   *    to the caller that the Options/Futures Confirmation score must be
   *    suppressed (Requirement 20.7).
   *  - generatedAt timestamp of when this response was assembled.
   *
   * Example:
   *   GET /options-flow/dashboard
   */
  @UseGuards(JwtAuthGuard)
  @Get('dashboard')
  getDashboard(): OptionsFlowDashboard {
    return this.optionsFlowService.getDashboard();
  }
}
