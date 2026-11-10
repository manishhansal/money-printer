/**
 * technical-analysis.module.ts
 *
 * NestJS module for the TechnicalAnalysisModule (task 10.1).
 *
 * Provides:
 *  - TechnicalAnalysisService — stateless, on-demand computation of all
 *    technical indicators (VWAP, ATR, EMA, S/R, ORB, MACD, RSI, RelVol).
 *
 * Exports:
 *  - TechnicalAnalysisService — consumed by StrategyEngine (task 13),
 *    MarketRegimeDetector (task 9), and SignalScorer (task 15).
 *
 * Dependencies:
 *  - None (no TypeORM, no Redis, no external services).
 *    Callers are responsible for supplying candle arrays fetched from the DB.
 *
 * Design constraints:
 *  - No persistent state.  All indicator values are recomputed on every call.
 *  - No database writes.   The service never persists indicator results.
 *
 * Requirements: 5.2, 6.2
 */

import { Module } from '@nestjs/common';
import { TechnicalAnalysisService } from './technical-analysis.service';

@Module({
  providers: [TechnicalAnalysisService],
  exports: [TechnicalAnalysisService],
})
export class TechnicalAnalysisModule {}
