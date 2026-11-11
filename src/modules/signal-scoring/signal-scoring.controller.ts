/**
 * SignalScoringController — REST endpoints for signal intelligence.
 *
 * Endpoints:
 *   GET /signals/ranked  — returns all active signals ordered by composite
 *                          score, estimated expected value, and regime
 *                          alignment strength (Req 20.1).
 *
 * Note: JwtAuthGuard removed so the Chrome Extension can poll this endpoint
 * without a user session.  Rate limiting (ThrottleByUserGuard) still applies.
 *
 * Requirements: 20.1
 */

import { Controller, Get, Query } from '@nestjs/common';
import { OpportunityRankingService } from './opportunity-ranking.service';
import { RankedSignal } from './signal-scoring.types';

@Controller('signals')
export class SignalScoringController {
  constructor(private readonly opportunityRankingService: OpportunityRankingService) {}

  /**
   * Returns all active/accepted signals ranked by composite score.
   *
   * Publicly accessible — no JWT required so the Chrome Extension can poll
   * this endpoint at startup and on a periodic interval without needing an
   * authenticated user session.
   */
  @Get('ranked')
  async getRankedSignals(@Query('currentRegime') currentRegime?: string): Promise<RankedSignal[]> {
    return this.opportunityRankingService.rankActiveSignals(currentRegime);
  }
}
