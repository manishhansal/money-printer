/**
 * sidepanel.ts
 *
 * MoneyPrinter Chrome Extension — Side Panel
 *
 * Responsibilities (Requirement 1.1):
 *  - Live position monitor with real-time P&L updates via CloudEngine WebSocket push
 *    (proxied through the Background Service Worker).
 *  - Recent signal feed showing the last 10 signals, ordered newest-first.
 *  - Alert queue surfacing only MAX-priority alerts with an explicit ACK button.
 *
 * Architecture note:
 *  State management and rendering helpers are exported as named functions so
 *  unit tests can exercise them without a DOM or Chrome runtime present.
 *  DOM-touching calls are guarded with `typeof document !== 'undefined'`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

export interface Position {
  id: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  direction: 'LONG' | 'SHORT';
}

export interface Signal {
  id: string;
  strategyCode: string;
  score: number;
  status: 'active' | 'rejected' | 'expired';
  timestamp: Date;
  /** Optional; populated only when status === 'rejected'. */
  rejectionReason?: string;
}

export interface Alert {
  id: string;
  priority: 'MAX' | 'CRITICAL' | 'WARNING' | 'INFO';
  title: string;
  message: string;
  acknowledged: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// (Exported so unit tests can read and reset state without touching the DOM.)
// ─────────────────────────────────────────────────────────────────────────────

/** Ordered newest-first; capped at MAX_SIGNAL_FEED_SIZE. */
export let signalFeed: Signal[] = [];

/** Only MAX-priority, unacknowledged alerts. */
export let alertQueue: Alert[] = [];

/** Keyed by position.id for O(1) updates. */
export let positions: Map<string, Position> = new Map();

/** Maximum number of signals retained in the feed. */
export const MAX_SIGNAL_FEED_SIZE = 10;

// ─────────────────────────────────────────────────────────────────────────────
// State reset (test helper)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resets all module-level state to empty.
 * Called by unit tests before each case to ensure isolation.
 */
export function resetState(): void {
  signalFeed = [];
  alertQueue = [];
  positions = new Map();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure business-logic helpers
// (No DOM or Chrome API access — safe to call in any environment.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the CSS class name that expresses the sign of a P&L value.
 *
 * Rules:
 *  - Zero or positive → 'pnl-positive' (green)
 *  - Negative         → 'pnl-negative' (red)
 */
export function getPnlColorClass(pnl: number): 'pnl-positive' | 'pnl-negative' {
  return pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
}

/**
 * Returns the human-readable status string for a signal row.
 *
 * When a signal is rejected and carries a rejectionReason, the reason is
 * surfaced directly (e.g. "Rejected: Score below threshold").
 * For active / expired signals the status string is returned as-is.
 */
export function getSignalStatusText(signal: Signal): string {
  if (signal.status === 'rejected' && signal.rejectionReason) {
    return `Rejected: ${signal.rejectionReason}`;
  }
  return signal.status;
}

/**
 * Returns the score-based CSS class for the signal score column.
 *
 *  ≥ 70  → 'signal-score-high'   (green)
 *  40–69 → 'signal-score-mid'    (amber)
 *  < 40  → 'signal-score-low'    (red)
 */
export function getScoreColorClass(
  score: number,
): 'signal-score-high' | 'signal-score-mid' | 'signal-score-low' {
  if (score >= 70) return 'signal-score-high';
  if (score >= 40) return 'signal-score-mid';
  return 'signal-score-low';
}

// ─────────────────────────────────────────────────────────────────────────────
// State management (mutates module-level state, then schedules a render)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merges `newSignals` into the signal feed, re-sorts newest-first, and
 * truncates to the last MAX_SIGNAL_FEED_SIZE entries.
 *
 * Called when the BSW delivers a signal-update message.
 */
export function updateSignalFeed(newSignals: Signal[]): void {
  // Merge by id: replace existing entry if id matches, otherwise append.
  const feedMap = new Map<string, Signal>(signalFeed.map((s) => [s.id, s]));
  for (const s of newSignals) {
    feedMap.set(s.id, s);
  }

  signalFeed = Array.from(feedMap.values())
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    )
    .slice(0, MAX_SIGNAL_FEED_SIZE);

  renderSignalFeed();
}

/**
 * Adds an alert to the queue **only if its priority is MAX**.
 * Alerts with CRITICAL, WARNING, or INFO priority are intentionally ignored
 * by the side panel (Requirement 1.1 — alert queue is for MAX-priority only).
 */
export function addToAlertQueue(alert: Alert): void {
  if (alert.priority !== 'MAX') {
    return;
  }
  alertQueue.push(alert);
  renderAlertQueue();
}

/**
 * Removes the alert with the given id from the queue (acknowledgment).
 * Idempotent: calling with an unknown id is a no-op.
 */
export function acknowledgeAlert(alertId: string): void {
  alertQueue = alertQueue.filter((a) => a.id !== alertId);
  renderAlertQueue();
}

/**
 * Updates an existing position or inserts it if not yet tracked.
 * On real-time tick updates the BSW sends full Position objects; this
 * function ensures the table row reflects the latest state.
 */
export function updatePosition(position: Position): void {
  positions.set(position.id, position);
  renderPositionsTable();
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome Extension messaging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers a listener on `chrome.runtime.onMessage` to receive updates
 * pushed from the Background Service Worker.
 *
 * Message types consumed:
 *  - `'POSITION_UPDATE'`  → calls updatePosition(position)
 *  - `'SIGNAL_UPDATE'`    → calls updateSignalFeed([signal])
 *  - `'ALERT'`            → calls addToAlertQueue(alert)
 *  - `'ALERT_ACK'`        → calls acknowledgeAlert(alertId) (echo-back)
 *
 * All communication with the CloudEngine is exclusively via WSS (the BSW
 * acts as the single WSS client), satisfying Requirement 1.2 (no plaintext
 * HTTP from the extension).
 */
export function subscribeToPositionUpdates(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    // Not running inside a Chrome extension context (e.g. test environment).
    return;
  }

  chrome.runtime.onMessage.addListener(
    (message: { type: string; payload: unknown }) => {
      switch (message.type) {
        case 'POSITION_UPDATE':
          updatePosition(message.payload as Position);
          break;

        case 'SIGNAL_UPDATE':
          updateSignalFeed([message.payload as Signal]);
          break;

        case 'ALERT':
          addToAlertQueue(message.payload as Alert);
          break;

        case 'ALERT_ACK':
          acknowledgeAlert((message.payload as { alertId: string }).alertId);
          break;

        default:
          // Unrecognised message type — no-op.
          break;
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM rendering
// (All functions are guarded — safe to import in test environments.)
// ─────────────────────────────────────────────────────────────────────────────

/** Formats a number as an Indian-style currency string with sign. */
function formatPnl(pnl: number): string {
  const abs = Math.abs(pnl).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return pnl >= 0 ? `+₹${abs}` : `-₹${abs}`;
}

/** Formats a price value without sign. */
function formatPrice(price: number): string {
  return price.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Renders the positions table body from the current `positions` Map. */
export function renderPositionsTable(): void {
  if (typeof document === 'undefined') return;

  const tbody = document.getElementById('positions-tbody');
  if (!tbody) return;

  if (positions.size === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="positions-empty">No open positions</td></tr>`;
    return;
  }

  tbody.innerHTML = Array.from(positions.values())
    .map((p) => {
      const pnlClass = getPnlColorClass(p.unrealizedPnl);
      const dirClass =
        p.direction === 'LONG' ? 'direction-long' : 'direction-short';
      return `
        <tr data-position-id="${escapeHtml(p.id)}">
          <td>${escapeHtml(p.symbol)}</td>
          <td><span class="direction-badge ${dirClass}">${escapeHtml(p.direction)}</span></td>
          <td>₹${formatPrice(p.entryPrice)}</td>
          <td>₹${formatPrice(p.currentPrice)}</td>
          <td class="${pnlClass}">${formatPnl(p.unrealizedPnl)}</td>
        </tr>`.trim();
    })
    .join('');
}

/** Renders the signal feed list from the current `signalFeed` array. */
export function renderSignalFeed(): void {
  if (typeof document === 'undefined') return;

  const list = document.getElementById('signal-feed-list');
  const countEl = document.getElementById('signal-count');
  if (!list) return;

  if (signalFeed.length === 0) {
    list.innerHTML = `<li class="signal-feed-empty">No signals yet</li>`;
    if (countEl) countEl.textContent = '';
    return;
  }

  if (countEl) {
    countEl.textContent = `(${signalFeed.length}/${MAX_SIGNAL_FEED_SIZE})`;
  }

  list.innerHTML = signalFeed
    .map((s) => {
      const scoreClass = getScoreColorClass(s.score);
      const statusClass = `status-${s.status}`;
      const statusText = getSignalStatusText(s);
      const ts = new Date(s.timestamp).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      return `
        <li class="signal-item" data-signal-id="${escapeHtml(s.id)}">
          <div class="signal-meta">
            <div class="signal-strategy">
              ${escapeHtml(s.strategyCode)}
              <span class="signal-status-badge ${statusClass}">${escapeHtml(s.status)}</span>
            </div>
            <div class="signal-timestamp">${ts}</div>
            ${s.status === 'rejected' ? `<div class="signal-status-text">${escapeHtml(statusText)}</div>` : ''}
          </div>
          <div class="signal-score ${scoreClass}">${s.score}</div>
        </li>`.trim();
    })
    .join('');
}

/** Renders the alert queue from the current `alertQueue` array. */
export function renderAlertQueue(): void {
  if (typeof document === 'undefined') return;

  const list = document.getElementById('alert-queue-list');
  const countEl = document.getElementById('alert-count');
  if (!list) return;

  if (alertQueue.length === 0) {
    list.innerHTML = `<li class="alert-queue-empty">No pending alerts</li>`;
    if (countEl) countEl.textContent = '';
    return;
  }

  if (countEl) {
    countEl.textContent = `(${alertQueue.length})`;
  }

  list.innerHTML = alertQueue
    .map((a) => {
      return `
        <li class="alert-item" data-alert-id="${escapeHtml(a.id)}">
          <div class="alert-header">
            <span class="alert-title">${escapeHtml(a.title)}</span>
            <span class="alert-priority-badge">MAX</span>
          </div>
          <p class="alert-message">${escapeHtml(a.message)}</p>
          <button
            class="alert-ack-btn"
            data-alert-id="${escapeHtml(a.id)}"
            aria-label="Acknowledge alert: ${escapeHtml(a.title)}"
          >
            Acknowledge
          </button>
        </li>`.trim();
    })
    .join('');

  // Wire ACK buttons each time the list is re-rendered.
  list.querySelectorAll<HTMLButtonElement>('.alert-ack-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.alertId;
      if (id) acknowledgeAlert(id);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/** Escapes characters that have special meaning in HTML to prevent XSS. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

/** Entry point invoked when the side panel HTML page loads. */
export function init(): void {
  subscribeToPositionUpdates();
  renderPositionsTable();
  renderSignalFeed();
  renderAlertQueue();
}

// Auto-initialise when running in a real browser page (not in tests).
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
