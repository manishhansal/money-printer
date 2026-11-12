/**
 * analytics.controller.ts
 *
 * GET /analytics/metrics?engine=LIVE|PAPER&window=SESSION|WEEK|MONTH|ALL_TIME
 * Returns performance metrics for the React StrategyAnalytics panel.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { PerformanceMetrics, TimeWindow, Engine } from './analytics.types';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * GET /analytics/metrics?engine=LIVE|PAPER&window=SESSION
   * Returns 12 performance metrics for the given engine + time window.
   */
  @Get('metrics')
  async getMetrics(
    @Query('engine') engine = 'PAPER',
    @Query('window') window = 'SESSION',
  ): Promise<PerformanceMetrics> {
    const eng: Engine = engine === 'LIVE' ? 'LIVE' : 'PAPER';
    // TimeWindow only supports 'SESSION' | 'LAST_30_DAYS' | 'ALL_TIME'
    const tw: TimeWindow =
      window === 'LAST_30_DAYS' ? 'LAST_30_DAYS' : window === 'ALL_TIME' ? 'ALL_TIME' : 'SESSION';
    return this.analyticsService.getPerformanceMetrics(eng, tw);
  }
}
