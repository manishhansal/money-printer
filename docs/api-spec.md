# MoneyPrinter — API Reference

## Overview

The CloudEngine exposes a REST API consumed by the Chrome Extension. CORS is enabled for `chrome-extension://*` and `localhost` origins.

Base URL: `http://localhost:3002` (dev) · `https://api.yourdomain.com` (production)

Port is configurable via `PORT` env var (default `3000`; local dev uses `3002`).

---

## Authentication

### JWT Format

RS256-signed JWTs with max 30-minute validity (`JWT_EXPIRY_SECONDS`, hard-capped at 1800 s).

```json
{ "sub": "<userId>", "clientId": "<dhanClientId>", "sid": "<sessionId>", "iat": ..., "exp": ... }
```

The `sid` claim is a `BrokerSessions` row UUID. Every authenticated request verifies `isActive = true`. An expired token causes session deactivation and a `TOKEN_EXPIRY` audit entry.

### Rate Limiting

100 requests / 60-second window per authenticated user. HTTP 429 with positive `Retry-After` on breach.

### CSRF Protection

All state-modifying methods (POST, PUT, PATCH, DELETE) require `X-CSRF-Token` header. GET/HEAD exempt.

---

## Auth Endpoints

### `POST /auth/login`

```json
// Request
{ "clientId": "12345678", "accessToken": "eyJ0..." }

// Response 200
{ "sessionToken": "eyJhbGc...", "expiresAt": "2026-11-11T10:00:00Z" }
```

### `POST /auth/refresh`

Rotates the session (old session deactivated before new one issued).

```json
// Request: requires valid JWT Bearer token
// Response 200
{ "sessionToken": "eyJhbGc...", "expiresAt": "..." }
```

### `POST /auth/logout`

Deactivates the current session. Requires JWT Bearer token.

### `GET /auth/status`

Returns `{ loggedIn: true|false, sessionId: "..." }`. Requires JWT Bearer token.

---

## Portfolio Endpoints

### `GET /portfolio/summary`

Returns today's session P&L for both PAPER and LIVE engines with full charge breakdown.
No auth guard (non-sensitive aggregate data, served only to local clients).

```json
{
  "paper": {
    "grossPnl": 2500.00,
    "charges": {
      "brokerage": 40.0,
      "stt": 10.0,
      "exchangeCharges": 1.855,
      "gst": 7.534,
      "sebiCharges": 0.0175,
      "stampDuty": 0.225,
      "total": 59.63
    },
    "netPnl": 2440.37,
    "tradeCount": 3
  },
  "live": {
    "grossPnl": 0,
    "charges": { "brokerage": 0, ... "total": 0 },
    "netPnl": 0,
    "tradeCount": 0
  },
  "timestamp": "2026-11-11T10:30:00.000Z"
}
```

**Charge rates used (all NSE F&O options):**
- Brokerage: ₹20 × 2 = ₹40
- STT: **0.1%** of sell-side premium (Budget 2024)
- Exchange: 0.053% of total turnover
- GST: 18% on brokerage + exchange
- SEBI: ₹10/crore
- Stamp duty: 0.003% of buy-side

---

## Settings Endpoints

### `GET /settings`

Returns current trading configuration and auto-derived risk limits.
No auth guard.

```json
{
  "paperStartingCapital": "50000.00",
  "liveStartingCapital": "0.00",
  "defaultRiskPercentage": "1.0000",
  "maxDailyLossPercentage": "2.0000",
  "paperRiskPerTrade": "500.00",
  "paperDailyLossLimitRupees": "1000.00"
}
```

### `PUT /settings`

Update trading configuration. No auth guard.

```json
// Request body (all fields optional)
{
  "paperStartingCapital": "100000",
  "defaultRiskPercentage": "1.5",
  "maxDailyLossPercentage": "2.0"
}

// Response: same shape as GET /settings with updated values
```

When `paperStartingCapital` changes, the `PaperTradingService` picks it up on the next portfolio balance read. All risk limits auto-scale as a % of the new capital.

---

## Signal Endpoints

### `GET /signals/ranked`

Returns currently active signals ranked by composite score. Requires JWT Bearer token.

```json
[
  {
    "rank": 1,
    "signal": {
      "id": "uuid",
      "instrumentId": "uuid",
      "direction": "BUY",
      "entryPrice": "19500.00",
      "stopLossPrice": "19200.00",
      "targetPrice": "20100.00",
      "compositeScore": "88.50",
      "status": "active",
      "regime": "STRONG_BULL"
    },
    "expectedValue": 59.17,
    "regimeAlignmentStrength": 3,
    "explanation": "#1: Score 88.5/100, EV 59.2, Regime STRONG_BULL (aligned)..."
  }
]
```

---

## Options Flow Endpoint

### `GET /options-flow/dashboard`

Returns live options flow metrics (OI change, PCR, IV skew, large-block detection) for all monitored instruments. Requires JWT Bearer token.

```json
{
  "snapshots": [
    {
      "instrumentId": "uuid",
      "tradingSymbol": "NIFTY24JAN21000CE",
      "netOiChange": 125000,
      "putCallRatio": 0.892,
      "ivSkew": 1.24,
      "largeBlockDetected": false,
      "snapshotTime": "2026-11-11T05:30:00Z",
      "isStale": false
    }
  ],
  "generatedAt": "2026-11-11T05:30:01Z",
  "suppressOptionsFuturesScore": false
}
```

If `suppressOptionsFuturesScore = true`, the `optionsFuturesConfirmation` component of signal scores should be treated as unavailable (data is >60 seconds old).

---

## Health Endpoint

### `GET /`

```
MoneyPrinter CloudEngine is running.
```

Simple liveness check. No authentication required.

---

## HTTP Error Codes

| Code | Meaning |
|---|---|
| `400` | Validation error (DTO constraint violation) |
| `401` | Missing or invalid JWT |
| `403` | Valid JWT but session deactivated, or CSRF token missing |
| `404` | Endpoint not found |
| `429` | Rate limit exceeded (see `Retry-After` header) |
| `500` | Unhandled exception (logged to CloudWatch / server console) |

---

## WebSocket (Notifications)

The CloudEngine pushes notifications to connected Chrome Extension clients via a separate WebSocket server on `WS_PORT` (default `3001`; local dev uses `3003`).

**Protocol (server → client):**
```json
{ "event": "notification", "data": { "id": "uuid", "priority": "MAX|CRITICAL|WARNING|INFO", "title": "...", "message": "...", "metadata": {}, "createdAt": "..." } }
```

**Protocol (client → server, MAX-priority ACK):**
```json
{ "event": "ack", "data": { "alertId": "uuid" } }
```

Undelivered alerts are buffered in Redis (`notifications:pending:{priority}`) and replayed when a client reconnects.

---

## Dhan API Integration (25 methods)

The `DhanApiClient` wraps the Dhan v2 REST API. All methods include:
- Fresh token from `SecretsService` on every call (never stored locally)
- HTTP 401/403 → token invalidated, `DhanAuthFailureError` thrown
- HTTP 429 → queued in rate-limit queue (up to 50 slots), retried after `Retry-After`

| Category | Methods |
|---|---|
| Orders | `placeOrder`, `modifyOrder`, `cancelOrder`, `getOrderbook`, `getOrderById` |
| Positions | `getPositions` |
| Portfolio | `getPortfolio` (holdings) |
| Tradebook | `getTradebook` |
| Funds | `getFundLimit` |
| Market data | `getLtp`, `getOhlcSnapshot`, `getQuote` |
| Historical | `getHistoricalCandles` (daily + intraday) |
| Options | `getOptionChain`, `getOptionExpiryList` |
| Super Orders | `placeSuperOrder`, `modifySuperOrder`, `cancelSuperOrder` |
| Kill Switch | `setKillSwitch`, `getKillSwitchStatus` |
| P&L Exit | `setPnlExit`, `deletePnlExit`, `getPnlExit` |
