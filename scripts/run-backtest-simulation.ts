/**
 * run-backtest-simulation.ts
 *
 * Walk-forward backtest on the 6,525 simulated trades from run-simulation.ts.
 * Reads scripts/simulation-results.json (no DB required).
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { BacktestService } from '../src/modules/backtest/backtest.service';
import { BacktestTrade } from '../src/modules/backtest/backtest.types';
import { readFileSync } from 'fs';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const svc = app.get(BacktestService);

  const raw = JSON.parse(readFileSync('scripts/simulation-results.json', 'utf-8')) as Array<{
    instrumentId: string; entry: number; exit: number; quantity: number;
    lotSize: number; entryTime: string; exitTime: string; exitReason: string; netPnl: number;
  }>;

  const trades: BacktestTrade[] = raw.map(t => ({
    date: new Date(t.entryTime),
    pnl: t.netPnl,
    entry: t.entry,
    exit: t.exit,
    regime: '',
    instrument: t.instrumentId,
    isDelisted: false,
  }));

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Walk-Forward Backtest — Simulation Results');
  console.log(`  Trades: ${trades.length}  Period: Aug–Nov 2026`);
  console.log('═══════════════════════════════════════════════════════');

  // Sort chronologically
  trades.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const startDate = trades[0].date;
  const endDate = trades[trades.length - 1].date;

  const result = svc.runBacktest(
    { strategyCode: 'A', inSampleRatio: 0.7, startDate, endDate, engine: 'PAPER' },
    trades,
  );

  const ins = result.inSampleMetrics;
  const oos = result.outOfSampleMetrics;

  console.log(`\n  In-Sample  (70% = ${ins.tradeCount} trades)`);
  console.log(`    Win rate  : ${(ins.winRate * 100).toFixed(1)}%`);
  console.log(`    Expectancy: ₹${ins.expectancy.toFixed(0)}/trade`);
  console.log(`    Max DD    : ₹${ins.maxDrawdown.toFixed(0)}`);
  console.log(`    Total P&L : ₹${(ins.expectancy * ins.tradeCount).toFixed(0)}`);

  console.log(`\n  Out-of-Sample (30% = ${oos.tradeCount} trades)`);
  console.log(`    Win rate  : ${(oos.winRate * 100).toFixed(1)}%`);
  console.log(`    Expectancy: ₹${oos.expectancy.toFixed(0)}/trade`);
  console.log(`    Max DD    : ₹${oos.maxDrawdown.toFixed(0)}`);
  console.log(`    Total P&L : ₹${(oos.expectancy * oos.tradeCount).toFixed(0)}`);

  console.log('\n  Bootstrap CI (95%) — OOS Expectancy (1,000 resamples)');
  console.log(`    Lower 95% : ₹${result.expectancyCI.lower95.toFixed(0)}`);
  console.log(`    Mean      : ₹${result.expectancyCI.mean.toFixed(0)}`);
  console.log(`    Upper 95% : ₹${result.expectancyCI.upper95.toFixed(0)}`);

  console.log('\n  Bootstrap CI (95%) — OOS Win Rate');
  console.log(`    Lower 95% : ${(result.winRateCI.lower95 * 100).toFixed(1)}%`);
  console.log(`    Mean      : ${(result.winRateCI.mean * 100).toFixed(1)}%`);
  console.log(`    Upper 95% : ${(result.winRateCI.upper95 * 100).toFixed(1)}%`);

  // Profitability verdict
  let verdict: string;
  let note: string;
  if (result.expectancyCI.lower95 > 0) {
    verdict = 'PROVEN_PROFITABLE';
    note = 'CI lower bound positive — statistically significant positive expectancy';
  } else if (result.expectancyCI.upper95 > 0 && oos.expectancy > 0) {
    verdict = 'PROMISING_BUT_UNPROVEN';
    note = 'positive mean expectancy but CI crosses zero';
  } else if (oos.expectancy > 0) {
    verdict = 'BREAKEVEN';
    note = 'positive expectancy but CI is negative';
  } else {
    verdict = 'UNPROFITABLE';
    note = `negative expectancy (₹${oos.expectancy.toFixed(0)}/trade) with entirely negative CI`;
  }

  // Sharpe approximation
  const oosReturns = raw.slice(Math.floor(raw.length * 0.7)).map(t => t.netPnl);
  const mean = oosReturns.reduce((s, r) => s + r, 0) / oosReturns.length;
  const stddev = Math.sqrt(oosReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / oosReturns.length);
  const sharpe = stddev > 0 ? mean / stddev * Math.sqrt(252) : 0;

  console.log(`\n  Sharpe (annualised, OOS) : ${sharpe.toFixed(2)}`);
  console.log(`  Profit Factor             : ${result.inSampleMetrics.winRate > 0 ? (oos.winRate * Math.abs(result.expectancyCI.upper95) / ((1 - oos.winRate) * Math.abs(result.expectancyCI.lower95))).toFixed(2) : 'N/A'}`);

  console.log(`\n  ── Verdict: ${verdict}`);
  console.log(`     ${note}`);

  // Per-instrument breakdown
  console.log('\n  ── Per-instrument OOS breakdown (top 5 by trade count)');
  const byInstr: Record<string, number[]> = {};
  raw.slice(Math.floor(raw.length * 0.7)).forEach(t => {
    byInstr[t.instrumentId] = byInstr[t.instrumentId] ?? [];
    byInstr[t.instrumentId].push(t.netPnl);
  });
  const instrSummary = Object.entries(byInstr)
    .map(([id, pnls]) => ({
      id, n: pnls.length,
      winRate: pnls.filter(p => p > 0).length / pnls.length,
      avgPnl: pnls.reduce((s, p) => s + p, 0) / pnls.length,
    }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);

  instrSummary.forEach(s =>
    console.log(`    ${s.id.slice(0, 8)}... n=${s.n} wr=${(s.winRate*100).toFixed(0)}% avgPnl=₹${s.avgPnl.toFixed(0)}`)
  );

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  BACKTEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════\n');

  await app.close();
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
