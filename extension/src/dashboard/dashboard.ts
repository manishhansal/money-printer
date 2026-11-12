/**
 * dashboard.ts
 *
 * MoneyPrinter Chrome Extension — Full Dashboard
 *
 * Responsibilities (Requirements 1.1, 14.1, 20.6):
 *  - Strategy performance analytics table (win rate, expectancy, net P&L, trades).
 *  - Capital growth chart showing historical capital data points in order.
 *  - Market regime heatmap sorted by signal count descending.
 *  - Options Flow panel with staleness indicator per Requirement 20.7 (data > 60 s old).
 *  - Alert queue consuming all CloudEngine WebSocket push notifications.
 *
 * Architecture note:
 *  State management and rendering helpers are exported as named functions so
 *  unit tests can exercise them without a DOM or Chrome runtime present.
 *  DOM-touching calls are guarded with `typeof document !== 'undefined'`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

export interface PerformanceRow {
  strategyCode: string;
  winRate: number;
  expectancy: number;
  netPnl: number;
  trades: number;
}

export interface RegimeHeatmapEntry {
  regime: string;
  signalCount: number;
}

export interface CapitalDataPoint {
  date: string;
  capital: number;
}

export interface OptionsFlowRow {
  symbol: string;
  netOiChange: number;
  putCallRatio: number;
  ivSkew: number;
  largeBlock: boolean;
  /** True when data is older than 60 seconds (Requirement 20.7). */
  isStale: boolean;
}

export interface AlertItem {
  id: string;
  priority: string;
  title: string;
  message: string;
}

export interface DashboardState {
  strategyPerformance: PerformanceRow[];
  capitalHistory: CapitalDataPoint[];
  regimeHeatmap: RegimeHeatmapEntry[];
  optionsFlow: OptionsFlowRow[];
  alerts: AlertItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// (Exported so unit tests can read and reset state without touching the DOM.)
// ─────────────────────────────────────────────────────────────────────────────

export let strategyPerformance: PerformanceRow[] = [];
export let capitalHistory: CapitalDataPoint[] = [];
export let regimeHeatmap: RegimeHeatmapEntry[] = [];
export let optionsFlow: OptionsFlowRow[] = [];
export let alerts: AlertItem[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// State reset (test helper)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resets all module-level state to empty.
 * Called by unit tests before each case to ensure isolation.
 */
export function resetDashboardState(): void {
  strategyPerformance = [];
  capitalHistory = [];
  regimeHeatmap = [];
  optionsFlow = [];
  alerts = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure business-logic helpers
// (No DOM or Chrome API access — safe to call in any environment.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sorts regime heatmap entries by signalCount descending.
 * Returns a new sorted array; does not mutate the input.
 */
export function sortRegimeHeatmap(entries: RegimeHeatmapEntry[]): RegimeHeatmapEntry[] {
  return [...entries].sort((a, b) => b.signalCount - a.signalCount);
}

/**
 * Returns the CSS class name that marks an Options Flow row as stale.
 * Per Requirement 20.7, data older than 60 seconds is considered stale and
 * the system must display a staleness indicator.
 *
 *  isStale === true  → 'options-flow-stale'
 *  isStale === false → ''
 */
export function getOptionsFlowStaleClass(isStale: boolean): 'options-flow-stale' | '' {
  return isStale ? 'options-flow-stale' : '';
}

/** Formats a number as an Indian-locale currency string with sign prefix. */
function formatCurrency(value: number): string {
  const abs = Math.abs(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value >= 0 ? `+₹${abs}` : `-₹${abs}`;
}

/** Escapes characters that have special meaning in HTML to prevent XSS. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// State management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Appends a notification to the alert queue and re-renders the alert panel.
 * All priorities are accepted (the dashboard surfaces every CloudEngine push).
 */
export function addNotification(alert: AlertItem): void {
  alerts.push(alert);
  renderAlerts();
}

/**
 * Returns the current alert queue.
 * Caller receives a reference to the live array; do not mutate it externally.
 */
export function getAlerts(): AlertItem[] {
  return alerts;
}

/**
 * Processes an incoming WebSocket push notification from the CloudEngine and
 * updates the relevant dashboard panel.
 *
 * Supported message types:
 *  - 'PERFORMANCE_UPDATE'  → replaces strategyPerformance state
 *  - 'CAPITAL_UPDATE'      → replaces capitalHistory state
 *  - 'REGIME_UPDATE'       → replaces and re-sorts regimeHeatmap state
 *  - 'OPTIONS_FLOW_UPDATE' → replaces optionsFlow state
 *  - 'ALERT'               → appends to alerts via addNotification
 *
 * Unknown message types are silently ignored (no-op) to future-proof against
 * new CloudEngine event types.
 */
export function handleWebSocketMessage(msg: { type: string; payload: unknown }): void {
  switch (msg.type) {
    case 'PERFORMANCE_UPDATE':
      strategyPerformance = msg.payload as PerformanceRow[];
      renderPerformanceTable();
      break;

    case 'CAPITAL_UPDATE':
      capitalHistory = msg.payload as CapitalDataPoint[];
      renderCapitalChart();
      break;

    case 'REGIME_UPDATE':
      regimeHeatmap = sortRegimeHeatmap(msg.payload as RegimeHeatmapEntry[]);
      renderRegimeHeatmap();
      break;

    case 'OPTIONS_FLOW_UPDATE':
      optionsFlow = msg.payload as OptionsFlowRow[];
      renderOptionsFlow();
      break;

    case 'ALERT':
      addNotification(msg.payload as AlertItem);
      break;

    default:
      // Unknown type — silently ignored.
      break;
  }
}

/**
 * Renders the full dashboard from the given state snapshot.
 *
 * Updates all module-level state variables then triggers per-panel renders.
 * The regime heatmap is automatically sorted descending by signal count so
 * the highest-activity regime always appears first (Requirement 14.1 —
 * Market Activity Heatmap).
 *
 * This is the primary entry point for initial full-state hydration from the
 * Background Service Worker; incremental updates use handleWebSocketMessage.
 */
export function renderDashboard(state: DashboardState): void {
  strategyPerformance = state.strategyPerformance;
  capitalHistory = state.capitalHistory;
  regimeHeatmap = sortRegimeHeatmap(state.regimeHeatmap);
  optionsFlow = state.optionsFlow;
  alerts = state.alerts;

  renderPerformanceTable();
  renderCapitalChart();
  renderRegimeHeatmap();
  renderOptionsFlow();
  renderAlerts();
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM rendering
// (All functions guard against non-browser environments with an early return.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders the strategy performance analytics table body.
 * Requirement 14.1 — win rate, expectancy, net P&L, and trade count.
 */
function renderPerformanceTable(): void {
  if (typeof document === 'undefined') return;

  const tbody = document.getElementById('performance-tbody');
  if (!tbody) return;

  if (strategyPerformance.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="performance-empty">No performance data</td></tr>`;
    return;
  }

  tbody.innerHTML = strategyPerformance
    .map((row) => {
      const pnlClass = row.netPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
      return `
        <tr data-strategy="${escapeHtml(row.strategyCode)}">
          <td>${escapeHtml(row.strategyCode)}</td>
          <td>${(row.winRate * 100).toFixed(1)}%</td>
          <td>${row.expectancy.toFixed(2)}</td>
          <td class="${pnlClass}">${formatCurrency(row.netPnl)}</td>
          <td>${row.trades}</td>
        </tr>`.trim();
    })
    .join('');
}

/**
 * Renders the capital growth chart.
 * Data points are rendered in the order stored in capitalHistory (chronological
 * order is the caller's responsibility).
 */
function renderCapitalChart(): void {
  if (typeof document === 'undefined') return;

  const container = document.getElementById('capital-chart');
  if (!container) return;

  if (capitalHistory.length === 0) {
    container.innerHTML = `<p class="capital-chart-empty">No capital data available</p>`;
    return;
  }

  container.innerHTML = `<ol class="capital-data-list">
    ${capitalHistory
      .map(
        (pt) =>
          `<li data-date="${escapeHtml(pt.date)}">
             <span class="capital-date">${escapeHtml(pt.date)}</span>
             <span class="capital-value">${formatCurrency(pt.capital)}</span>
           </li>`,
      )
      .join('')}
  </ol>`;
}

/**
 * Renders the market regime heatmap.
 * The regimeHeatmap array is already sorted descending before this is called.
 */
function renderRegimeHeatmap(): void {
  if (typeof document === 'undefined') return;

  const container = document.getElementById('regime-heatmap');
  if (!container) return;

  if (regimeHeatmap.length === 0) {
    container.innerHTML = `<p class="regime-heatmap-empty">No regime data</p>`;
    return;
  }

  container.innerHTML = `<ul class="regime-heatmap-list">
    ${regimeHeatmap
      .map(
        (entry) =>
          `<li class="regime-heatmap-item" data-regime="${escapeHtml(entry.regime)}">
             <span class="regime-name">${escapeHtml(entry.regime)}</span>
             <span class="regime-signal-count">${entry.signalCount}</span>
           </li>`,
      )
      .join('')}
  </ul>`;
}

/**
 * Renders the Options Flow panel (Requirement 20.6).
 * Rows with isStale=true receive the 'options-flow-stale' CSS class and a
 * visible STALE badge, satisfying Requirement 20.7.
 */
function renderOptionsFlow(): void {
  if (typeof document === 'undefined') return;

  const tbody = document.getElementById('options-flow-tbody');
  if (!tbody) return;

  if (optionsFlow.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="options-flow-empty">No options flow data</td></tr>`;
    return;
  }

  tbody.innerHTML = optionsFlow
    .map((row) => {
      const staleClass = getOptionsFlowStaleClass(row.isStale);
      const largeBlockBadge = row.largeBlock
        ? `<span class="large-block-badge" aria-label="Large block trade">BLOCK</span>`
        : '';
      const staleBadge = row.isStale
        ? `<span class="stale-indicator" aria-label="Data is stale">STALE</span>`
        : '';
      return `
        <tr class="${staleClass}" data-symbol="${escapeHtml(row.symbol)}">
          <td>${escapeHtml(row.symbol)}</td>
          <td>${row.netOiChange.toLocaleString('en-IN')}</td>
          <td>${row.putCallRatio.toFixed(2)}</td>
          <td>${row.ivSkew.toFixed(2)}</td>
          <td>${largeBlockBadge}</td>
          <td>${staleBadge}</td>
        </tr>`.trim();
    })
    .join('');
}

/**
 * Renders the alert queue from the current alerts array.
 * Unlike the Side Panel, the dashboard shows alerts of all priority levels.
 */
function renderAlerts(): void {
  if (typeof document === 'undefined') return;

  const list = document.getElementById('alert-queue-list');
  const countEl = document.getElementById('alert-count');
  if (!list) return;

  if (alerts.length === 0) {
    list.innerHTML = `<li class="alert-queue-empty">No pending alerts</li>`;
    if (countEl) countEl.textContent = '';
    return;
  }

  if (countEl) {
    countEl.textContent = `(${alerts.length})`;
  }

  list.innerHTML = alerts
    .map((a) => {
      return `
        <li class="alert-item priority-${escapeHtml(a.priority.toLowerCase())}"
            data-alert-id="${escapeHtml(a.id)}">
          <div class="alert-header">
            <span class="alert-title">${escapeHtml(a.title)}</span>
            <span class="alert-priority-badge">${escapeHtml(a.priority)}</span>
          </div>
          <p class="alert-message">${escapeHtml(a.message)}</p>
        </li>`.trim();
    })
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

/** Entry point invoked when the dashboard HTML page loads. */
export function init(): void {
  renderDashboard({
    strategyPerformance: [],
    capitalHistory: [],
    regimeHeatmap: [],
    optionsFlow: [],
    alerts: [],
  });
}

// Auto-initialise when running in a real browser page (not in tests).
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
