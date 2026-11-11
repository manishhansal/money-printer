/**
 * MoneyPrinter — MV3 Background Service Worker (BSW)
 *
 * Responsibilities:
 *  - Maintain a single WSS connection to the CloudEngine.
 *  - Persist { armedState, sessionToken, connectionState } in chrome.storage.session.
 *  - On BSW startup: attempt state recovery within 5 seconds (Requirement 1.3).
 *  - If recovery fails (timeout/error): enter DISARMED state and notify the user (Requirement 1.4).
 *  - NEVER auto-re-arm after restart, token renewal, or browser update (Requirement 1.5).
 *
 * Requirements: 1.1, 1.3, 1.4, 1.5
 */

import { ExtensionState, INITIAL_STATE } from './background.types';
import { saveState, loadState } from './state.manager';

// ─── Configurable constants ────────────────────────────────────────────────────

/** Default CloudEngine WebSocket endpoint (configurable for testing). */
export const DEFAULT_WSS_URL = 'ws://localhost:3003';

/** HTTP base URL for CloudEngine REST API calls. */
export const DEFAULT_HTTP_URL = 'http://localhost:3002';

/** Maximum time (ms) allowed to recover state from chrome.storage.session on startup. */
export const RECOVERY_TIMEOUT_MS = 5000;

/** Delay (ms) before attempting a WebSocket reconnect after close/error. */
export const RECONNECT_DELAY_MS = 3000;

// ─── Sentinel used to distinguish timeout from a resolved null result ─────────

const TIMEOUT_SENTINEL = Symbol('RECOVERY_TIMEOUT');

// ─── Module-level state ────────────────────────────────────────────────────────

/** The authoritative in-memory ExtensionState. Persisted on every mutation. */
export let currentState: ExtensionState = { ...INITIAL_STATE };

/** Active WebSocket connection (single instance). */
let activeSocket: WebSocket | null = null;

// ─── Public API ────────────────────────────────────────────────────────────────

/** Returns a shallow copy of the current state (safe for external inspection). */
export function getCurrentState(): ExtensionState {
  return { ...currentState };
}

/**
 * Merge `updates` into the current state and persist the result to
 * chrome.storage.session. Called on every state transition.
 */
export async function updateState(updates: Partial<ExtensionState>): Promise<void> {
  currentState = { ...currentState, ...updates };
  await saveState(currentState);
}

/**
 * Attempt to recover persisted state within `timeoutMs` milliseconds.
 *
 * Rules enforced:
 *  - ARMED and ARMED_PENDING are ALWAYS reverted to DISARMED (Requirement 1.5).
 *  - connectionState is reset to 'disconnected' — the WSS connection is rebuilt fresh.
 *  - sessionToken is preserved so the user can re-authenticate without re-entering credentials.
 *  - On timeout or error: enter INITIAL_STATE and notify the user (Requirement 1.4).
 *
 * @param timeoutMs  Override the 5-second deadline (useful in tests).
 */
export async function recoverState(timeoutMs: number = RECOVERY_TIMEOUT_MS): Promise<void> {
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
  });

  try {
    const result = await Promise.race([loadState(), timeoutPromise]);

    if (result === TIMEOUT_SENTINEL) {
      // ── Recovery timed out (Requirement 1.4) ──────────────────────────────
      currentState = { ...INITIAL_STATE };
      await saveState(currentState);
      notifyUser('Manual re-authorization required');
      return;
    }

    if (result !== null) {
      // ── Stored state found — restore with DISARMED override (Requirement 1.5) ──
      currentState = {
        armedState: 'DISARMED', // Never auto-re-arm
        sessionToken: result.sessionToken, // Preserved for re-authentication
        connectionState: 'disconnected', // Fresh WSS connection will be established
        sessionPnl: 0,
        activePositionsCount: 0,
        healthStatus: 'Healthy',
      };
    } else {
      // ── No stored state (first run or session cleared) ────────────────────
      currentState = { ...INITIAL_STATE };
    }

    await saveState(currentState);
  } catch {
    // ── Storage read error — treat as failed recovery (Requirement 1.4) ─────
    currentState = { ...INITIAL_STATE };
    await saveState(currentState);
    notifyUser('Manual re-authorization required');
  }
}

/**
 * Establish or reuse the single WSS connection to the CloudEngine.
 * Automatically reconnects after close/error (Requirement 1.3).
 *
 * @param url  Override the default WSS URL (useful in tests).
 */
export function connectWebSocket(url: string = DEFAULT_WSS_URL): WebSocket | null {
  if (
    activeSocket &&
    (activeSocket.readyState === WebSocket.OPEN ||
      activeSocket.readyState === WebSocket.CONNECTING)
  ) {
    // Already connected or connecting — reuse
    return activeSocket;
  }

  // Signal connection attempt to the state
  updateState({ connectionState: 'connecting' }).catch(() => {
    /* fire-and-forget; storage errors are non-fatal here */
  });

  const socket = new WebSocket(url);
  activeSocket = socket;

  socket.addEventListener('open', () => {
    updateState({ connectionState: 'connected' }).catch(() => {/* ignore */});
    // Start polling for signals now that the connection is live
    startSignalPolling();
  });

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(event.data) as { event: string; data: unknown };

      if (msg.event === 'notification') {
        const alert = msg.data as {
          id: string;
          priority: string;
          title: string;
          message: string;
          createdAt: string;
        };
        // Relay the alert to the sidepanel's alert queue
        chrome.runtime.sendMessage({ type: 'ALERT', payload: alert }, () => {
          void chrome.runtime.lastError;
        });
      }
    } catch {
      // Malformed message — ignore
    }
  });

  socket.addEventListener('close', () => {
    if (activeSocket === socket) {
      activeSocket = null;
    }
    updateState({ connectionState: 'disconnected' }).catch(() => {/* ignore */});
    stopSignalPolling();
    // Reconnect after delay
    setTimeout(() => connectWebSocket(url), RECONNECT_DELAY_MS);
  });

  socket.addEventListener('error', () => {
    if (activeSocket === socket) {
      activeSocket = null;
    }
    updateState({ connectionState: 'disconnected' }).catch(() => {/* ignore */});
    stopSignalPolling();
  });

  return socket;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Send a notification message to the Extension popup / side-panel.
 * Silently swallowed if no listeners are registered (UI not open).
 * Uses the callback form with chrome.runtime.lastError to suppress the
 * "Receiving end does not exist" error that fires in MV3 when no page listens.
 */
function notifyUser(message: string): void {
  chrome.runtime.sendMessage({ type: 'RECOVERY_NOTIFICATION', message }, () => {
    // Access lastError to prevent Chrome from logging the unhandled error
    // when the popup / side-panel is not currently open.
    void chrome.runtime.lastError;
  });
}

// ─── Test-only reset helper ────────────────────────────────────────────────────

/**
 * @internal Reset in-memory state to INITIAL_STATE between tests.
 * NOT intended for production use.
 */
export function _resetStateForTesting(): void {
  currentState = { ...INITIAL_STATE };
  activeSocket = null;
}

// ─── MV3 Background Service Worker event registrations ────────────────────────

/**
 * Handle messages from the popup and side panel.
 *
 * GET_STATE  → fetch latest P&L from CloudEngine and return full ExtensionState.
 * REQUEST_ARM / CONFIRM_ARM / DISARM → delegate to LiveTradingService via HTTP.
 */
chrome.runtime.onMessage.addListener(
  (message: { type: string }, _sender, sendResponse: (state: unknown) => void) => {
    if (message.type === 'GET_STATE') {
      // Fetch session P&L from CloudEngine, then return merged state.
      fetchSessionPnl()
        .then((pnl) => {
          sendResponse({ ...currentState, ...pnl });
        })
        .catch(() => {
          sendResponse({
            ...currentState,
            sessionPnl: 0,
            activePositionsCount: 0,
            healthStatus: 'Down' as const,
          });
        });
      return true;
    }

    if (message.type === 'REQUEST_ARM') {
      // Step 1 of two-step arm: DISARMED → ARMED_PENDING
      updateState({ armedState: 'ARMED_PENDING' })
        .then(() => sendResponse({ ...currentState }))
        .catch(() => sendResponse({ ...currentState }));
      return true;
    }

    if (message.type === 'CONFIRM_ARM') {
      // Step 2: ARMED_PENDING → ARMED
      updateState({ armedState: 'ARMED' })
        .then(() => sendResponse({ ...currentState }))
        .catch(() => sendResponse({ ...currentState }));
      return true;
    }

    if (message.type === 'DISARM') {
      // Reset to safe state from any armed state
      updateState({ armedState: 'DISARMED' })
        .then(() => sendResponse({ ...currentState }))
        .catch(() => sendResponse({ ...currentState }));
      return true;
    }

    if (message.type === 'OPEN_SIDE_PANEL') {
      // Open the side panel for the current window
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.windowId) {
          (chrome.sidePanel as unknown as { open: (opts: { windowId: number }) => Promise<void> })
            .open({ windowId: tabs[0].windowId })
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false }));
        } else {
          sendResponse({ ok: false });
        }
      });
      return true;
    }
  },
);

/**
 * Fetch the current session P&L summary from GET /portfolio/summary.
 * Uses the PAPER engine summary (live starts at 0 until armed).
 */
async function fetchSessionPnl(): Promise<{
  sessionPnl: number;
  activePositionsCount: number;
  healthStatus: 'Healthy' | 'Degraded' | 'Down';
}> {
  const token = currentState.sessionToken;
  const baseUrl = DEFAULT_HTTP_URL;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}/portfolio/summary`, { headers });
  if (!res.ok) {
    return { sessionPnl: 0, activePositionsCount: 0, healthStatus: 'Degraded' };
  }

  const data = (await res.json()) as {
    paper: { netPnl: number };
    live: { netPnl: number };
  };

  // Show live P&L when armed, paper P&L otherwise.
  const isLive = currentState.armedState === 'ARMED';
  const netPnl = isLive ? (data.live?.netPnl ?? 0) : (data.paper?.netPnl ?? 0);

  return {
    sessionPnl: netPnl,
    activePositionsCount: 0, // Extended in future via /portfolio/positions
    healthStatus: 'Healthy',
  };
}

/**
 * Fetch open paper positions and broadcast each as a POSITION_UPDATE message
 * to the sidepanel so the LIVE POSITIONS table stays current.
 *
 * Maps paper position fields to the sidepanel's Position interface.
 */
async function fetchAndBroadcastPositions(): Promise<void> {
  try {
    const res = await fetch(`${DEFAULT_HTTP_URL}/paper-trading/positions`);
    if (!res.ok) return;

    const positions = (await res.json()) as Array<{
      id: string;
      instrument_id: string;
      direction: 'LONG' | 'SHORT';
      quantity: number;
      average_entry_price: string;
      unrealized_pnl: string;
    }>;

    for (const p of positions) {
      const entryPrice = parseFloat(p.average_entry_price);
      const unrealized = parseFloat(p.unrealized_pnl);
      const currentPrice = unrealized !== 0
        ? entryPrice + unrealized / p.quantity
        : entryPrice;

      const payload = {
        id: p.id,
        symbol: p.instrument_id.slice(0, 8), // short display until symbol lookup added
        entryPrice,
        currentPrice,
        unrealizedPnl: unrealized,
        direction: p.direction,
      };
      chrome.runtime.sendMessage({ type: 'POSITION_UPDATE', payload }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch {
    // Network unavailable — ignore
  }
}

// ─── Signal polling ────────────────────────────────────────────────────────────

/**
 * Fetch the ranked signal list from GET /signals/ranked and broadcast each
 * signal as a SIGNAL_UPDATE message to all extension pages (sidepanel, popup).
 *
 * This endpoint is public (no JWT required) so it works even before login.
 * Called on WebSocket connect and every 30 seconds while connected.
 */
async function fetchAndBroadcastSignals(): Promise<void> {
  try {
    const res = await fetch(`${DEFAULT_HTTP_URL}/signals/ranked`);
    if (!res.ok) return;

    const ranked = (await res.json()) as Array<{
      signal: {
        id: string;
        compositeScore: string;
        status: string;
        rejectionReason?: string | null;
        signalTimestamp: string;
        strategy?: { code: string };
      };
      rank: number;
    }>;

    for (const item of ranked) {
      const sig = item.signal;
      const payload = {
        id: sig.id,
        strategyCode: sig.strategy?.code ?? 'N/A',
        score: Math.round(parseFloat(sig.compositeScore)),
        status: sig.status as 'active' | 'rejected' | 'expired',
        timestamp: new Date(sig.signalTimestamp),
        rejectionReason: sig.rejectionReason ?? undefined,
      };
      // Relay each signal to the sidepanel via chrome message.
      // Use callback form to consume chrome.runtime.lastError and suppress
      // the "Receiving end does not exist" error when no page is open.
      chrome.runtime.sendMessage({ type: 'SIGNAL_UPDATE', payload }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch {
    // Network unavailable — ignore
  }
}

/** Interval handle for the signal polling loop (null when not connected). */
let signalPollInterval: ReturnType<typeof setInterval> | null = null;

/** Start polling for signals and positions every 15 seconds. */
function startSignalPolling(): void {
  if (signalPollInterval !== null) return; // already running
  // Immediate fetches on connect
  void fetchAndBroadcastSignals();
  void fetchAndBroadcastPositions();
  signalPollInterval = setInterval(() => {
    void fetchAndBroadcastSignals();
    void fetchAndBroadcastPositions();
  }, 15_000); // 15 s — snappy enough for live P&L updates
}

/** Stop the signal polling loop. */
function stopSignalPolling(): void {
  if (signalPollInterval !== null) {
    clearInterval(signalPollInterval);
    signalPollInterval = null;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await recoverState();
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(async () => {
  await recoverState();
  connectWebSocket();
});
