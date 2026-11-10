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
  | { type: 'OPEN_SIDE_PANEL' };

/** Runtime chrome shim — defined globally by the browser extension environment. */
declare const chrome: {
  runtime: {
    sendMessage<T = unknown>(
      message: BswMessage,
      callback?: (response: T) => void,
    ): void;
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
    activateBtn.disabled =
      state.armedState === 'ARMED_PENDING' || state.armedState === 'ARMED';
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
    setVisible(
      disarmBtn,
      state.armedState === 'ARMED' || state.armedState === 'ARMED_PENDING',
    );
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
