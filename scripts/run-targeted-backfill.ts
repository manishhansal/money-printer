/**
 * run-targeted-backfill.ts
 *
 * Targeted 7-day 1m backfill for the top 20 most-liquid NIFTY and BANKNIFTY
 * options only — completes in ~3 minutes.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DhanHistoricalBackfillService } from '../src/modules/backtest/dhan-historical-backfill.service';

const TODAY = new Date().toISOString().split('T')[0];
// 7 calendar days back = ~5 trading days
const SEVEN_AGO = new Date();
SEVEN_AGO.setDate(SEVEN_AGO.getDate() - 7);
const FROM = SEVEN_AGO.toISOString().split('T')[0];

async function main() {
  console.log(`Targeted 7-day backfill: ${FROM} → ${TODAY}`);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const svc = app.get(DhanHistoricalBackfillService);

  let total = 0;
  for (const u of ['NIFTY', 'BANKNIFTY']) {
    const r = await svc.backfill({ fromDate: FROM, toDate: TODAY, granularity: '1m', underlyingSymbol: u, limit: 20 });
    console.log(`${u}: succeeded=${r.instrumentsSucceeded} candles=${r.totalCandlesInserted}`);
    total += r.totalCandlesInserted;
  }
  console.log(`Total new candles: ${total}`);
  await app.close();
}
main().catch((e: Error) => { console.error(e.message); process.exit(1); });
