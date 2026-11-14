#!/usr/bin/env python3
"""Test script: call Dhan rolling option API directly to diagnose DH-901."""
import json, ssl, urllib.request, os

env = {}
env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, _, v = line.partition('=')
            v = v.split(' #')[0].strip().strip('"').strip("'")
            env[k] = v

token = env.get('DHAN_SESSION_TOKEN', '')
client = env.get('DHAN_CLIENT_ID', '')
print(f"token_len={len(token)} client_len={len(client)}")

payload = {
    'exchangeSegment': 'NSE_FNO',
    'interval': '5',
    'securityId': '13',
    'instrument': 'OPTIDX',
    'expiryFlag': 'WEEK',
    'expiryCode': 3,
    'strike': 'ATM',
    'drvOptionType': 'CALL',
    'requiredData': ['open','high','low','close','iv','volume','strike','oi','spot'],
    'fromDate': '2026-11-07',
    'toDate': '2026-11-11'
}

print(f"\nRequest body: {json.dumps(payload)}")

req = urllib.request.Request(
    'https://api.dhan.co/v2/charts/rollingoption',
    data=json.dumps(payload).encode(),
    headers={
        'Content-Type': 'application/json',
        'access-token': token,
        'client-id': client
    }
)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
try:
    with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
        body = r.read().decode()
        print(f'\nHTTP 200 — Success:\n{body[:500]}')
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f'\nHTTP {e.code} — Error:\n{body[:500]}')
except Exception as ex:
    print(f'\nConnection error: {ex}')
