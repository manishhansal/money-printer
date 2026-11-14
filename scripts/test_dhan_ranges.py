#!/usr/bin/env python3
"""Systematic test of Dhan rolling option date ranges."""
import json, ssl, urllib.request, os

env = {}
with open(os.path.join(os.path.dirname(__file__), '..', '.env')) as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, _, v = line.partition('=')
            env[k] = v.split(' #')[0].strip().strip('"').strip("'")

token = env.get('DHAN_SESSION_TOKEN', '')
client = env.get('DHAN_CLIENT_ID', '')

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def test(expiry_code, from_date, to_date):
    payload = {
        'exchangeSegment': 'NSE_FNO', 'interval': '5', 'securityId': '13',
        'instrument': 'OPTIDX', 'expiryFlag': 'WEEK', 'expiryCode': expiry_code,
        'strike': 'ATM', 'drvOptionType': 'CALL',
        'requiredData': ['close', 'spot'],
        'fromDate': from_date, 'toDate': to_date
    }
    req = urllib.request.Request(
        'https://api.dhan.co/v2/charts/rollingoption',
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json', 'access-token': token, 'client-id': client}
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
            d = json.loads(r.read().decode())
            pts = len(d.get('data', {}).get('ce', {}).get('spot', []))
            return f'✓ {pts} candles'
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        code = json.loads(body).get('errorCode', '?') if body.startswith('{') else '?'
        return f'✗ HTTP {e.code} ({code})'
    except Exception as ex:
        return f'✗ err: {ex}'

# Test expiryCode=1 for progressively wider ranges
ranges = [
    (1, '2026-11-10', '2026-11-10'),  # 1 day (Mon)
    (1, '2026-11-10', '2026-11-11'),  # 2 days (Mon-Tue)
    (1, '2026-11-09', '2026-11-11'),  # 3 days (Mon-Tue-Wed)
    (1, '2026-11-07', '2026-11-11'),  # 5 days (Sat-Tue)
    (1, '2026-11-06', '2026-11-11'),  # 6 days (Fri-Tue)
    (1, '2026-11-04', '2026-11-11'),  # 8 days (Wed-Tue)
    (1, '2026-11-04', '2026-11-07'),  # 4 days prior week
]

print(f"{'expiry':>6} {'from':>12} {'to':>12}  result")
print('-' * 55)
for args in ranges:
    result = test(*args)
    print(f"  ec={args[0]}  {args[1]}  {args[2]}  {result}")
