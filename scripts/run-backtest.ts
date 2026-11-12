/**
 * run-backtest.ts
 *
 * Walk-forward backtest using closed paper trades in the database.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/run-backtest.ts
 */

import { NestFactory } from '@nestjs/core';
import { DataSource, MoreThanOrEqual } from 'typeorm';
import { AppModule } from '../src/app.module';
import { BacktestService } from '../src/modules/backtest/backtest.service';
import { PaperTrade } from '../src/database/entities/paper-trades.entity';
import { BacktestTrade, StrategyCode } from '../src/modules/backtest/backtest.types';

const MIN_TRADES_STAT = 30;

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  MoneyPrinter — Walk-Forward Backtest (Paper Trades)');
  console.log('═══════════════════════════════════════════════════════\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const dataSource = app.get(DataSource);
  const backtestService = app.get(BacktestService);

  const since = new Date();
  since.setFullYear(since.getFullYear() - 2);

  const rawTrades = await dataSource.getRepository(PaperTrade).find({
    where: { entry_time: MoreThanOrEqual(since) },
    order: { entry_time: 'ASC' },
    take: 10_000,
  });

  console.log(`  Paper trades available: ${rawTrades.length}`);

  if (rawTrades.length < 10) {
    console.log('\n  ⚠  Too few paper trades for a meaningful backtest.');
    console.log(`     Found ${rawTrades.length} — need ≥ 10 for in/out split.`);
    console.log('     Start the server and let the scanner run to accumulate trades.\n');
    await app.close();
    return;
  }

  const trades: BacktestTrade[] = rawTrades.map((t) => ({
    date: t.entry_time,
    pnl: parseFloat(t.net_pnl),
    entry: parseFloat(t.entry_price),
    exit: parseFloat(t.exit_price),
    regime: '',
    instrument: t.instrument_id,
    isDelisted: false,
  }));

  // Run for each of the 8 strategies (use strategy 'A' config — same walk-forward
  // split logic applies regardless of code for a combined paper-trade set).
  // Run once using strategy 'A' as the config key.
  const strategyCode: StrategyCode = 'A';
  const result = backtestService.runBacktest(
    {
      strategyCode,
      inSampleRatio: 0.7,
      startDate: since,
      endDate: new Date(),
      engine: 'PAPER',
    },
    trades,
  );

  const ins = result.inSampleMetrics;
  const oos = result.outOfSampleMetrics;

  console.log('\n  ── In-Sample (70%)');
  console.log(`     Trades    : ${ins.tradeCount}`);
  console.log(`     Win rate  : ${(ins.winRate * 100).toFixed(1)}%`);
  console.log(`     Expectancy: ₹${ins.expectancy.toFixed(0)} / trade`);
  console.log(`     Max DD    : ₹${ins.maxDrawdown.toFixed(0)}`);

  console.log('\n  ── Out-of-Sample (30%)');
  console.log(`     Trades    : ${oos.tradeCount}`);
  console.log(`     Win rate  : ${(oos.winRate * 100).toFixed(1)}%`);
  console.log(`     Expectancy: ₹${oos.expectancy.toFixed(0)} / trade`);
  console.log(`     Max DD    : ₹${oos.maxDrawdown.toFixed(0)}`);

  console.log('\n  ── Bootstrap CI (95%, 1,000 resamples) on OOS expectancy');
  console.log(`     Lower 95% : ₹${result.expectancyCI.lower95.toFixed(0)}`);
  console.log(`     Mean      : ₹${result.expectancyCI.mean.toFixed(0)}`);
  console.log(`     Upper 95% : ₹${result.expectancyCI.upper95.toFixed(0)}`);

  console.log('\n  ── Bootstrap CI (95%) on OOS win rate');
  console.log(`     Lower 95% : ${(result.winRateCI.lower95 * 100).toFixed(1)}%`);
  console.log(`     Mean      : ${(result.winRateCI.mean * 100).toFixed(1)}%`);
  console.log(`     Upper 95% : ${(result.winRateCI.upper95 * 100).toFixed(1)}%`);

  // ── Profitability classification ───────────────────────────────────────────
  let verdict = 'INSUFFICIENT_DATA';
  let note = `only ${oos.tradeCount} OOS trades (need ≥${MIN_TRADES_STAT} for statistical confidence)`;

  if (oos.tradeCount >= MIN_TRADES_STAT) {
    if (result.expectancyCI.lower95 > 0) {
      verdict = 'PROVEN_PROFITABLE';
      note = 'CI lower bound positive — statistically significant positive expectancy';
    } else if (oos.expectancy > 500 && oos.winRate > 0.55) {
      verdict = 'PROMISING_BUT_UNPROVEN';
      note = 'positive expectancy + good win rate, CI not yet conclusive';
    } else if (oos.expectancy > 0) {
      verdict = 'BREAKEVEN';
      note = 'marginally positive expectancy';
    } else {
      verdict = 'UNPROFITABLE';
      note = 'negative OOS expectancy';
    }
  }

  console.log(`\n  ── Profitability Verdict: ${verdict}`);
  console.log(`     ${note}`);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  BACKTEST COMPLETE');
  if (oos.tradeCount < MIN_TRADES_STAT) {
    console.log('  NOTE: Results are indicative only due to small sample size.');
    console.log('  Continue running the paper engine to accumulate more trades.');
  }
  console.log('═══════════════════════════════════════════════════════\n');

  await app.close();
}

main().catch((err: Error) => {
  console.error('\n❌ Backtest failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
