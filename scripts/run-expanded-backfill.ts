/**
 * run-expanded-backfill.ts
 *
 * Expanded backfill targeting ALL three Dec 2026 NIFTY expiries plus
 * the Jan 2027 expiry — 2,000+ option instruments across 90-day intraday window.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/run-expanded-backfill.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DhanHistoricalBackfillService } from '../src/modules/backtest/dhan-historical-backfill.service';

const TODAY = new Date().toISOString().split('T')[0];
const NINETY_AGO = new Date();
NINETY_AGO.setDate(NINETY_AGO.getDate() - 90);
const FROM = NINETY_AGO.toISOString().split('T')[0];

async function run(svc: DhanHistoricalBackfillService, label: string, underlying: string, limit: number) {
  console.log(`\n📊 Backfill — ${label} (${underlying}, limit=${limit})`);
  const r = await svc.backfill({ fromDate: FROM, toDate: TODAY, granularity: '1m', underlyingSymbol: underlying, limit });
  console.log(`   Attempted=${r.instrumentsAttempted} Succeeded=${r.instrumentsSucceeded} Failed=${r.instrumentsFailed} Candles=${r.totalCandlesInserted} Duration=${(r.durationMs/1000).toFixed(1)}s`);
  return r;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Expanded Dhan Historical Backfill');
  console.log(`  Range: ${FROM} → ${TODAY} (1m candles)`);
  console.log('═══════════════════════════════════════════════════════');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const svc = app.get(DhanHistoricalBackfillService);

  let totalCandles = 0;

  // Run backfill for each major index underlying, limit 150 each
  for (const underlying of ['NIFTY', 'BANKNIFTY', 'FINNIFTY']) {
    const r = await run(svc, `${underlying} options`, underlying, 150);
    totalCandles += r.totalCandlesInserted;
  }

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  Total candles inserted: ${totalCandles.toLocaleString()}`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  await app.close();
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
