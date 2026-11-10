# MoneyPrinter — API Reference

## Overview

The CloudEngine exposes a REST API consumed exclusively by the Chrome Extension control plane. All communication uses HTTPS (enforced at the TLS terminator/load balancer). Every endpoint except `POST /auth/login` requires a valid JWT Bearer token.

Base URL: `https://<host>:3000` (port configurable via `PORT` env var).

---

## Authentication and Security

### JWT Format

Tokens are RS256-signed JWTs with a maximum validity of 30 minutes (`JWT_EXPIRY_SECONDS`, hard-capped at 1800 s). The payload carries three claims:

```json
{
  "sub": "<userId>",
  "clientId": "<dhanClientId>",
  "sid": "<sessionId>",
  "iat": 1700000000,
  "exp": 1700001800
}
```

The `sid` claim is a `BrokerSessions` row UUID. Every authenticated request verifies that this session's `isActive` flag is `true`. An expired token causes the session's `isActive` flag to be set `false` and a `TOKEN_EXPIRY` audit log entry to be written.

### Rate Limiting

All endpoints are subject to a global rate limit: **100 requests per 60-second window per authenticated user**. The window key is the JWT `sub` claim; unauthenticated requests fall back to IP-based keying.

On limit breach the server returns HTTP 429 with a `Retry-After` header containing a strictly positive integer (seconds until the window resets). The response body is:

```json
{
  "statusCode": 429,
  "message": "Too Many Requests",
  "retryAfter": 42
}
```

### CSRF Protection

`CsrfMiddleware` is applied globally. All state-modifying methods (POST, PUT, PATCH, DELETE) require an `X-CSRF-Token` header with a valid token. GET and HEAD requests are exempt. Health-check paths are also exempt.

A CSRF token violation returns HTTP 403.

---

## Auth Endpoints

### `POST /auth/login`

Exchanges Dhan credentials for a session JWT. The only endpoint that does not require a prior JWT.

**Request body:**

```json
{
  "clientId": "12345678",
  "apiKey": "dhan-api-key-string"
}
```

| Field | Type | Description |
|---|---|---|
| `clientId` | string | Dhan-assigned client identifier |
| `apiKey` | string | Dhan API key stored (encrypted) in `broker_accounts` |

**Response `200 OK`:**

```json
{
  "sessionToken": "eyJhbGciOiJSUzI1NiJ9...",
  "expiresAt": "2024-01-15T10:30:00.000Z"
}
```

| Field | Description |
|---|---|
| `sessionToken` | Signed RS256 JWT; use as `Authorization: Bearer <token>` on subsequent requests |
| `expiresAt` | ISO 8601 UTC expiry; Extension uses this to schedule proactive refresh before expiry |

**Errors:**

- `401 Unauthorized` — credentials not found in `broker_accounts` or account inactive. A `LOGIN_FAILURE` audit log entry is written regardless.

Every successful login writes a `LOGIN` audit log entry.

---

### `POST /auth/refresh`

Issues a replacement JWT for the current valid session. The old session is invalidated before the new one is created, ensuring at most one active session per refresh cycle.

**Headers:** `Authorization: Bearer <token>`

**Response `200 OK`:** Same shape as `/auth/login`.

**Errors:**

- `401 Unauthorized` — token is expired or the session's `isActive` flag is already `false`.

Writes a `TOKEN_REFRESH` audit log entry on success or failure.

---

### `POST /auth/logout`

Invalidates the current session by setting `isActive = false` on the `BrokerSessions` row identified by the JWT's `sid` claim.

**Headers:** `Authorization: Bearer <token>`

**Response `204 No Content`** — always returned, even if the session was already inactive (logout is idempotent from the client's perspective).

Writes a `LOGOUT` audit log entry.

---

### `GET /auth/status`

Returns the caller's authentication status and the current arming state of the LiveEngine. The Extension calls this endpoint after a Background Service Worker restart to resynchronise display state.

**Headers:** `Authorization: Bearer <token>`

**Response `200 OK`:**

```json
{
  "authenticated": true,
  "armedState": "DISARMED",
  "sessionExpiresAt": "2024-01-15T10:30:00.000Z"
}
```

| Field | Description |
|---|---|
| `authenticated` | `true` when the JWT's session row has `isActive = true` |
| `armedState` | Current value of the `trading:armed_state` Redis key; defaults to `"DISARMED"` when the key is absent |
| `sessionExpiresAt` | ISO 8601 UTC expiry of the current session |

---

## Signal Intelligence Endpoints

### `GET /signals/ranked`

Returns all active signals in the database, ranked by composite score, estimated expected value, and regime alignment strength (all descending). Signals with status other than `"active"` are excluded.

**Headers:** `Authorization: Bearer <token>`

**Query parameters:**

| Parameter | Required | Description |
|---|---|---|
| `currentRegime` | No | Current market regime code (e.g. `STRONG_BULL`). When supplied, signals whose stored regime matches receive alignment strength 3. When omitted all signals receive alignment strength 2 (unverifiable). |

**Response `200 OK`:** `RankedSignal[]`

```json
[
  {
    "rank": 1,
    "expectedValue": 61.3,
    "regimeAlignmentStrength": 3,
    "explanation": "#1: Score 92/100, EV 61.3, Regime STRONG_BULL (aligned). Strategy A, BUY NIFTY24JAN21000CE at ₹19500.00, R:R 2.0. High composite score with strong regime alignment.",
    "signal": {
      "id": "uuid",
      "strategyId": "uuid",
      "instrumentId": "uuid",
      "direction": "BUY",
      "entryPrice": "19500.00",
      "stopLossPrice": "19300.00",
      "targetPrice": "19900.00",
      "compositeScore": 92,
      "status": "active",
      "regime": "STRONG_BULL",
      "signalTimestamp": "2024-01-15T09:45:00.000Z"
    }
  }
]
```

**Ranking algorithm:**

1. Sort by `compositeScore` descending
2. Tie-break: `expectedValue` descending (`compositeScore × (rrRatio / (rrRatio + 1))`)
3. Tie-break: `regimeAlignmentStrength` descending (3 = matched, 2 = unverifiable, 1 = no stored regime, 0 = mismatch)

---

## Options Flow Endpoints

### `GET /options-flow/dashboard`

Returns aggregated options-flow metrics for all monitored instruments. Stale data (> 60 seconds old) is flagged explicitly so callers can suppress the `optionsFuturesConfirmation` score component.

**Headers:** `Authorization: Bearer <token>`

**Response `200 OK`:** `OptionsFlowDashboard`

```json
{
  "snapshots": [
    {
      "instrumentId": "uuid",
      "tradingSymbol": "NIFTY24JAN21000CE",
      "netOiChange": 125000,
      "putCallRatio": 1.23,
      "ivSkew": 2.5,
      "largeBlockDetected": true,
      "largeBlockVolume": 50000,
      "snapshotTime": "2024-01-15T10:15:00.000Z",
      "isStale": false
    }
  ],
  "generatedAt": "2024-01-15T10:15:30.000Z",
  "suppressOptionsFuturesScore": false
}
```

| Field | Description |
|---|---|
| `netOiChange` | Aggregate net change in OI across all strikes and legs since previous snapshot |
| `putCallRatio` | Total put OI ÷ total call OI; 0 when total call OI is zero |
| `ivSkew` | 25-delta put IV minus 25-delta call IV; positive = elevated put demand |
| `largeBlockDetected` | `true` when any CE or PE leg volume exceeds `LARGE_BLOCK_VOLUME_THRESHOLD` |
| `isStale` | `true` when `snapshotTime` is > 60 seconds in the past |
| `suppressOptionsFuturesScore` | `true` when any snapshot is stale; callers must zero out the `optionsFuturesConfirmation` score contribution |

The dashboard refreshes on a ≤60-second cron cycle reading from `mkt:optchain:{underlying}:{expiry}` Redis keys.

---

## Health and Status

The CloudEngine does not expose a dedicated `/health` REST endpoint in the current implementation. Health state is tracked internally via `SystemHealthMonitorService` and surfaced through:

- **Redis keys** `health:{metric_name}` (TTL 90 s) — 6 metrics refreshed every 30 seconds
- **NotificationService** — CRITICAL alerts pushed to the Extension on Healthy→Degraded or Degraded→Down transitions
- **WebSocket push** — the Extension receives all notification alerts over the WSS connection

The 6 monitored metrics are:

| Metric | Check Type |
|---|---|
| `cloudengine_modules` | Passive — updated by modules via `updateMetricStatus()` |
| `dhan_api_connectivity` | Passive |
| `postgresql_connection` | Active — `SELECT 1` round-trip every 30 s |
| `redis_availability` | Active — PING round-trip every 30 s |
| `websocket_feed_latency` | Passive |
| `order_execution_latency` | Passive |

A round-trip ≥ 500 ms classifies as `Degraded`; an exception classifies as `Down`.

---

## Error Response Format

All error responses follow NestJS's default exception shape:

```json
{
  "statusCode": 401,
  "message": "Invalid credentials",
  "error": "Unauthorized"
}
```

Common status codes:

| Code | Meaning |
|---|---|
| 400 | Validation failure (class-validator) |
| 401 | Invalid or expired JWT, or credential failure on login |
| 403 | CSRF token missing or invalid |
| 429 | Rate limit exceeded (see `Retry-After` header) |
| 500 | Unhandled exception — logged and published as CRITICAL health alert |

---

## Request/Response Conventions

- All timestamps are ISO 8601 UTC strings.
- All monetary values in API responses are NUMERIC strings (e.g. `"19500.00"`) to preserve decimal precision without floating-point rounding.
- The API does not support pagination on any current endpoint.
- All endpoints produce `application/json`.
