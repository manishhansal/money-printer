/**
 * SignalScoringModule — NestJS module for the signal scoring engine and
 * opportunity intelligence ranking.
 *
 * Provides and exports:
 *   `SignalScoringService`       — scores signals and persists them (Req 8.x)
 *   `OpportunityRankingService`  — ranks active signals by composite score,
 *                                  expected value, and regime alignment (Req 20.1)
 *
 * Controllers:
 *   `SignalScoringController`    — GET /signals/ranked (requires JWT auth)
 *
 * TypeORM repositories registered:
 *   `Signals`     — required by both services for signal CRUD
 *   `Instruments` — required by OpportunityRankingService for trading-symbol lookup
 *
 * Imports:
 *   `AuthModule`  — provides `JwtAuthGuard` for the controller endpoints
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 20.1
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SignalScoringService } from './signal-scoring.service';
import { OpportunityRankingService } from './opportunity-ranking.service';
import { SignalScoringController } from './signal-scoring.controller';
import { Signals } from '../../database/entities/signals.entity';
import { Instruments } from '../../database/entities/instruments.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([Signals, Instruments]), AuthModule],
  controllers: [SignalScoringController],
  providers: [SignalScoringService, OpportunityRankingService],
  exports: [SignalScoringService, OpportunityRankingService],
})
export class SignalScoringModule {}
