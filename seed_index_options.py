"""Seed INDEX_OPTION instruments (Nifty, BankNifty, etc.) from Dhan CSV."""
import csv
import re
import subprocess
from collections import Counter

CSV_FILE = "/tmp/dhan_instruments.csv"

ALLOWED = {'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY',
           'SENSEX', 'BANKEX', 'NIFTYNXT50', 'NIFTYFPI'}

SEGMENT_MAP = {
    ('NSE', 'D'): 'NSE_FNO',
    ('BSE', 'D'): 'BSE_FNO',
}

def extract_underlying(symbol):
    """Extract underlying from e.g. 'NIFTY-Nov2026-21000-CE'."""
    m = re.match(r'^([A-Z0-9]+)[-_]', symbol)
    return m.group(1) if m else ''

def parse_date(s):
    if not s or not s.strip():
        return None
    return s.strip().split(' ')[0]

def escape(val):
    if val is None:
        return 'NULL'
    if isinstance(val, str):
        return "'" + val.replace("'", "''") + "'"
    return str(val)

rows = []
with open(CSV_FILE, encoding='utf-8', errors='replace') as f:
    reader = csv.DictReader(f)
    for row in reader:
        exch = row['SEM_EXM_EXCH_ID'].strip()
        seg = row['SEM_SEGMENT'].strip()
        inst = row['SEM_INSTRUMENT_NAME'].strip()

        if inst != 'OPTIDX':
            continue

        segment = SEGMENT_MAP.get((exch, seg))
        if not segment:
            continue

        symbol = row['SEM_TRADING_SYMBOL'].strip()
        underlying = extract_underlying(symbol)

        if underlying not in ALLOWED:
            continue

        security_id = row['SEM_SMST_SECURITY_ID'].strip()
        expiry = parse_date(row['SEM_EXPIRY_DATE'])
        strike_raw = row['SEM_STRIKE_PRICE'].strip()
        strike = float(strike_raw) if strike_raw else None
        opt_raw = row['SEM_OPTION_TYPE'].strip()
        option_type = 'CE' if opt_raw in ('CE', 'CA') else ('PE' if opt_raw in ('PE', 'PA') else None)
        lot_raw = row['SEM_LOT_UNITS'].strip()
        # CRITICAL: reject instruments with no valid lot_size.
        # Defaulting to 1 would cause quantity calculation bugs (P0-CRIT-003).
        if not lot_raw:
            print(f"  WARN: skipping {security_id} — missing SEM_LOT_UNITS")
            continue
        try:
            lot_size = int(float(lot_raw))
        except (ValueError, TypeError):
            print(f"  WARN: skipping {security_id} — invalid SEM_LOT_UNITS: {lot_raw!r}")
            continue
        if lot_size <= 0:
            print(f"  WARN: skipping {security_id} — lot_size={lot_size} is not positive")
            continue
        tick_raw = row['SEM_TICK_SIZE'].strip()
        tick_size = float(tick_raw) if tick_raw else 0.05

        rows.append({
            'security_id': security_id,
            'trading_symbol': symbol[:100],
            'exchange': exch,
            'segment': segment,
            'instrument_type': 'INDEX_OPTION',
            'underlying': underlying,
            'expiry_date': expiry,
            'strike_price': strike,
            'option_type': option_type,
            'lot_size': lot_size,
            'tick_size': tick_size,
        })

print(f"Found {len(rows)} INDEX_OPTION rows")
print(Counter(r['underlying'] for r in rows))

# Insert
batch_size = 500
inserted = 0
for i in range(0, len(rows), batch_size):
    batch = rows[i:i+batch_size]
    values = []
    for r in batch:
        values.append(
            f"({escape(r['security_id'])}, {escape(r['trading_symbol'])}, "
            f"{escape(r['exchange'])}, {escape(r['segment'])}, "
            f"'INDEX_OPTION', {escape(r['underlying'])}, "
            f"{escape(r['expiry_date'])}, {escape(r['strike_price'])}, "
            f"{escape(r['option_type'])}, {r['lot_size']}, {r['tick_size']}, "
            f"false, false, '0.00', NOW(), NOW())"
        )
    sql = (
        "INSERT INTO instruments "
        "(security_id, trading_symbol, exchange, segment, instrument_type, underlying, "
        "expiry_date, strike_price, option_type, lot_size, tick_size, "
        "is_active, is_tradable, liquidity_score, created_at, updated_at) VALUES\n"
        + ',\n'.join(values) +
        "\nON CONFLICT (security_id) DO UPDATE SET"
        "\n  instrument_type = EXCLUDED.instrument_type,"
        "\n  underlying      = EXCLUDED.underlying,"
        "\n  trading_symbol  = EXCLUDED.trading_symbol,"
        "\n  lot_size        = EXCLUDED.lot_size,"
        "\n  tick_size       = EXCLUDED.tick_size,"
        "\n  updated_at      = NOW()"
        "\n  WHERE instruments.lot_size <> EXCLUDED.lot_size"
        "\n     OR instruments.tick_size <> EXCLUDED.tick_size"
        "\n     OR instruments.underlying <> EXCLUDED.underlying;"
    )
    result = subprocess.run(
        ['docker', 'exec', '-i', 'money-printer-postgres',
         'psql', '-U', 'moneyprinter', '-d', 'moneyprinter'],
        input=sql.encode('utf-8'), capture_output=True
    )
    if result.returncode != 0:
        print(f"Error batch {i//batch_size+1}:", result.stderr.decode()[:200])
    else:
        inserted += len(batch)

print(f"Done: {inserted} INDEX_OPTION instruments upserted.")
