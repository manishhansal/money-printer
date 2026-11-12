/**
 * debug.module.ts
 *
 * DebugModule — provides the /debug/stats and /debug/scan endpoints
 * for the MoneyPrinter dashboard diagnostics panel.
 *
 * Repositories:
 *   - Instruments  — count of loaded instruments
 *   - Signals      — count of today's signal evaluations
 *   - PaperTrade   — count of today's paper fills / orders
 *
 * The scan trigger works via EventEmitter2 (global) → SignalScannerService
 * which listens for 'debug.trigger_scan' and calls scanForSignals().
 * No direct import of SignalScannerModule is needed, avoiding potential
 * circular-dependency issues.
 *
 * Requirements: Dashboard diagnostics
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Instruments } from '../../database/entities/instruments.entity';
import { Signals } from '../../database/entities/signals.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';

import { DebugController } from './debug.controller';

@Module({
  imports: [
    // Repositories for the /debug/stats counters.
    TypeOrmModule.forFeature([Instruments, Signals, PaperTrade]),
  ],
  controllers: [DebugController],
})
export class DebugModule {}
