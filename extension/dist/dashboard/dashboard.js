"use strict";
(() => {
  // extension/src/dashboard/dashboard.ts
  var strategyPerformance = [];
  var capitalHistory = [];
  var regimeHeatmap = [];
  var optionsFlow = [];
  var alerts = [];
  function resetDashboardState() {
    strategyPerformance = [];
    capitalHistory = [];
    regimeHeatmap = [];
    optionsFlow = [];
    alerts = [];
  }
  function sortRegimeHeatmap(entries) {
    return [...entries].sort((a, b) => b.signalCount - a.signalCount);
  }
  function getOptionsFlowStaleClass(isStale) {
    return isStale ? "options-flow-stale" : "";
  }
  function formatCurrency(value) {
    const abs = Math.abs(value).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return value >= 0 ? `+\u20B9${abs}` : `-\u20B9${abs}`;
  }
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function addNotification(alert) {
    alerts.push(alert);
    renderAlerts();
  }
  function getAlerts() {
    return alerts;
  }
  function handleWebSocketMessage(msg) {
    switch (msg.type) {
      case "PERFORMANCE_UPDATE":
        strategyPerformance = msg.payload;
        renderPerformanceTable();
        break;
      case "CAPITAL_UPDATE":
        capitalHistory = msg.payload;
        renderCapitalChart();
        break;
      case "REGIME_UPDATE":
        regimeHeatmap = sortRegimeHeatmap(msg.payload);
        renderRegimeHeatmap();
        break;
      case "OPTIONS_FLOW_UPDATE":
        optionsFlow = msg.payload;
        renderOptionsFlow();
        break;
      case "ALERT":
        addNotification(msg.payload);
        break;
      default:
        break;
    }
  }
  function renderDashboard(state) {
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
  function renderPerformanceTable() {
    if (typeof document === "undefined") return;
    const tbody = document.getElementById("performance-tbody");
    if (!tbody) return;
    if (strategyPerformance.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="performance-empty">No performance data</td></tr>`;
      return;
    }
    tbody.innerHTML = strategyPerformance.map((row) => {
      const pnlClass = row.netPnl >= 0 ? "pnl-positive" : "pnl-negative";
      return `
        <tr data-strategy="${escapeHtml(row.strategyCode)}">
          <td>${escapeHtml(row.strategyCode)}</td>
          <td>${(row.winRate * 100).toFixed(1)}%</td>
          <td>${row.expectancy.toFixed(2)}</td>
          <td class="${pnlClass}">${formatCurrency(row.netPnl)}</td>
          <td>${row.trades}</td>
        </tr>`.trim();
    }).join("");
  }
  function renderCapitalChart() {
    if (typeof document === "undefined") return;
    const container = document.getElementById("capital-chart");
    if (!container) return;
    if (capitalHistory.length === 0) {
      container.innerHTML = `<p class="capital-chart-empty">No capital data available</p>`;
      return;
    }
    container.innerHTML = `<ol class="capital-data-list">
    ${capitalHistory.map(
      (pt) => `<li data-date="${escapeHtml(pt.date)}">
             <span class="capital-date">${escapeHtml(pt.date)}</span>
             <span class="capital-value">${formatCurrency(pt.capital)}</span>
           </li>`
    ).join("")}
  </ol>`;
  }
  function renderRegimeHeatmap() {
    if (typeof document === "undefined") return;
    const container = document.getElementById("regime-heatmap");
    if (!container) return;
    if (regimeHeatmap.length === 0) {
      container.innerHTML = `<p class="regime-heatmap-empty">No regime data</p>`;
      return;
    }
    container.innerHTML = `<ul class="regime-heatmap-list">
    ${regimeHeatmap.map(
      (entry) => `<li class="regime-heatmap-item" data-regime="${escapeHtml(entry.regime)}">
             <span class="regime-name">${escapeHtml(entry.regime)}</span>
             <span class="regime-signal-count">${entry.signalCount}</span>
           </li>`
    ).join("")}
  </ul>`;
  }
  function renderOptionsFlow() {
    if (typeof document === "undefined") return;
    const tbody = document.getElementById("options-flow-tbody");
    if (!tbody) return;
    if (optionsFlow.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="options-flow-empty">No options flow data</td></tr>`;
      return;
    }
    tbody.innerHTML = optionsFlow.map((row) => {
      const staleClass = getOptionsFlowStaleClass(row.isStale);
      const largeBlockBadge = row.largeBlock ? `<span class="large-block-badge" aria-label="Large block trade">BLOCK</span>` : "";
      const staleBadge = row.isStale ? `<span class="stale-indicator" aria-label="Data is stale">STALE</span>` : "";
      return `
        <tr class="${staleClass}" data-symbol="${escapeHtml(row.symbol)}">
          <td>${escapeHtml(row.symbol)}</td>
          <td>${row.netOiChange.toLocaleString("en-IN")}</td>
          <td>${row.putCallRatio.toFixed(2)}</td>
          <td>${row.ivSkew.toFixed(2)}</td>
          <td>${largeBlockBadge}</td>
          <td>${staleBadge}</td>
        </tr>`.trim();
    }).join("");
  }
  function renderAlerts() {
    if (typeof document === "undefined") return;
    const list = document.getElementById("alert-queue-list");
    const countEl = document.getElementById("alert-count");
    if (!list) return;
    if (alerts.length === 0) {
      list.innerHTML = `<li class="alert-queue-empty">No pending alerts</li>`;
      if (countEl) countEl.textContent = "";
      return;
    }
    if (countEl) {
      countEl.textContent = `(${alerts.length})`;
    }
    list.innerHTML = alerts.map((a) => {
      return `
        <li class="alert-item priority-${escapeHtml(a.priority.toLowerCase())}"
            data-alert-id="${escapeHtml(a.id)}">
          <div class="alert-header">
            <span class="alert-title">${escapeHtml(a.title)}</span>
            <span class="alert-priority-badge">${escapeHtml(a.priority)}</span>
          </div>
          <p class="alert-message">${escapeHtml(a.message)}</p>
        </li>`.trim();
    }).join("");
  }
  function init() {
    renderDashboard({
      strategyPerformance: [],
      capitalHistory: [],
      regimeHeatmap: [],
      optionsFlow: [],
      alerts: []
    });
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();
//# sourceMappingURL=dashboard.js.map
