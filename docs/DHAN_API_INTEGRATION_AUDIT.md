# Dhan API Integration Audit

**Date:** 2026-11-11  
**Reference:** https://docs.dhanhq.co/api/v2/

---

## Endpoint Coverage Matrix

| # | Endpoint | HTTP | Status | Method in DhanApiClient | Notes |
|---|----------|------|--------|------------------------|-------|
| 1 | POST /v2/orders | POST | ✅ Implemented | `placeOrder()` | Quantity now sent in UNITS |
| 2 | PUT /v2/orders/{id} | PUT | ✅ Implemented | `modifyOrder()` | |
| 3 | DELETE /v2/orders/{id} | DELETE | ✅ Implemented | `cancelOrder()` | |
| 4 | GET /v2/orders | GET | ✅ Implemented | `getOrderbook()` | |
| 5 | GET /v2/orders/{id} | GET | ✅ Implemented | `getOrderById()` | |
| 6 | GET /v2/orders/external/{correlationId} | GET | ✅ **ADDED** | `getOrderByCorrelationId()` | Crash recovery |
| 7 | GET /v2/trades | GET | ✅ Implemented | `getTradebook()` | |
| 8 | GET /v2/trades/{id} | GET | ❌ Not implemented | — | Low priority |
| 9 | POST /v2/super/orders | POST | ✅ Implemented | `placeSuperOrder()` | |
| 10 | PUT /v2/super/orders/{id} | PUT | ✅ Implemented | `modifySuperOrder()` | |
| 11 | DELETE /v2/super/orders/{id}/{leg} | DELETE | ✅ Implemented | `cancelSuperOrder()` | |
| 12 | GET /v2/super/orders | GET | ❌ Not implemented | — | Useful for SL verification |
| 13 | GET /v2/positions | GET | ✅ Implemented | `getPositions()` | Used in reconciliation |
| 14 | POST /v2/positions/convert | POST | ❌ Not implemented | — | Not needed for intraday |
| 15 | DELETE /v2/positions | DELETE | ❌ Not implemented | — | Dangerous: account-level |
| 16 | GET /v2/holdings | GET | ✅ Implemented | `getPortfolio()` | |
| 17 | GET /v2/fundlimit | GET | ✅ Implemented | `getFundLimit()` | Pre-trade margin check |
| 18 | POST /v2/margincalculator | POST | ✅ **ADDED** | `calculateMargin()` | Accurate pre-trade margin |
| 19 | POST /v2/margincalculator/multi | POST | ❌ Not implemented | — | Low priority |
| 20 | POST /v2/marketfeed/ltp | POST | ✅ Implemented | `getLtp()` | |
| 21 | POST /v2/marketfeed/ohlc | POST | ✅ Implemented | `getOhlcSnapshot()` | |
| 22 | POST /v2/marketfeed/quote | POST | ✅ Implemented | `getQuote()` | |
| 23 | POST /v2/optionchain | POST | ✅ Implemented | `getOptionChain()` | Greeks, OI, IV |
| 24 | POST /v2/optionchain/expirylist | POST | ✅ Implemented | `getOptionExpiryList()` | |
| 25 | POST /v2/charts/intraday | POST | ✅ Implemented | `getHistoricalCandles()` | |
| 26 | POST /v2/charts/historical | POST | ✅ Implemented | `getHistoricalCandles()` | |
| 27 | POST /v2/killswitch | POST | ✅ Implemented | `setKillSwitch()` | |
| 28 | GET /v2/killswitch | GET | ✅ Implemented | `getKillSwitchStatus()` | |
| 29 | POST /v2/pnlExit | POST | ✅ Implemented | `setPnlExit()` | Belt-and-suspenders loss limit |
| 30 | DELETE /v2/pnlExit | DELETE | ✅ Implemented | `deletePnlExit()` | |
| 31 | GET /v2/pnlExit | GET | ✅ Implemented | `getPnlExit()` | |

**Total: 25 implemented, 6 not implemented.**  
**Newly added in this session:** `getOrderByCorrelationId()`, `calculateMargin()`

---

## Authentication

- **Method:** `access-token` header on every request.
- **Source:** `SecretsService.get('DHAN_SESSION_TOKEN')` — fetched fresh on every call, never cached in memory.
- **401/403 handling:** `DhanAuthFailureError` thrown, token invalidated via `SecretsService.set('DHAN_SESSION_TOKEN', '')`, no automatic retry.

## Rate Limiting

- **429 handling:** `enqueueRateLimitedRequest()` — up to 50 entries, exponential backoff from `Retry-After` header.
- **Option chain:** 3-second unique-request limit respected by callers (OptionsIntelligenceService).
- **Queue overflow:** `DhanRateLimitQueueFullError` thrown when queue at 50 entries.

## Missing Integrations — Priority

| Endpoint | Priority | Reason |
|----------|----------|--------|
| GET /v2/super/orders | P2 | Useful for verifying SL status directly |
| POST /v2/margincalculator/multi | P3 | Batch margin calculation |
| GET /v2/trades/{id} | P3 | Individual trade details |
| DELETE /v2/positions | Never | Account-level; too dangerous |

## WebSocket

- **Connection:** `wss://api-feed.dhan.co?version=2&token=TOKEN&clientId=CLIENT_ID&authType=2`
- **Protocol:** Binary little-endian packets (not JSON).
- **Subscriptions:** Full Packet (RequestCode 21) — includes LTP, volume, OI, 5-level depth.
- **Reconnection:** Exponential backoff 1s→2s→4s→8s→16s, max 5 attempts.
- **Order updates:** NOT handled via WebSocket — Dhan's order update feed requires separate connection. Currently uses polling via `getOrderbook()`.
- **Gap:** No `Dhan Live Order Update WebSocket` integration. All order status changes detected via polling confirmation checks.
