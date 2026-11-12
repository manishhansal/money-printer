/**
 * EOD Manual Close Script
 * Closes all open paper positions at their last known market price from Redis.
 * Run after market close when the cron was missed.
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const redis = require('ioredis');
const { Client } = require('pg');

const r = new redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});
const c = new Client({ connectionString: process.env.DATABASE_URL });

async function eodClose() {
  await c.connect();

  const { rows: positions } = await c.query(
    `SELECT pp.id, pp.direction, pp.quantity, pp.average_entry_price,
            pp.mfe, pp.mae, pp.opened_at, pp.signal_id, pp.instrument_id,
            i.security_id, i.trading_symbol
     FROM paper_positions pp
     JOIN instruments i ON pp.instrument_id = i.id
     WHERE pp.is_open = true`,
  );

  console.log(`EOD closing ${positions.length} open paper positions...`);

  let closed = 0;
  let totalPnl = 0;
  const now = new Date();

  for (const pos of positions) {
    // Get last known LTP from Redis (fallback to entry price)
    let ltp = parseFloat(pos.average_entry_price);
    try {
      const snap = await r.get(`mkt:snapshot:${pos.security_id}`);
      if (snap) {
        const parsed = parseFloat(JSON.parse(snap).ltp);
        if (parsed > 0) ltp = parsed;
      }
    } catch (_) {
      // Keep fallback
    }

    const entry = parseFloat(pos.average_entry_price);
    const qty = pos.quantity;
    const grossPnl =
      pos.direction === 'LONG' ? (ltp - entry) * qty : (entry - ltp) * qty;

    // Simplified costs (₹20 brokerage each side + STT 0.1% sell side + exchange 0.053%)
    const brokerage = 20 * 2;
    const stt = ltp * qty * 0.001;
    const exchange = ltp * qty * 0.00053;
    const gst = (brokerage + exchange) * 0.18;
    const totalCosts = brokerage + stt + exchange + gst;
    const netPnl = grossPnl - totalCosts;
    totalPnl += netPnl;

    // Close position
    await c.query(
      `UPDATE paper_positions SET is_open=false, closed_at=$1, unrealized_pnl='0' WHERE id=$2`,
      [now, pos.id],
    );

    // Insert paper trade
    await c.query(
      `INSERT INTO paper_trades
        (engine, position_id, instrument_id, direction, quantity, lot_size,
         entry_price, exit_price, entry_time, exit_time, mfe, mae,
         gross_pnl, brokerage, stt, exchange_charges, gst, sebi_charges,
         stamp_duty, net_pnl, exit_reason, execution_slippage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        'PAPER', pos.id, pos.instrument_id, pos.direction, qty, 1,
        entry.toFixed(2), ltp.toFixed(2), pos.opened_at, now,
        pos.mfe || '0', pos.mae || '0',
        grossPnl.toFixed(2), brokerage.toFixed(4), stt.toFixed(4),
        exchange.toFixed(4), gst.toFixed(4), '0', '0',
        netPnl.toFixed(2), 'EOD_MANDATORY_EXIT', '0',
      ],
    );

    closed++;
    if (closed % 10 === 0) process.stdout.write(`${closed}...`);
  }

  console.log(`\nDone. Closed: ${closed} | Net PnL: ₹${totalPnl.toFixed(2)}`);

  await c.end();
  r.disconnect();
}

eodClose().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
