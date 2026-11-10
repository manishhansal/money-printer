/**
 * SignalScoringController — REST endpoints for signal intelligence.
 *
 * Endpoints:
 *   GET /signals/ranked  — returns all active signals ordered by composite
 *                          score, estimated expected value, and regime
 *                          alignment strength (Req 20.1).
 *
 * All endpoints require a valid JWT (JwtAuthGuard).
 *
 * Requirements: 20.1
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OpportunityRankingService } from './opportunity-ranking.service';
import { RankedSignal } from './signal-scoring.types';

@Controller('signals')
export class SignalScoringController {
  constructor(private readonly opportunityRankingService: OpportunityRankingService) {}

  /**
   * Returns all active signals ranked by composite score, estimated expected
   * value, and regime alignment strength (all descending).
   *
   * @param currentRegime - Optional query param.  When supplied, signals whose
   *   stored regime matches receive alignment strength 3 (highest priority).
   *   When omitted, all signals receive alignment strength 2 (unverifiable).
   *
   * @returns Array of `RankedSignal` objects, sorted by rank ascending.
   *
   * Example:
   *   GET /signals/ranked?currentRegime=STRONG_BULL
   */
  @UseGuards(JwtAuthGuard)
  @Get('ranked')
  async getRankedSignals(@Query('currentRegime') currentRegime?: string): Promise<RankedSignal[]> {
    return this.opportunityRankingService.rankActiveSignals(currentRegime);
  }
}
