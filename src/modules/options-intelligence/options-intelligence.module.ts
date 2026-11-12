/**
 * options-intelligence.module.ts
 *
 * NestJS module for the OptionsIntelligenceModule (tasks 11.1–11.6).
 *
 * Provides:
 *  - OptionsIntelligenceService  — Greeks computation, caching, and freshness
 *    enforcement (GREEKS_MAX_AGE_MS = 60 s).
 *  - ContractSelectionService   — enforces all 4 contract selection criteria
 *    simultaneously (delta, IV rank, OI, market depth).
 *  - IvRegimeService            — tracks per-underlying IV regime (EXPANDING /
 *    CONTRACTING / NEUTRAL) and provides independently-configurable weight
 *    factors for contract selection and R:R estimation.
 *  - ExpiryDayControlsService   — determines whether the current trading date
 *    is an expiry day and returns the appropriate risk controls (higher signal
 *    score threshold, reduced position size, earlier mandatory square-off).
 *  - LiquidityMarkerService     — marks contracts as illiquid when the bid-ask
 *    spread exceeds the configured threshold and returns the liquidity penalty
 *    for the SignalScoringModule's Liquidity/Execution Feasibility component.
 *  - ThetaDecayService          — computes Theta decay in ₹/calendar-day as a
 *    non-negative magnitude for all open options positions; exposes decay to
 *    PositionMonitoringModule as an exit condition input (Requirement 7.5).
 *
 * Exports:
 *  - OptionsIntelligenceService  — consumed by StrategyEngine, SignalScorer,
 *    and PositionMonitor for contract selection and Theta-decay evaluation.
 *  - ContractSelectionService   — consumed by StrategyEngine to filter
 *    candidate contracts before signal generation.
 *  - IvRegimeService            — consumed by SignalScorer and StrategyEngine
 *    for regime-aware scoring and R:R estimation.
 *  - ExpiryDayControlsService   — consumed by SignalScorer (threshold),
 *    RiskEngine (position sizing), and PositionMonitor (square-off time).
 *  - LiquidityMarkerService     — consumed by SignalScorer to apply the
 *    liquidity penalty to the Liquidity/Execution Feasibility score component.
 *  - ThetaDecayService          — consumed by PositionMonitoringModule for
 *    Theta-decay-based exit condition evaluation.
 *
 * Dependencies:
 *  - DhanApiModule   — provides DhanApiClient (getOptionChain).
 *  - ConfigModule    — @Global() in AppModule; ConfigService available without
 *                      explicit import.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DhanApiModule } from '../dhan/dhan-api.module';
import { Instruments } from '../../database/entities/instruments.entity';
import { OptionsIntelligenceService } from './options-intelligence.service';
import { ContractSelectionService } from './contract-selection.service';
import { IvRegimeService } from './iv-regime.service';
import { ExpiryDayControlsService } from './expiry-day-controls.service';
import { LiquidityMarkerService } from './liquidity-marker.service';
import { ThetaDecayService } from './theta-decay.service';
import { OptionsChainController } from './options-chain.controller';

@Module({
  imports: [
    // Provides Instruments repository for the OptionsChainController strike table.
    TypeOrmModule.forFeature([Instruments]),
    // DhanApiModule exports DhanApiClient, which OptionsIntelligenceService
    // uses to call getOptionChain() for live Greeks data.
    DhanApiModule,
  ],
  providers: [
    OptionsIntelligenceService,
    ContractSelectionService,
    IvRegimeService,
    ExpiryDayControlsService,
    LiquidityMarkerService,
    ThetaDecayService,
  ],
  controllers: [OptionsChainController],
  exports: [
    OptionsIntelligenceService,
    ContractSelectionService,
    IvRegimeService,
    ExpiryDayControlsService,
    LiquidityMarkerService,
    ThetaDecayService,
  ],
})
export class OptionsIntelligenceModule {}
