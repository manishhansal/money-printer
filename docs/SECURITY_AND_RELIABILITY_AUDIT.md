# Security and Reliability Audit

**Date:** 2026-11-11

---

## Security Architecture

### Credential Handling
| Secret | Storage | Access | Status |
|--------|---------|--------|--------|
| DHAN_SESSION_TOKEN | SecretsService (AWS Secrets Manager) | Per-request fetch | ✅ Never cached |
| DHAN_CLIENT_ID | SecretsService | Per-request fetch | ✅ |
| DB password | .env / environment | TypeORM | ✅ |
| Redis URL | .env / environment | ioredis | ✅ |

### Extension Security
- **No credentials in extension.** All broker interaction happens via NestJS CloudEngine.
- **popup.ts localhost fix:** Removed hardcoded `http://localhost:3002`. Now uses `getApiBaseUrl()` with build-time override.
- **CSRF protection:** `CsrfMiddleware` applied to state-mutating endpoints. Extension popup sends `X-CSRF-Token` header.
- **Throttle guard:** `ThrottleByUserGuard` limits per-user request rate.

### API Authentication (NestJS)
- JWT-based authentication for browser/extension requests.
- Rate limiting via `@nestjs/throttler`.
- Global exception filter for consistent error responses.

## Reliability Components

| Component | Mechanism | Status |
|-----------|-----------|--------|
| WebSocket reconnection | Exponential backoff (1s→16s, max 5 attempts) | ✅ |
| Broker auth failure | Token invalidation, no retry | ✅ |
| Rate limit queue | 50-entry buffer with backoff | ✅ |
| Capital ledger | DB transaction + failure event | ✅ |
| Square-off reliability | Multi-cron escalation (15:10/15:15/15:20/15:25/15:28) | ✅ |
| Kill switch | Account-level Dhan kill switch + process guard | ✅ |
| EOD reconciliation | 15:30 IST cron comparing CloudEngine vs Dhan orders | ✅ |
| Reconnection reconciliation | Triggered on WebSocket reconnect | ✅ |

## Open Security Issues

1. **Static IP not configured.** Dhan requires a static IP for algo trading. If the backend is behind a dynamic IP, orders may be rejected or the account may be flagged. The current implementation does not validate the outgoing IP.

2. **SEBI retail-algo authorization not verified.** Using Dhan's API for automated order placement requires SEBI algo registration. This is not enforced in code — `live trading remains DISARMED by default` which provides a manual gate, but regulatory compliance is the operator's responsibility.

3. **Access token expiry.** Dhan access tokens expire every 24 hours. No automatic token renewal is implemented. When the token expires, `DhanAuthFailureError` is thrown and the token is invalidated — but no alert or renewal workflow exists.

4. **Extension host permissions are broad.** `manifest.json` currently allows `http://localhost/*` and `https://localhost/*`. In production, should be restricted to the actual backend URL.

## Compliance Notes

- Live trading starts DISARMED — explicit 2-step arming required.
- Kill switch persists for process lifetime — restart required to re-arm after kill.
- All risk events, reconciliation runs, and compliance events are persisted to AuditLogs.
- DailyLossStateMachineService prevents trading after 2 losing trades or monetary limit.
