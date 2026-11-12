const { Client } = require('pg');
require('dotenv').config();
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(async () => {
  const r1 = await c.query(`
    SELECT i.trading_symbol, COUNT(hc.id)::int as candles,
           MIN(hc.timestamp)::date as earliest, MAX(hc.timestamp)::date as latest
    FROM historical_candles hc
    JOIN instruments i ON i.id = hc.instrument_id
    WHERE i.underlying = 'NIFTY'
    GROUP BY i.trading_symbol
    ORDER BY candles DESC
    LIMIT 20
  `);
  console.log('NIFTY instruments with 1m candle data:');
  r1.rows.forEach(row =>
    console.log(' ', row.trading_symbol.padEnd(32), row.candles, 'candles', row.earliest, '->', row.latest)
  );

  const r2 = await c.query('SELECT granularity, COUNT(*)::int as n FROM historical_candles GROUP BY granularity');
  console.log('\nCandle counts by granularity:');
  r2.rows.forEach(r => console.log(' ', r.granularity, ':', r.n));

  const r3 = await c.query('SELECT COUNT(*)::int as n FROM paper_trades');
  console.log('\nPaper trades in DB:', r3.rows[0].n);

  await c.end();
}).catch(e => { console.error(e.message); process.exit(1); });
