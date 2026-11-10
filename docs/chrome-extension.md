# MoneyPrinter Chrome Extension

## Overview

The Chrome Extension is the control plane for the MoneyPrinter CloudEngine. It runs as an MV3 extension with four UI surfaces and a Background Service Worker (BSW) that owns the single WSS connection to the CloudEngine. All broker credentials, session tokens, and API keys live exclusively in the BSW's memory and `chrome.storage.session` — never in `chrome.storage.local` or any DOM-accessible location.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Chrome Extension (MV3)                                        │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Background Service Worker (BSW)                         │  │
│  │  - Owns single WSS connection to CloudEngine             │  │
│  │  - Authoritative in-memory ExtensionState                │  │
│  │  - Persists state to chrome.storage.session              │  │
│  │  - Handles all chrome.runtime.onMessage from UI          │  │
│  └───────────┬────────────────────────┬─────────────────────┘  │
│              │ chrome.runtime.sendMessage                       │
│  ┌───────────┴───────────────────────────────────────────────┐  │
│  │  Popup    │  Side Panel    │  Full Dashboard               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                │
│  WSS (wss:// only) ◄─────────────────────► CloudEngine :3000  │
└────────────────────────────────────────────────────────────────┘
```

The extension declares only two permissions in `manifest.json`: `storage` and `alarms`. There are no content scripts and no broad host permissions.

---

## Background Service Worker (BSW)

The BSW (`dist/background/service-worker.js`, built from `extension/src/background/background.ts`) is the single source of truth for `ExtensionState`. It is the only context with access to `chrome.storage.session`.

### ExtensionState

```typescript
interface ExtensionState {
  armedState: 'DISARMED' | 'ARMED_PENDING' | 'ARMED';
  sessionToken: string | null;
  connectionState: 'connected' | 'disconnected' | 'connecting';
}
```

The initial state is always `{ armedState: 'DISARMED', sessionToken: null, connectionState: 'disconnected' }`.

### BSW responsibilities

1. **Single WSS connection** — `connectWebSocket(url)` maintains one WebSocket instance. If a socket is already `OPEN` or `CONNECTING` the existing instance is reused. On close or error the socket is re-created after a 3-second delay (`RECONNECT_DELAY_MS`).

2. **State persistence** — every call to `updateState(updates)` merges `updates` into the in-memory `currentState` and immediately calls `saveState()` to persist to `chrome.storage.session`.

3. **State recovery on startup** — `recoverState()` is called on `chrome.runtime.onInstalled` and `chrome.runtime.onStartup`. It races `loadState()` against a 5-second timeout.

4. **Message routing** — the BSW listens on `chrome.runtime.onMessage` for messages from the popup and side panel (see [Popup Messages](#popup-messages)).

---

## State Recovery

On BSW startup `recoverState()` is called before the WSS connection is established:

```
Promise.race([
  loadState(),           ← read chrome.storage.session
  timeout(5000)          ← 5-second deadline
])
```

**On success** (stored state found before timeout):
- `armedState` is always set to `DISARMED` — armed state is never restored
- `sessionToken` is preserved — user does not need to re-enter credentials
- `connectionState` is set to `'disconnected'` — fresh WSS connection will be built

**On timeout or storage read error:**
- State is reset to `INITIAL_STATE` (fully DISARMED, no token)
- `chrome.runtime.sendMessage({ type: 'RECOVERY_NOTIFICATION', message: 'Manual re-authorization required' })` is sent to any open popup or side panel

**Never auto-re-arm:** ARMED and ARMED_PENDING are always reverted to DISARMED regardless of what was stored. This is a hard invariant — no code path in the BSW restores an armed state from storage.

---

## Two-Step Arming

The two-step arm flow is enforced by both the CloudEngine (`LiveTradingService`) and the Extension popup:

```
  DISARMED ──(REQUEST_ARM)──► ARMED_PENDING ──(CONFIRM_ARM)──► ARMED
                                     │
                              (DISARM at any time)
                                     ▼
                                  DISARMED
```

A single user action can never reach `ARMED` from `DISARMED`. The popup sends `REQUEST_ARM` on the Activate button click, which moves to `ARMED_PENDING`. A second explicit action (`CONFIRM_ARM` on the Confirm button) is required to reach `ARMED`.

---

## Popup Messages

Messages from the popup to the BSW use `chrome.runtime.sendMessage`:

| Message type | Sent when | BSW action |
|---|---|---|
| `GET_STATE` | Popup opens | Returns current `ExtensionState` |
| `REQUEST_ARM` | User clicks Activate button | Transitions DISARMED → ARMED_PENDING; sends `requestArm` to CloudEngine |
| `CONFIRM_ARM` | User clicks Confirm button (visible only in ARMED_PENDING) | Transitions ARMED_PENDING → ARMED; sends `confirmArm` to CloudEngine |
| `DISARM` | User clicks Disarm button (visible in ARMED or ARMED_PENDING) | Transitions any state → DISARMED; sends `disarm` to CloudEngine |

The popup renders button visibility based on the received state:
- **Activate button** — disabled when `armedState` is `ARMED_PENDING` or `ARMED`
- **Confirm button** — visible and enabled only when `armedState` is `ARMED_PENDING`
- **Disarm button** — visible when `armedState` is `ARMED` or `ARMED_PENDING`

---

## Side Panel

The side panel (`extension/src/sidepanel/sidepanel.ts`) provides live operational visibility:

### Live Positions

Positions are keyed by ID in a `Map<string, Position>` for O(1) updates on each CloudEngine push. Each position displays:
- Trading symbol, direction (LONG/SHORT)
- Entry price, current price
- Unrealized P&L
- MFE (Maximum Favourable Excursion) and MAE (Maximum Adverse Excursion) — pushed from `PositionMonitoringService`

### Signal Feed

The last 10 scored signals, ordered newest-first (index 0 = most recent). The feed is capped at `MAX_SIGNAL_FEED_SIZE = 10`. Each entry shows:
- Strategy code, composite score (0–100)
- Status: `active`, `rejected`, or `expired`
- Rejection reason (when status is `rejected`)
- Timestamp

### Alert Queue

Only `MAX`-priority alerts are displayed in the side panel alert queue. `CRITICAL`, `WARNING`, and `INFO` alerts are visible in the full dashboard. Each MAX-priority alert has an explicit **ACK** button — acknowledged alerts are removed from the queue. The `alertQueue` array contains only unacknowledged MAX-priority alerts.

---

## Full Dashboard

The full dashboard (`extension/src/dashboard/dashboard.ts`) provides analytics and monitoring:

### Strategy Performance Table

A table with one row per strategy showing: strategy code, win rate, expectancy, net P&L, and trade count. Data is pushed from CloudEngine analytics.

### Capital Growth Chart

An ordered array of `CapitalDataPoint` entries (`{ date: string, capital: number }`). Points are appended in chronological order and rendered as a time-series chart.

### Market Regime Heatmap

`RegimeHeatmapEntry[]` sorted by `signalCount` descending. Shows which regimes have produced the most signals, allowing quick identification of productive vs dormant regime states.

### Options Flow Panel

One row per monitored instrument showing: symbol, net OI change, put/call ratio, IV skew, large-block indicator, and a **staleness indicator**. When `isStale = true` (data > 60 seconds old) the row is visually flagged and the caller must suppress the `optionsFuturesConfirmation` score contribution per Requirement 20.7.

### Alert Queue

The dashboard alert queue receives all CloudEngine push notifications regardless of priority (MAX, CRITICAL, WARNING, INFO). Each alert shows: ID, priority, title, message.

---

## Security Invariants

Security invariants are implemented in `extension/src/security/security-invariants.ts` and enforced at every storage write and connection attempt.

### Forbidden `chrome.storage.local` Keys

The following keys are forbidden in `chrome.storage.local`:

```typescript
const FORBIDDEN_LOCAL_STORAGE_KEYS = [
  'sessionToken',
  'brokerCredentials',
  'apiKey',
  'dhanToken',
  'accessToken',
  'refreshToken',
] as const;
```

`secureLocalStorageSet(items)` checks every key against this list before calling `chrome.storage.local.set()`. If any key matches, a `SecurityError` is thrown and no write occurs. This prevents credential exposure to content scripts that have `chrome.storage.local` access.

### URL Validation

`assertSecureUrl(url)` throws a `SecurityError` for any URL not beginning with `wss://` or `https://`. This is called before every WebSocket connection and HTTP request originating from the extension. The CloudEngine's `DEFAULT_WSS_URL` (`wss://localhost:3000`) satisfies this constraint in development; production deployments use a real `wss://` endpoint.

### Storage Scope

All sensitive data (`sessionToken`, `armedState`, `connectionState`) lives in `chrome.storage.session`, which is BSW-scoped and not accessible to content scripts. `chrome.storage.local` is used only for non-sensitive extension configuration.

---

## Manifest

```json
{
  "manifest_version": 3,
  "name": "MoneyPrinter",
  "version": "0.1.0",
  "description": "Autonomous trading control plane for the MoneyPrinter CloudEngine. Communicates over WSS/HTTPS exclusively.",
  "permissions": ["storage", "alarms"],
  "background": {
    "service_worker": "dist/background/service-worker.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "MoneyPrinter"
  }
}
```

No content scripts are declared. No host permissions are declared. The `alarms` permission enables scheduled background tasks (e.g. proactive token refresh scheduling).

---

## Testing the Extension

Extension tests run with the jsdom environment using the config in `extension/jest.config.js`:

```bash
npm run test:extension
```

Test files follow the same `*.spec.ts` naming convention as the CloudEngine. State management helpers and rendering functions are exported from their modules so tests can exercise them without a DOM or Chrome runtime:

- `background.ts` exports `getCurrentState()`, `updateState()`, `recoverState()`, `connectWebSocket()`, and `_resetStateForTesting()`
- `sidepanel.ts` exports `signalFeed`, `alertQueue`, `positions`, and `resetState()`
- `popup.ts` exports `formatPnl()` and `renderState()`

DOM-touching calls are guarded with `typeof document !== 'undefined'` so tests run cleanly in jsdom and in the actual BSW environment (where there is no DOM).
