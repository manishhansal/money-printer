# MoneyPrinter — Security

## Authentication Model

### JWT Issuance

The CloudEngine issues RS256-signed JWTs with a hard validity ceiling of 30 minutes. The `JWT_EXPIRY_SECONDS` environment variable can lower this limit; values above 1800 are silently clamped to 1800. The signing key pair (`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`) must be stored in the secrets backend — never in environment variables in production deployments.

The JWT payload carries three application claims beyond the standard `iat`/`exp`:
- `sub` — application user ID (used as the rate-limit bucket key)
- `clientId` — Dhan client identifier
- `sid` — `BrokerSessions` row UUID (used for active-session validation on every request)

### Session Validation

Every authenticated request goes through `JwtAuthGuard`, which calls `JwtStrategy.validate()`. The strategy verifies that the `BrokerSessions` row identified by `sid` has `isActive = true`. A structurally valid but expired token causes `AuthService.recordTokenExpiry()` to be called, which writes a `TOKEN_EXPIRY` audit log entry and sets the session's `isActive` flag to `false`.

This means session invalidation is effective immediately upon logout or expiry — there is no grace period during which an old token can be reused after the session is deactivated.

### Audit Trail

Every auth event is recorded in the `audit_logs` table (append-only: no UPDATE or DELETE ever issued). The `AuditEventType` enum covers:

- `LOGIN`, `LOGIN_FAILURE` — credential exchange outcomes
- `TOKEN_REFRESH` — session rotation (old session invalidated before new one created)
- `TOKEN_EXPIRY` — expired token used; session deactivated
- `LOGOUT` — explicit session termination
- `CONFIG_CHANGE` — configuration field modifications
- `TRADE_AUTH` — arming/disarming events
- `KILL_SWITCH` — kill switch activations
- `ARM_DISARM` — two-step arming state transitions
- `RECONCILIATION_ACTION` — EOD reconciliation events

Audit log failures are caught and logged at ERROR level but never abort the primary operation — a failed audit write must never prevent a login or logout from completing.

---

## Field-Level Encryption

`EncryptedColumnTransformer` applies AES-256-GCM encryption to sensitive columns using the `ENCRYPTION_KEY` environment variable. The key must be supplied as one of:
- 64-character hex string (decoded to 32 bytes)
- 44-character base64 string (decoded to 32 bytes)
- 32-character UTF-8 string (used directly as 32 bytes)

The on-disk wire format is `base64(ivHex:authTagHex:ciphertextHex)` with a 96-bit random IV per write and a 128-bit GCM authentication tag. This means the same plaintext produces a different ciphertext on every write (IV randomness), and any tampering with the ciphertext or auth tag causes decryption to return `null` with a console warning rather than throwing.

Encrypted columns:

| Entity | Column | Why |
|---|---|---|
| `BrokerAccounts` | `api_key` | Dhan API key — broker access credential |
| `BrokerAccounts` | `access_token` | Dhan access token — broker access credential |
| `BrokerSessions` | `session_token` | Active JWT — session hijack risk if exposed |
| `AuditLogs` | `previous_value` | May contain sensitive config values |
| `AuditLogs` | `new_value` | May contain sensitive config values |

---

## Secrets Management

`SecretsService` provides a unified `get(key)` / `set(key, value)` / `rotate(key, newValue)` interface over three backends, selected by the `SECRETS_BACKEND` environment variable:

| Backend | `SECRETS_BACKEND` value | Use case |
|---|---|---|
| `env` (default) | `env` | Local development; reads from `process.env` |
| AWS Secrets Manager | `aws` | Cloud production; uses `@aws-sdk/client-secrets-manager` |
| HashiCorp Vault KV v2 | `vault` | Self-hosted production; uses HTTP KV v2 API |

Security invariants enforced by `SecretsService`:

1. **Secret values are never logged.** `get()`, `set()`, and `rotate()` log only the key name and operation outcome. The `redact()` helper returns `"[REDACTED]"` for all log interpolations involving secret values.
2. **Error messages never contain secret values.** Thrown errors contain only the key name and a generic failure reason.
3. **`rotate()` emits an audit record** containing key name, backend, timestamp, and outcome (`success` or `failure`) — no value.

For the AWS backend, credentials are resolved via the standard SDK credential chain (IAM role, environment, instance profile) when `AWS_ACCESS_KEY_ID` is absent, allowing EC2 instance profile authentication in production.

For the Vault backend, the KV v2 path convention is `/v1/secret/data/{key}` with `X-Vault-Token` authentication.

---

## Rate Limiting

`ThrottlerModule` is configured globally with a single named throttler: `ttl: 60_000` ms (60-second sliding window), `limit: 100` requests per window per client.

`ThrottleByUserGuard` (registered as `APP_GUARD`) uses the JWT `sub` claim as the throttle bucket key for authenticated requests. Unauthenticated requests fall back to IP-based keying.

`ThrottlerExceptionFilter` (registered as `APP_FILTER`) intercepts `ThrottlerException` and returns HTTP 429 with:
- A `Retry-After` header containing a strictly positive integer (seconds until reset)
- A JSON body with `statusCode: 429`, `message`, and `retryAfter`

The `Retry-After` value is guaranteed positive — the filter enforces `Math.max(1, Math.ceil(remaining_ms / 1000))`.

---

## CSRF Protection

`CsrfMiddleware` is applied to all routes via `AppModule.configure()`. It validates the `X-CSRF-Token` header on state-modifying methods: POST, PUT, PATCH, DELETE. GET and HEAD requests are exempt. The middleware also skips health-check paths.

A missing or invalid CSRF token returns HTTP 403.

Applying the middleware globally in `AppModule` rather than per-controller ensures every future controller route is automatically protected without opt-in decoration.

---

## Chrome Extension Security Invariants

The extension enforces security invariants in `security-invariants.ts`. These run synchronously before any storage write.

### Forbidden `chrome.storage.local` Keys

The following keys must **never** be stored in `chrome.storage.local` (which is accessible to content scripts and potentially to any script running on a page):

- `sessionToken`
- `brokerCredentials`
- `apiKey`
- `dhanToken`
- `accessToken`
- `refreshToken`

These values belong exclusively in `chrome.storage.session`, which is scoped to the Background Service Worker and not accessible to content scripts.

`secureLocalStorageSet(items)` is a wrapper around `chrome.storage.local.set` that throws a `SecurityError` before the Chrome API is called if any key in `items` is in the forbidden list.

### URL Validation

`assertSecureUrl(url)` throws a `SecurityError` for any URL that does not begin with `wss://` or `https://`. Plain `ws://` and `http://` URLs are rejected unconditionally. This is called before establishing any WebSocket connection or making any HTTP request to the CloudEngine.

### Manifest Permissions

The extension's `manifest.json` (MV3) declares only two permissions: `storage` and `alarms`. There are no content scripts that have access to `chrome.storage`. No host permissions are declared beyond what is implicit in the WSS connection target.

---

## Paper/Live Isolation

Isolation is enforced at four levels to ensure paper trading activity can never affect live trading state:

| Layer | Mechanism |
|---|---|
| DB tables | Separate table pairs: `orders`/`paper_orders`, `executions`/`paper_executions`, `positions`/`paper_positions`, `trades`/`paper_trades` |
| Redis keys | `paper:*` namespace prefix; live engine never writes keys with `paper:` prefix |
| Event channels | `events:paper:*` channel prefix; live engine consumers never subscribe to `events:paper:*` |
| Dhan API | Paper engine never calls `DhanApiClient`; all fills are simulated |

The `EngineType` discriminant (`'LIVE' | 'PAPER'`) appears as a column on shared tables (`CapitalLedgers`, `RiskEvents`). Services always filter by `engine` to prevent cross-contamination at the query level.

---

## Instrument Tradability Guard

`InstrumentDiscoveryService` classifies every NSE F&O instrument at 09:15 IST daily. Underlying index instruments (`instrumentType === 'INDEX'`) are classified as `UNDERLYING` with `isTradable = false`. They are retained in the instruments table for regime computation and signal generation but are **structurally excluded** from submission to `ExecutionService`.

The in-memory `tradableCache` (Map<securityId, isTradable>) is rebuilt after every successful scan. `isInstrumentTradable(securityId)` is called in the execution pre-trade chain to verify tradability before the order reaches the broker. On scan failure the previous session's cache is retained — the system degrades gracefully rather than clearing tradability information.

---

## Threat Model

| Threat | Mitigation |
|---|---|
| Unauthorized access | RS256 JWT with 30-min TTL; active-session validation on every request; session table `isActive` flag |
| Credential exposure | AES-256-GCM field encryption on API keys and tokens; SecretsService with no-log invariant; forbidden `chrome.storage.local` keys |
| Order manipulation | Two-step arm flow (DISARMED→ARMED_PENDING→ARMED); kill switch; 5-check pre-trade chain; daily loss state machine |
| Session hijack | JWT stored only in `chrome.storage.session` (BSW-scoped); never in `chrome.storage.local` or DOM |
| DoS / resource exhaustion | 100 req/60 s per-user rate limit; PostgreSQL connection pool (max 10, timeout 10 s); Redis reconnect with exponential backoff |
| Feed data manipulation | Market data staleness checks (2 s TTL on market snapshots); `suppressOptionsFuturesScore` flag on stale options data; MARKET_DATA_STALE_EVENT blocks new order submissions |
| Underlying index submitted as order | `InstrumentDiscoveryService` enforces `TRADABLE_OPTION` classification; `isInstrumentTradable()` check in pre-trade chain |
| Duplicate orders | Redis idempotency key (TTL 300 s) checked before every broker submission |
