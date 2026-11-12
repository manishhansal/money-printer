/**
 * run-backfill.ts
 *
 * Standalone NestJS application-context script to run the Dhan historical
 * candle backfill without starting the full HTTP server.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/run-backfill.ts
 *
 * What it does:
 *   1. Fetches daily (1d) OHLCV candles from Dhan API for NIFTY options
 *      over the past 2 years — the minimum data needed for backtesting.
 *   2. Fetches 1m intraday candles for the most recent 90 days (precise
 *      entry/exit timing for walk-forward validation).
 *   3. Prints a summary with per-instrument success/failure counts.
 *
 * Data is stored in the `historical_candles` table (ON CONFLICT DO NOTHING —
 * idempotent, safe to re-run).
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DhanHistoricalBackfillService } from '../src/modules/backtest/dhan-historical-backfill.service';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().split('T')[0];

// Two-year lookback for daily candles (long enough for walk-forward validation).
const TWO_YEARS_AGO = new Date();
TWO_YEARS_AGO.setFullYear(TWO_YEARS_AGO.getFullYear() - 2);
const FROM_DAILY = TWO_YEARS_AGO.toISOString().split('T')[0];

// 90-day lookback for 1m intraday candles.
const NINETY_DAYS_AGO = new Date();
NINETY_DAYS_AGO.setDate(NINETY_DAYS_AGO.getDate() - 90);
const FROM_INTRADAY = NINETY_DAYS_AGO.toISOString().split('T')[0];

// Process at most 200 NIFTY options per pass (avoids API rate exhaustion).
// Increase this once you have verified the API is working correctly.
const INSTRUMENT_LIMIT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  MoneyPrinter — Dhan Historical Candle Backfill');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Daily range  : ${FROM_DAILY} → ${TODAY}`);
  console.log(`  Intraday range: ${FROM_INTRADAY} → ${TODAY} (1m)`);
  console.log(`  Instruments  : NIFTY options, limit=${INSTRUMENT_LIMIT}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // Boot NestJS in application-context mode (no HTTP server, no WebSocket).
  // Suppress verbose startup logs.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const backfillService = app.get(DhanHistoricalBackfillService);

  // ── Phase 1: Daily OHLCV (2-year lookback) ──────────────────────────────
  console.log('\n📊 Phase 1 — Daily OHLCV candles (2-year lookback)');
  console.log(`   fromDate=${FROM_DAILY}  toDate=${TODAY}  granularity=1d`);
  const t1 = Date.now();

  const dailyResult = await backfillService.backfill({
    fromDate: FROM_DAILY,
    toDate: TODAY,
    granularity: '1d',
    underlyingSymbol: 'NIFTY',
    limit: INSTRUMENT_LIMIT,
  });

  console.log(`\n   ✓ Phase 1 complete (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  console.log(`     Attempted  : ${dailyResult.instrumentsAttempted}`);
  console.log(`     Succeeded  : ${dailyResult.instrumentsSucceeded}`);
  console.log(`     Failed     : ${dailyResult.instrumentsFailed}`);
  console.log(`     Inserted   : ${dailyResult.totalCandlesInserted} candles`);
  console.log(`     Skipped    : ${dailyResult.skippedExisting} (already in DB)`);

  if (dailyResult.failedInstruments.length > 0) {
    console.log(`\n   ⚠ First 5 failed instruments:`);
    dailyResult.failedInstruments.slice(0, 5).forEach((f) => {
      console.log(`     - ${f.tradingSymbol} (${f.securityId}): ${f.reason}`);
    });
  }

  // ── Phase 2: 1-minute intraday (90-day lookback) ─────────────────────────
  console.log('\n\n📊 Phase 2 — 1-minute intraday candles (90-day lookback)');
  console.log(`   fromDate=${FROM_INTRADAY}  toDate=${TODAY}  granularity=1m`);
  const t2 = Date.now();

  const intradayResult = await backfillService.backfill({
    fromDate: FROM_INTRADAY,
    toDate: TODAY,
    granularity: '1m',
    underlyingSymbol: 'NIFTY',
    limit: INSTRUMENT_LIMIT,
  });

  console.log(`\n   ✓ Phase 2 complete (${((Date.now() - t2) / 1000).toFixed(1)}s)`);
  console.log(`     Attempted  : ${intradayResult.instrumentsAttempted}`);
  console.log(`     Succeeded  : ${intradayResult.instrumentsSucceeded}`);
  console.log(`     Failed     : ${intradayResult.instrumentsFailed}`);
  console.log(`     Inserted   : ${intradayResult.totalCandlesInserted} candles`);
  console.log(`     Skipped    : ${intradayResult.skippedExisting} (already in DB)`);

  if (intradayResult.failedInstruments.length > 0) {
    console.log(`\n   ⚠ First 5 failed instruments:`);
    intradayResult.failedInstruments.slice(0, 5).forEach((f) => {
      console.log(`     - ${f.tradingSymbol} (${f.securityId}): ${f.reason}`);
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalInserted = dailyResult.totalCandlesInserted + intradayResult.totalCandlesInserted;
  const totalDuration = ((Date.now() - t1) / 1000).toFixed(1);

  console.log('\n\n═══════════════════════════════════════════════════════');
  console.log('  BACKFILL COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Total candles inserted: ${totalInserted.toLocaleString()}`);
  console.log(`  Total duration        : ${totalDuration}s`);
  console.log(`  Next step             : run scripts/run-backtest.ts`);
  console.log('═══════════════════════════════════════════════════════\n');

  await app.close();
  process.exit(0);
}

main().catch((err: Error) => {
  console.error('\n❌ Backfill failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
