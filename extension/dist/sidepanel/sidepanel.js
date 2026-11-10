"use strict";
(() => {
  // extension/src/sidepanel/sidepanel.ts
  var signalFeed = [];
  var alertQueue = [];
  var positions = /* @__PURE__ */ new Map();
  var MAX_SIGNAL_FEED_SIZE = 10;
  function resetState() {
    signalFeed = [];
    alertQueue = [];
    positions = /* @__PURE__ */ new Map();
  }
  function getPnlColorClass(pnl) {
    return pnl >= 0 ? "pnl-positive" : "pnl-negative";
  }
  function getSignalStatusText(signal) {
    if (signal.status === "rejected" && signal.rejectionReason) {
      return `Rejected: ${signal.rejectionReason}`;
    }
    return signal.status;
  }
  function getScoreColorClass(score) {
    if (score >= 70) return "signal-score-high";
    if (score >= 40) return "signal-score-mid";
    return "signal-score-low";
  }
  function updateSignalFeed(newSignals) {
    const feedMap = new Map(signalFeed.map((s) => [s.id, s]));
    for (const s of newSignals) {
      feedMap.set(s.id, s);
    }
    signalFeed = Array.from(feedMap.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    ).slice(0, MAX_SIGNAL_FEED_SIZE);
    renderSignalFeed();
  }
  function addToAlertQueue(alert) {
    if (alert.priority !== "MAX") {
      return;
    }
    alertQueue.push(alert);
    renderAlertQueue();
  }
  function acknowledgeAlert(alertId) {
    alertQueue = alertQueue.filter((a) => a.id !== alertId);
    renderAlertQueue();
  }
  function updatePosition(position) {
    positions.set(position.id, position);
    renderPositionsTable();
  }
  function subscribeToPositionUpdates() {
    if (typeof chrome === "undefined" || !chrome.runtime) {
      return;
    }
    chrome.runtime.onMessage.addListener(
      (message) => {
        switch (message.type) {
          case "POSITION_UPDATE":
            updatePosition(message.payload);
            break;
          case "SIGNAL_UPDATE":
            updateSignalFeed([message.payload]);
            break;
          case "ALERT":
            addToAlertQueue(message.payload);
            break;
          case "ALERT_ACK":
            acknowledgeAlert(message.payload.alertId);
            break;
          default:
            break;
        }
      }
    );
  }
  function formatPnl(pnl) {
    const abs = Math.abs(pnl).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return pnl >= 0 ? `+\u20B9${abs}` : `-\u20B9${abs}`;
  }
  function formatPrice(price) {
    return price.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
  function renderPositionsTable() {
    if (typeof document === "undefined") return;
    const tbody = document.getElementById("positions-tbody");
    if (!tbody) return;
    if (positions.size === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="positions-empty">No open positions</td></tr>`;
      return;
    }
    tbody.innerHTML = Array.from(positions.values()).map((p) => {
      const pnlClass = getPnlColorClass(p.unrealizedPnl);
      const dirClass = p.direction === "LONG" ? "direction-long" : "direction-short";
      return `
        <tr data-position-id="${escapeHtml(p.id)}">
          <td>${escapeHtml(p.symbol)}</td>
          <td><span class="direction-badge ${dirClass}">${escapeHtml(p.direction)}</span></td>
          <td>\u20B9${formatPrice(p.entryPrice)}</td>
          <td>\u20B9${formatPrice(p.currentPrice)}</td>
          <td class="${pnlClass}">${formatPnl(p.unrealizedPnl)}</td>
        </tr>`.trim();
    }).join("");
  }
  function renderSignalFeed() {
    if (typeof document === "undefined") return;
    const list = document.getElementById("signal-feed-list");
    const countEl = document.getElementById("signal-count");
    if (!list) return;
    if (signalFeed.length === 0) {
      list.innerHTML = `<li class="signal-feed-empty">No signals yet</li>`;
      if (countEl) countEl.textContent = "";
      return;
    }
    if (countEl) {
      countEl.textContent = `(${signalFeed.length}/${MAX_SIGNAL_FEED_SIZE})`;
    }
    list.innerHTML = signalFeed.map((s) => {
      const scoreClass = getScoreColorClass(s.score);
      const statusClass = `status-${s.status}`;
      const statusText = getSignalStatusText(s);
      const ts = new Date(s.timestamp).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
      return `
        <li class="signal-item" data-signal-id="${escapeHtml(s.id)}">
          <div class="signal-meta">
            <div class="signal-strategy">
              ${escapeHtml(s.strategyCode)}
              <span class="signal-status-badge ${statusClass}">${escapeHtml(s.status)}</span>
            </div>
            <div class="signal-timestamp">${ts}</div>
            ${s.status === "rejected" ? `<div class="signal-status-text">${escapeHtml(statusText)}</div>` : ""}
          </div>
          <div class="signal-score ${scoreClass}">${s.score}</div>
        </li>`.trim();
    }).join("");
  }
  function renderAlertQueue() {
    if (typeof document === "undefined") return;
    const list = document.getElementById("alert-queue-list");
    const countEl = document.getElementById("alert-count");
    if (!list) return;
    if (alertQueue.length === 0) {
      list.innerHTML = `<li class="alert-queue-empty">No pending alerts</li>`;
      if (countEl) countEl.textContent = "";
      return;
    }
    if (countEl) {
      countEl.textContent = `(${alertQueue.length})`;
    }
    list.innerHTML = alertQueue.map((a) => {
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
    }).join("");
    list.querySelectorAll(".alert-ack-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.alertId;
        if (id) acknowledgeAlert(id);
      });
    });
  }
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function init() {
    subscribeToPositionUpdates();
    renderPositionsTable();
    renderSignalFeed();
    renderAlertQueue();
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();
//# sourceMappingURL=sidepanel.js.map
