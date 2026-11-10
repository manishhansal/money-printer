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
export const DEFAULT_WSS_URL = 'wss://localhost:3003';

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
  });

  socket.addEventListener('close', () => {
    if (activeSocket === socket) {
      activeSocket = null;
    }
    updateState({ connectionState: 'disconnected' }).catch(() => {/* ignore */});
    // Reconnect after delay
    setTimeout(() => connectWebSocket(url), RECONNECT_DELAY_MS);
  });

  socket.addEventListener('error', () => {
    if (activeSocket === socket) {
      activeSocket = null;
    }
    updateState({ connectionState: 'disconnected' }).catch(() => {/* ignore */});
  });

  return socket;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Send a notification message to the Extension popup / side-panel.
 * Silently swallowed if no listeners are registered (UI not open).
 */
function notifyUser(message: string): void {
  try {
    chrome.runtime.sendMessage({ type: 'RECOVERY_NOTIFICATION', message });
  } catch {
    // Popup / side-panel not open — no-op
  }
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
          // Network unavailable — return cached state with zero P&L.
          sendResponse({
            ...currentState,
            sessionPnl: 0,
            activePositionsCount: 0,
            healthStatus: 'Down' as const,
          });
        });
      return true; // Keep the message channel open for the async response.
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

chrome.runtime.onInstalled.addListener(async () => {
  await recoverState();
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(async () => {
  await recoverState();
  connectWebSocket();
});
