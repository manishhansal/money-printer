# MoneyPrinter Chrome Extension

## Overview

The Chrome Extension is the control plane for the MoneyPrinter CloudEngine. It runs as a Chrome MV3 extension with four UI surfaces and a Background Service Worker (BSW) that owns the single WebSocket connection to the CloudEngine.

---

## Loading the Extension (Local Dev)

1. Build the extension: `npm run build:extension`
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `extension/` folder
5. The MoneyPrinter icon appears in the Chrome toolbar

After any source change: `npm run build:extension` → ↺ reload in `chrome://extensions`.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Chrome Extension (MV3)                                            │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Background Service Worker (BSW)                             │  │
│  │  - Persistent WebSocket → ws://localhost:3003 (dev)          │  │
│  │  - HTTP fetch → http://localhost:3002/portfolio/summary      │  │
│  │  - In-memory ExtensionState (armedState, sessionPnl, etc.)   │  │
│  │  - Persists to chrome.storage.session                        │  │
│  │  - Handles: GET_STATE, REQUEST_ARM, CONFIRM_ARM, DISARM,     │  │
│  │             OPEN_SIDE_PANEL, GET_SETTINGS, SAVE_SETTINGS     │  │
│  └───────────┬────────────────────────┬─────────────────────────┘  │
│              │ chrome.runtime.sendMessage                           │
│  ┌───────────┴───────────────────────────────────────────────────┐  │
│  │  Popup (ARM/DISARM + Settings panel)                          │  │
│  │  Side Panel  │  Full Dashboard                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ws://localhost:3003 ◄──────────────────────► CloudEngine :3003   │
│  http://localhost:3002 ◄─────────────────────► CloudEngine :3002  │
└────────────────────────────────────────────────────────────────────┘
```

**Permissions declared in `manifest.json`:** `storage`, `alarms`, `sidePanel`, `tabs`

**Host permissions:** `http://localhost/*`, `https://localhost/*`

---

## ExtensionState

The BSW is the single source of truth for `ExtensionState`:

```typescript
interface ExtensionState {
  armedState: 'DISARMED' | 'ARMED_PENDING' | 'ARMED';
  sessionToken: string | null;
  connectionState: 'connected' | 'disconnected' | 'connecting';
  /** Net session P&L after all trading charges (INR). Fetched from /portfolio/summary. */
  sessionPnl: number;
  /** Number of currently open positions. */
  activePositionsCount: number;
  /** System health status driven by CloudEngine health metrics. */
  healthStatus: 'Healthy' | 'Degraded' | 'Down';
}
```

Initial state: `{ armedState: 'DISARMED', sessionPnl: 0, activePositionsCount: 0, healthStatus: 'Healthy', ... }`

---

## Message Protocol

The popup and side panel communicate with the BSW via `chrome.runtime.sendMessage`. Every message returns the updated `ExtensionState` (or sub-data) in the callback.

| Message type | Direction | What it does |
|---|---|---|
| `GET_STATE` | Popup → BSW | Fetch P&L from `/portfolio/summary`, return full `ExtensionState` |
| `REQUEST_ARM` | Popup → BSW | DISARMED → ARMED_PENDING; returns updated state |
| `CONFIRM_ARM` | Popup → BSW | ARMED_PENDING → ARMED; returns updated state |
| `DISARM` | Popup → BSW | Any → DISARMED; returns updated state |
| `OPEN_SIDE_PANEL` | Popup → BSW | Opens the side panel via `chrome.sidePanel.open()` |
| `GET_SETTINGS` | Popup → BSW | Fetches `GET /settings` from CloudEngine |
| `SAVE_SETTINGS` | Popup → BSW | Sends `PUT /settings` with paper capital + risk % |
| `RECOVERY_NOTIFICATION` | BSW → UI | Notifies popup/side panel after failed state recovery |

---

## Two-Step Arming Flow

A single click can never transition to `ARMED` state (Requirement 11.1):

```
DISARMED  →[Activate Live Mode]→  ARMED_PENDING  →[Confirm Arm]→  ARMED
                                       ↓                              ↓
                                   [Disarm]                       [Disarm]
                                       ↓                              ↓
                                   DISARMED                       DISARMED
```

The popup's `Activate Live Mode` button sends `REQUEST_ARM`. The `Confirm Arm` button (only visible in `ARMED_PENDING`) sends `CONFIRM_ARM`. `Disarm` sends `DISARM` from any armed state.

---

## Popup Settings Panel

The popup has a settings section at the bottom for configuring paper trading:

```
Paper Capital (₹)  [ 50000  ]
                   Risk/trade: ₹500 · Daily limit: ₹1,000
Risk per trade (%) [ 1.0    ]
[ Save Settings ]
```

Saving calls `PUT /settings` on the CloudEngine. All risk limits auto-scale — changing capital from ₹50K to ₹1L automatically doubles the per-trade risk amount.

---

## State Recovery

On BSW startup `recoverState()` races `loadState()` against a 5-second timeout:

- **On success**: `armedState` reset to `DISARMED` (never auto-re-arm), `sessionToken` preserved, `connectionState` reset to `disconnected`.
- **On timeout or error**: reset to `INITIAL_STATE`, notify user to re-authorize.

---

## WebSocket Connection (Local Dev)

The BSW connects to `ws://localhost:3003` (plain WebSocket, no TLS). For production deployment behind an ALB the URL should be `wss://api.yourdomain.com/ws` (TLS terminated at ALB).

The `DEFAULT_WSS_URL` constant in `background.ts` controls this. Auto-reconnects with 3-second delay.

---

## Security Invariants

`extension/src/security/security-invariants.ts` enforces:

1. **Forbidden `chrome.storage.local` keys** — `sessionToken`, `brokerCredentials`, `apiKey`, `dhanToken`, `accessToken`, `refreshToken` must NEVER be stored in `chrome.storage.local`. Use `chrome.storage.session` exclusively. `secureLocalStorageSet()` throws `SecurityError` if any forbidden key is attempted.

2. **URL validation** — `assertSecureUrl(url)` throws for URLs not starting with `wss://` or `https://`. Plain `ws://` and `http://` are blocked in production.

> Local dev exception: the BSW uses `ws://localhost:3003` and `http://localhost:3002` explicitly — these bypass `assertSecureUrl()` because they're hardcoded connection targets, not user-supplied URLs.

---

## Build System

The extension is bundled with **esbuild** via `extension/build.mjs`:

```bash
npm run build:extension          # one-shot
npm run build:extension:watch    # watch for changes
```

Entry points compiled:
- `src/background/background.ts` → `dist/background/background.js` (IIFE, Chrome 120)
- `src/popup/popup.ts` → `dist/popup/popup.js`
- `src/sidepanel/sidepanel.ts` → `dist/sidepanel/sidepanel.js`
- `src/dashboard/dashboard.ts` → `dist/dashboard/dashboard.js`

HTML files are copied: `src/popup/popup.html` → `dist/popup/popup.html`, etc.

The `dist/` directory is committed to git so the extension can be loaded immediately without a build step.

---

## Tests

```bash
# All 53 extension tests
npm run test:extension

# Single suite
npx jest --config extension/jest.config.js --testPathPattern="background" --forceExit
```

The extension uses Jest with jsdom for popup tests (`@jest-environment jsdom` docblock) and node environment for background/security tests. The `jest.setup.ts` provides a mock `chrome` global with `storage.session`, `runtime`, `tabs`, `sidePanel`, and `onMessage`.
