const { Client } = require('pg');
require('dotenv').config();
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(async () => {
  const r = await c.query(`
    SELECT
      MIN(entry_time)::date as first_trade,
      MAX(entry_time)::date as last_trade,
      COUNT(*)::int as total,
      ROUND(AVG(net_pnl::numeric), 2) as avg_pnl,
      SUM(CASE WHEN net_pnl::numeric > 0 THEN 1 ELSE 0 END)::int as wins,
      ROUND(SUM(CASE WHEN net_pnl::numeric > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as win_pct
    FROM paper_trades
  `);
  const row = r.rows[0];
  console.log('Paper trade summary:');
  console.log('  Period    :', row.first_trade, '->', row.last_trade);
  console.log('  Total     :', row.total);
  console.log('  Wins      :', row.wins, '(' + row.win_pct + '%)');
  console.log('  Avg P&L   : Rs', row.avg_pnl);

  const r2 = await c.query(`
    SELECT exit_reason, COUNT(*)::int as n
    FROM paper_trades
    GROUP BY exit_reason
    ORDER BY n DESC
  `);
  console.log('\n  Exit reasons:');
  r2.rows.forEach(row2 => console.log('   ', (row2.exit_reason || 'null').padEnd(30), ':', row2.n));

  const r3 = await c.query(`
    SELECT signal_score::int / 10 * 10 as score_bucket, COUNT(*)::int as n
    FROM paper_trades
    GROUP BY score_bucket
    ORDER BY score_bucket
  `);
  console.log('\n  Score distribution:');
  r3.rows.forEach(row3 => console.log('   ', (row3.score_bucket || 0) + 's:', row3.n, 'trades'));

  await c.end();
}).catch(e => { console.error(e.message); process.exit(1); });
