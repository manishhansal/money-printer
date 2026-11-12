"""
seed_instruments.py — Seed NSE/BSE F&O options instruments from Dhan master CSV.

Usage:
  python3 seed_instruments.py

Downloads api-scrip-master.csv from Dhan, filters NSE/BSE options (not futures),
and inserts into the instruments table via Docker exec psql.

Skips rows that already exist (upsert by security_id).
"""

import csv
import os
import subprocess
import sys
from datetime import datetime, timezone

CSV_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"
CSV_FILE = "/tmp/dhan_instruments.csv"

ALLOWED_INDEX_UNDERLYINGS = {
    'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY',
    'SENSEX', 'BANKEX', 'NIFTYNXT50',
}

# Map Dhan segment codes to our DhanExchangeSegment enum values
SEGMENT_MAP = {
    ('NSE', 'D'): 'NSE_FNO',
    ('BSE', 'D'): 'BSE_FNO',
    ('NSE', 'I'): 'IDX_I',
    ('BSE', 'I'): 'IDX_I',
}

# Map Dhan instrument names to our InstrumentType values
INSTRUMENT_TYPE_MAP = {
    'OPTIDX': 'INDEX_OPTION',
    'OPTSTK': 'STOCK_OPTION',
    'INDEX':  'INDEX',
}

def download_csv():
    if not os.path.exists(CSV_FILE):
        print(f"Downloading {CSV_URL} ...")
        result = subprocess.run(['curl', '-s', '-o', CSV_FILE, CSV_URL], capture_output=True)
        if result.returncode != 0:
            print("Download failed:", result.stderr.decode())
            sys.exit(1)
    with open(CSV_FILE) as f:
        count = sum(1 for _ in f)
    print(f"CSV loaded: {count} rows")

def parse_date(date_str):
    """Parse '2024-08-28 14:30:00' → '2024-08-28'"""
    if not date_str or date_str.strip() == '':
        return None
    try:
        return date_str.strip().split(' ')[0]
    except Exception:
        return None

def parse_float(val, default=None):
    try:
        return float(val.strip()) if val and val.strip() else default
    except ValueError:
        return default

def build_rows():
    rows = []
    seen_ids = set()

    with open(CSV_FILE, encoding='utf-8', errors='replace') as f:
        reader = csv.DictReader(f)
        for row in reader:
            exch = row.get('SEM_EXM_EXCH_ID', '').strip()
            seg = row.get('SEM_SEGMENT', '').strip()
            inst_name = row.get('SEM_INSTRUMENT_NAME', '').strip()
            security_id = row.get('SEM_SMST_SECURITY_ID', '').strip()
            symbol = row.get('SEM_TRADING_SYMBOL', '').strip()
            underlying = row.get('SM_SYMBOL_NAME', '').strip()
            expiry_raw = row.get('SEM_EXPIRY_DATE', '').strip()
            strike_raw = row.get('SEM_STRIKE_PRICE', '').strip()
            option_type_raw = row.get('SEM_OPTION_TYPE', '').strip()
            lot_size_raw = row.get('SEM_LOT_UNITS', '').strip()
            tick_size_raw = row.get('SEM_TICK_SIZE', '').strip()

            # Only process options (skip futures for now)
            if inst_name not in INSTRUMENT_TYPE_MAP:
                continue

            instrument_type = INSTRUMENT_TYPE_MAP[inst_name]

            # Segment mapping
            segment = SEGMENT_MAP.get((exch, seg))
            if not segment:
                continue

            # For INDEX_OPTION: only allow our 7 indices
            if instrument_type == 'INDEX_OPTION' and underlying.upper() not in ALLOWED_INDEX_UNDERLYINGS:
                continue

            # Skip if no security ID
            if not security_id or security_id in seen_ids:
                continue
            seen_ids.add(security_id)

            expiry = parse_date(expiry_raw)
            strike = parse_float(strike_raw)

            # CRITICAL: reject instruments with no valid lot_size.
            # Defaulting to 1 would cause quantity calculation bugs (P0-CRIT-003).
            if not lot_size_raw or lot_size_raw.strip() == '':
                print(f"  WARN: skipping {security_id} — missing SEM_LOT_UNITS")
                continue
            try:
                lot_size = int(float(lot_size_raw.strip()))
            except (ValueError, TypeError):
                print(f"  WARN: skipping {security_id} — invalid SEM_LOT_UNITS: {lot_size_raw!r}")
                continue
            if lot_size <= 0:
                print(f"  WARN: skipping {security_id} — lot_size={lot_size} is not positive")
                continue

            tick_size = parse_float(tick_size_raw, 0.05)

            # Map option type
            option_type = None
            if option_type_raw in ('CE', 'PE'):
                option_type = option_type_raw
            elif option_type_raw == 'CA':
                option_type = 'CE'
            elif option_type_raw == 'PA':
                option_type = 'PE'

            rows.append({
                'security_id': security_id,
                'trading_symbol': symbol[:100],
                'exchange': exch,
                'segment': segment,
                'instrument_type': instrument_type,
                'underlying': underlying[:100],
                'expiry_date': expiry,
                'strike_price': strike,
                'option_type': option_type,
                'lot_size': lot_size,
                'tick_size': tick_size or 0.05,
            })

    return rows

def escape(val):
    if val is None:
        return 'NULL'
    if isinstance(val, str):
        return "'" + val.replace("'", "''") + "'"
    if isinstance(val, float):
        return str(val)
    if isinstance(val, int):
        return str(val)
    return 'NULL'

def insert_batch(rows, batch_size=500):
    total = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        values = []
        for r in batch:
            values.append(
                f"({escape(r['security_id'])}, {escape(r['trading_symbol'])}, "
                f"{escape(r['exchange'])}, {escape(r['segment'])}, "
                f"{escape(r['instrument_type'])}, {escape(r['underlying'])}, "
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
            # Full UPSERT: update all mutable fields so stale lot_size / tick_size are corrected.
            # Requirement P0-CRIT-004: ON CONFLICT DO NOTHING silently preserves stale metadata.
            "\nON CONFLICT (security_id) DO UPDATE SET"
            "\n  trading_symbol  = EXCLUDED.trading_symbol,"
            "\n  instrument_type = EXCLUDED.instrument_type,"
            "\n  underlying      = EXCLUDED.underlying,"
            "\n  expiry_date     = EXCLUDED.expiry_date,"
            "\n  strike_price    = EXCLUDED.strike_price,"
            "\n  option_type     = EXCLUDED.option_type,"
            "\n  lot_size        = EXCLUDED.lot_size,"
            "\n  tick_size       = EXCLUDED.tick_size,"
            "\n  updated_at      = NOW()"
            "\n  WHERE instruments.lot_size <> EXCLUDED.lot_size"
            "\n     OR instruments.tick_size <> EXCLUDED.tick_size"
            "\n     OR instruments.trading_symbol <> EXCLUDED.trading_symbol;"
        )

        result = subprocess.run(
            ['docker', 'exec', '-i', 'money-printer-postgres',
             'psql', '-U', 'moneyprinter', '-d', 'moneyprinter'],
            input=sql.encode('utf-8'),
            capture_output=True
        )
        if result.returncode != 0:
            print(f"Batch {i//batch_size+1} error:", result.stderr.decode()[:200])
        else:
            total += len(batch)
            print(f"  Inserted batch {i//batch_size+1}: {total}/{len(rows)} rows")

    return total

if __name__ == '__main__':
    download_csv()
    print("Parsing instruments...")
    rows = build_rows()
    print(f"Found {len(rows)} F&O options instruments to insert")

    # Print breakdown
    from collections import Counter
    types = Counter(r['instrument_type'] for r in rows)
    for t, c in sorted(types.items()):
        print(f"  {t}: {c}")

    print("Inserting into instruments table...")
    inserted = insert_batch(rows)
    print(f"\nDone. {inserted} instruments inserted.")
