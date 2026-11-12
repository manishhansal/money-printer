/**
 * Popup script for the MoneyPrinter Chrome Extension.
 *
 * Implements the two-step ARM/DISARM UI:
 *   DISARMED  →(Activate)→  ARMED_PENDING  →(Confirm)→  ARMED
 *
 * A single user action cannot transition to ARMED state (Requirement 11.1).
 * All state mutations are delegated to the Background Service Worker (BSW)
 * via chrome.runtime.sendMessage.
 *
 * Requirements: 1.1, 11.1
 */

// ---------------------------------------------------------------------------
// Minimal Chrome Extension API declarations (avoids full @types/chrome dep)
// ---------------------------------------------------------------------------

/** Messages sent from the popup to the Background Service Worker. */
export type BswMessage =
  | { type: 'GET_STATE' }
  | { type: 'REQUEST_ARM' }
  | { type: 'CONFIRM_ARM' }
  | { type: 'DISARM' }
  | { type: 'OPEN_SIDE_PANEL' }
  | { type: 'GET_SETTINGS' }
  | {
      type: 'SAVE_SETTINGS';
      payload: { paperStartingCapital: string; defaultRiskPercentage: string };
    };

/** Runtime chrome shim — defined globally by the browser extension environment. */
declare const chrome: {
  runtime: {
    sendMessage<T = unknown>(message: BswMessage, callback?: (response: T) => void): void;
  };
  storage: {
    local: {
      get(keys: string | string[], callback: (result: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, callback?: () => void): void;
    };
  };
};

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface PopupState {
  armedState: 'DISARMED' | 'ARMED_PENDING' | 'ARMED';
  healthStatus: 'Healthy' | 'Degraded' | 'Down';
  sessionPnl: number;
  activePositionsCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a numeric P&L value as a rupee string with sign prefix.
 * Sign always precedes the ₹ symbol: "+₹1500.75", "-₹750.50", "₹0.00".
 * Positive values get a leading "+" to make direction immediately obvious.
 */
export function formatPnl(pnl: number): string {
  const sign = pnl > 0 ? '+' : pnl < 0 ? '-' : '';
  return `${sign}₹${Math.abs(pnl).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Core UI renderer
// ---------------------------------------------------------------------------

/**
 * Update every popup element to reflect the current PopupState.
 *
 * Button visibility rules (Requirement 11.1):
 *   - Activate: disabled when ARMED_PENDING or ARMED
 *   - Confirm:  visible + enabled ONLY when ARMED_PENDING
 *   - Disarm:   visible when ARMED or ARMED_PENDING
 */
export function renderState(state: PopupState): void {
  // ── Armed state label ──────────────────────────────────────────────────────
  const armedStateLabel = document.getElementById('armed-state-label');
  if (armedStateLabel) {
    armedStateLabel.textContent = state.armedState;
    armedStateLabel.className = 'info-value ' + armedStateCssClass(state.armedState);
  }

  // ── Activate button ────────────────────────────────────────────────────────
  // Disabled in ARMED_PENDING and ARMED states so a single click cannot arm.
  const activateBtn = document.getElementById('activate-btn') as HTMLButtonElement | null;
  if (activateBtn) {
    activateBtn.disabled = state.armedState === 'ARMED_PENDING' || state.armedState === 'ARMED';
  }

  // ── Confirm button ─────────────────────────────────────────────────────────
  // Visible and enabled ONLY when awaiting confirmation (ARMED_PENDING).
  const confirmBtn = document.getElementById('confirm-btn') as HTMLButtonElement | null;
  if (confirmBtn) {
    const isPending = state.armedState === 'ARMED_PENDING';
    setVisible(confirmBtn, isPending);
    confirmBtn.disabled = !isPending;
  }

  // ── Disarm button ──────────────────────────────────────────────────────────
  // Shown whenever the engine is not fully disarmed (ARMED_PENDING or ARMED).
  const disarmBtn = document.getElementById('disarm-btn') as HTMLButtonElement | null;
  if (disarmBtn) {
    setVisible(disarmBtn, state.armedState === 'ARMED' || state.armedState === 'ARMED_PENDING');
  }

  // ── System health badge ────────────────────────────────────────────────────
  const healthBadge = document.getElementById('health-badge');
  if (healthBadge) {
    healthBadge.textContent = state.healthStatus;
    healthBadge.className = `badge badge-${state.healthStatus.toLowerCase()}`;
  }

  // ── Session P&L ───────────────────────────────────────────────────────────
  const sessionPnlEl = document.getElementById('session-pnl');
  if (sessionPnlEl) {
    sessionPnlEl.textContent = formatPnl(state.sessionPnl);
    sessionPnlEl.className = `info-value ${pnlCssClass(state.sessionPnl)}`;
  }

  // ── Active positions count ─────────────────────────────────────────────────
  const positionsCountEl = document.getElementById('active-positions-count');
  if (positionsCountEl) {
    positionsCountEl.textContent = String(state.activePositionsCount);
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

/**
 * Handle Activate button click.
 * Sends 'REQUEST_ARM' to the BSW → transitions engine to ARMED_PENDING.
 * The Confirm step is still required before ARMED is reached.
 */
export function handleActivate(): void {
  chrome.runtime.sendMessage<PopupState>({ type: 'REQUEST_ARM' }, (state) => {
    if (state) renderState(state);
  });
}

/**
 * Handle Confirm button click.
 * Sends 'CONFIRM_ARM' to the BSW → transitions engine from ARMED_PENDING to ARMED.
 */
export function handleConfirm(): void {
  chrome.runtime.sendMessage<PopupState>({ type: 'CONFIRM_ARM' }, (state) => {
    if (state) renderState(state);
  });
}

/**
 * Handle Disarm button click.
 * Sends 'DISARM' to the BSW → transitions engine back to DISARMED from any state.
 */
export function handleDisarm(): void {
  chrome.runtime.sendMessage<PopupState>({ type: 'DISARM' }, (state) => {
    if (state) renderState(state);
  });
}

// ---------------------------------------------------------------------------
// Initializer
// ---------------------------------------------------------------------------

/**
 * Initialize the popup by fetching current state from the BSW and wiring
 * button event listeners.  Called on DOMContentLoaded.
 */
export async function initPopup(): Promise<void> {
  return new Promise<void>((resolve) => {
    chrome.runtime.sendMessage<PopupState>({ type: 'GET_STATE' }, (state) => {
      renderState(state);

      document.getElementById('activate-btn')?.addEventListener('click', handleActivate);
      document.getElementById('confirm-btn')?.addEventListener('click', handleConfirm);
      document.getElementById('disarm-btn')?.addEventListener('click', handleDisarm);
      document.getElementById('sidepanel-btn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
        window.close(); // close popup after opening side panel
      });

      // ── Settings: load current values from CloudEngine ──────────────────
      loadSettings();

      // ── Settings: update risk hint when capital changes ──────────────────
      document.getElementById('paper-capital-input')?.addEventListener('input', updateRiskHint);
      document.getElementById('risk-pct-input')?.addEventListener('input', updateRiskHint);

      // ── Settings: save button ─────────────────────────────────────────────
      document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);

      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Private utilities
// ---------------------------------------------------------------------------

function armedStateCssClass(armedState: PopupState['armedState']): string {
  switch (armedState) {
    case 'ARMED':
      return 'state-armed';
    case 'ARMED_PENDING':
      return 'state-armed-pending';
    default:
      return 'state-disarmed';
  }
}

function pnlCssClass(pnl: number): string {
  if (pnl > 0) return 'pnl-positive';
  if (pnl < 0) return 'pnl-negative';
  return 'pnl-neutral';
}

function setVisible(el: HTMLElement, visible: boolean): void {
  if (visible) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Settings helpers — load, display and save paper capital config
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// API base URL resolution — initialised from chrome.storage.local on load
// ---------------------------------------------------------------------------

/**
 * Module-level cache so getApiBaseUrl() stays synchronous.
 * Pre-populated from chrome.storage.local immediately when the popup script
 * loads.  Falls back to localhost:3002 until the async read completes (first
 * call in the same tick), then uses the stored value for all subsequent calls.
 */
let _cachedApiUrl: string | null = null;

// Kick off storage read immediately at module-load time (non-blocking).
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get('apiBaseUrl', (result: Record<string, unknown>) => {
    const stored = result['apiBaseUrl'];
    if (stored && typeof stored === 'string' && stored.startsWith('http')) {
      _cachedApiUrl = stored;
      // Also propagate to the window global so future calls are instant.
      (window as unknown as Record<string, unknown>)['MONEYPRINTER_API_URL'] = stored;
    }
  });
}

/**
 * Resolves the CloudEngine base URL.
 *
 * Priority:
 *   1. `window.MONEYPRINTER_API_URL` — injected at build time for production
 *   2. `chrome.storage.local` key `apiBaseUrl` — set by the user in settings
 *      (populated asynchronously above; available from the second call onward)
 *   3. `http://localhost:3002` — development fallback
 *
 * Requirement P1-HIGH-002.
 */
function getApiBaseUrl(): string {
  // Build-time override (injected via manifest externally_connectable / background).
  const win = window as unknown as Record<string, unknown>;
  if (typeof window !== 'undefined' && win['MONEYPRINTER_API_URL']) {
    return String(win['MONEYPRINTER_API_URL']);
  }
  // User-configured URL loaded from chrome.storage.local.
  if (_cachedApiUrl) return _cachedApiUrl;
  // Development fallback.
  return 'http://localhost:3002';
}

/** Fetch current settings from CloudEngine and populate the input fields. */
function loadSettings(): void {
  const apiBase = getApiBaseUrl();
  fetch(`${apiBase}/settings`)
    .then(
      (r) =>
        r.json() as Promise<{
          paperStartingCapital: string;
          defaultRiskPercentage: string;
          paperRiskPerTrade: string;
          paperDailyLossLimitRupees: string;
        }>,
    )
    .then((s) => {
      const capitalEl = document.getElementById('paper-capital-input') as HTMLInputElement | null;
      const riskEl = document.getElementById('risk-pct-input') as HTMLInputElement | null;
      if (capitalEl) capitalEl.value = parseFloat(s.paperStartingCapital).toFixed(0);
      if (riskEl) riskEl.value = parseFloat(s.defaultRiskPercentage).toFixed(1);
      updateRiskHint();
    })
    .catch(() => {
      /* server unreachable — keep HTML defaults */
    });
}

/** Recompute and display the derived risk/daily-limit hint below the capital input. */
function updateRiskHint(): void {
  const capitalEl = document.getElementById('paper-capital-input') as HTMLInputElement | null;
  const riskEl = document.getElementById('risk-pct-input') as HTMLInputElement | null;
  const hintEl = document.getElementById('risk-hint');
  if (!capitalEl || !riskEl || !hintEl) return;

  const capital = parseFloat(capitalEl.value) || 0;
  const riskPct = parseFloat(riskEl.value) || 1;
  const riskPerTrade = ((capital * riskPct) / 100).toFixed(0);
  const dailyLimit = ((capital * 2) / 100).toFixed(0); // 2% daily loss limit
  hintEl.textContent = `Risk/trade: ₹${riskPerTrade} · Daily limit: ₹${dailyLimit}`;
}

/** Save updated settings to CloudEngine via PUT /settings. */
function saveSettings(): void {
  const capitalEl = document.getElementById('paper-capital-input') as HTMLInputElement | null;
  const riskEl = document.getElementById('risk-pct-input') as HTMLInputElement | null;
  const statusEl = document.getElementById('settings-status');
  const saveBtn = document.getElementById('save-settings-btn') as HTMLButtonElement | null;

  if (!capitalEl || !riskEl) return;

  const capital = parseFloat(capitalEl.value);
  const riskPct = parseFloat(riskEl.value);

  if (isNaN(capital) || capital < 10000) {
    if (statusEl) {
      statusEl.style.color = '#f44336';
      statusEl.textContent = 'Min capital: ₹10,000';
    }
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  if (statusEl) {
    statusEl.style.color = '#9e9e9e';
    statusEl.textContent = 'Saving…';
  }

  const apiBase = getApiBaseUrl();
  fetch(`${apiBase}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paperStartingCapital: capital.toFixed(2),
      defaultRiskPercentage: riskPct.toFixed(4),
    }),
  })
    .then((r) => {
      if (r.ok) {
        if (statusEl) {
          statusEl.style.color = '#4caf50';
          statusEl.textContent = '✓ Saved';
        }
        updateRiskHint();
      } else {
        if (statusEl) {
          statusEl.style.color = '#f44336';
          statusEl.textContent = 'Save failed';
        }
      }
    })
    .catch(() => {
      if (statusEl) {
        statusEl.style.color = '#f44336';
        statusEl.textContent = 'Server unreachable';
      }
    })
    .finally(() => {
      if (saveBtn) saveBtn.disabled = false;
      setTimeout(() => {
        if (statusEl) statusEl.textContent = '';
      }, 3000);
    });
}

// ---------------------------------------------------------------------------
// Auto-initialize when loaded as a browser extension popup
// Guard prevents auto-init during unit tests (NODE_ENV === 'test')
// ---------------------------------------------------------------------------
/* istanbul ignore next */
if (
  typeof document !== 'undefined' &&
  (typeof process === 'undefined' || process.env['NODE_ENV'] !== 'test')
) {
  document.addEventListener('DOMContentLoaded', () => {
    initPopup().catch(console.error);
  });
}
