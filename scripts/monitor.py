#!/usr/bin/env python3
"""
Live market monitor — polls key endpoints every 2 minutes and prints a
structured dashboard until 15:30 IST.
"""
import json, time, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
API = 'http://localhost:3002'

def get(path):
    try:
        with urllib.request.urlopen(f'{API}{path}', timeout=5) as r:
            return json.loads(r.read())
    except Exception as e:
        return None

def fmt_pnl(v):
    try:
        f = float(v)
        return f'\033[32m{f:+.2f}\033[0m' if f >= 0 else f'\033[31m{f:+.2f}\033[0m'
    except:
        return str(v)

def run():
    poll = 0
    while True:
        poll += 1
        now = datetime.now(IST)
        ts = now.strftime('%H:%M:%S IST')

        print(f'\n{"═"*60}')
        print(f'  ⏱  {ts}  |  Poll #{poll}')
        print(f'{"═"*60}')

        # ── Signals ──────────────────────────────────────────────
        sigs = get('/signals/ranked') or []
        active  = [s for s in sigs if s.get('signal',{}).get('status') in ('active','ACTIVE')]
        accepted = [s for s in sigs if s.get('signal',{}).get('status') in ('accepted','ACCEPTED')]
        print(f'\n📡 Signals: {len(sigs)} total  |  {len(active)} active  |  {len(accepted)} accepted')
        for item in sigs[:6]:
            sig = item.get('signal', {})
            strat  = (sig.get('strategy') or {}).get('code', '?')
            dirn   = sig.get('direction', '?')
            score  = sig.get('compositeScore', '?')
            entry  = sig.get('entryPrice', '?')
            status = sig.get('status', '?')
            regime = sig.get('regime', '-')
            rank   = item.get('rank', '?')
            sl     = sig.get('stopLoss', '?')
            tp     = sig.get('target', '?')
            print(f'  #{rank} [{status}] {strat} | {dirn} | score={score} | entry=₹{entry} | SL=₹{sl} | TP=₹{tp} | {regime}')

        # ── Paper Positions ───────────────────────────────────────
        pos = get('/paper-trading/positions') or []
        total_unreal = sum(float(p.get('unrealized_pnl', 0)) for p in pos)
        print(f'\n📊 Paper Positions: {len(pos)} open  |  Total unrealised: {fmt_pnl(total_unreal)}')
        for p in pos:
            pnl  = float(p.get('unrealized_pnl', 0))
            instr = p.get('instrument_id', '?')[:14]
            dirn  = p.get('direction', '?')
            qty   = p.get('quantity', '?')
            avg   = p.get('average_entry_price', '?')
            sl    = p.get('current_sl', '-')
            opened = (p.get('opened_at') or '')[:16].replace('T',' ')
            print(f'  {dirn} qty={qty} | entry=₹{avg} | SL=₹{sl} | P&L={fmt_pnl(pnl)} | {instr} | @{opened}')

        # ── Portfolio summary ─────────────────────────────────────
        port = get('/portfolio/summary') or {}
        paper = port.get('paper', {})
        net_pnl = paper.get('netPnl', 0)
        trades  = paper.get('tradeCount', 0)
        print(f'\n💰 Paper P&L (realised+unrealised): {fmt_pnl(net_pnl)}  |  Completed trades: {trades}')

        # ── Stats ─────────────────────────────────────────────────
        stats = get('/debug/stats') or {}
        evals  = stats.get('signalEvals', 0)
        orders = stats.get('paperOrders', 0)
        fills  = stats.get('paperFills', 0)
        instr  = stats.get('instruments', 0)
        print(f'📈 Evals: {evals:,}  |  Orders: {orders}  |  Fills: {fills}  |  Instruments: {instr:,}')

        # ── Health & Watchdog ─────────────────────────────────────
        health  = get('/health') or {}
        issues  = get('/watchdog/issues/counts') or {}
        h_info  = health.get('info', {})
        pg      = h_info.get('postgresql_connection',{}).get('status','?')
        redis   = h_info.get('redis_availability',{}).get('status','?')
        dhan    = h_info.get('dhan_api_connectivity',{}).get('status','?')
        p0      = issues.get('P0', '?')
        p1p2    = issues.get('P1', 0) + issues.get('P2', 0)
        status_line = f'PG={pg} Redis={redis} Dhan={dhan}'
        watchdog_line = f'P0={p0} P1+P2={p1p2}'
        print(f'\n🛡  Health: {status_line}  |  Watchdog: {watchdog_line}')
        if issues.get('P0', 0) > 0:
            print('  ⚠️  P0 ISSUE DETECTED — check watchdog!')

        # ── Market close check ────────────────────────────────────
        if now.hour > 15 or (now.hour == 15 and now.minute >= 30):
            print(f'\n🔔 15:30 IST reached — market closed. Final snapshot above.')
            break

        print(f'\n  next check in 2 min…')
        time.sleep(120)

if __name__ == '__main__':
    print('🚀 MoneyPrinter live market monitor started')
    print('   Polling every 2 min until 15:30 IST')
    run()
    print('\n✅ Monitor finished.')
