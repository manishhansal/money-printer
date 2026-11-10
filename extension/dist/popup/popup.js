"use strict";
(() => {
  // extension/src/popup/popup.ts
  function formatPnl(pnl) {
    const sign = pnl > 0 ? "+" : pnl < 0 ? "-" : "";
    return `${sign}\u20B9${Math.abs(pnl).toFixed(2)}`;
  }
  function renderState(state) {
    const armedStateLabel = document.getElementById("armed-state-label");
    if (armedStateLabel) {
      armedStateLabel.textContent = state.armedState;
      armedStateLabel.className = "info-value " + armedStateCssClass(state.armedState);
    }
    const activateBtn = document.getElementById("activate-btn");
    if (activateBtn) {
      activateBtn.disabled = state.armedState === "ARMED_PENDING" || state.armedState === "ARMED";
    }
    const confirmBtn = document.getElementById("confirm-btn");
    if (confirmBtn) {
      const isPending = state.armedState === "ARMED_PENDING";
      setVisible(confirmBtn, isPending);
      confirmBtn.disabled = !isPending;
    }
    const disarmBtn = document.getElementById("disarm-btn");
    if (disarmBtn) {
      setVisible(
        disarmBtn,
        state.armedState === "ARMED" || state.armedState === "ARMED_PENDING"
      );
    }
    const healthBadge = document.getElementById("health-badge");
    if (healthBadge) {
      healthBadge.textContent = state.healthStatus;
      healthBadge.className = `badge badge-${state.healthStatus.toLowerCase()}`;
    }
    const sessionPnlEl = document.getElementById("session-pnl");
    if (sessionPnlEl) {
      sessionPnlEl.textContent = formatPnl(state.sessionPnl);
      sessionPnlEl.className = `info-value ${pnlCssClass(state.sessionPnl)}`;
    }
    const positionsCountEl = document.getElementById("active-positions-count");
    if (positionsCountEl) {
      positionsCountEl.textContent = String(state.activePositionsCount);
    }
  }
  function handleActivate() {
    chrome.runtime.sendMessage({ type: "REQUEST_ARM" }, (state) => {
      if (state) renderState(state);
    });
  }
  function handleConfirm() {
    chrome.runtime.sendMessage({ type: "CONFIRM_ARM" }, (state) => {
      if (state) renderState(state);
    });
  }
  function handleDisarm() {
    chrome.runtime.sendMessage({ type: "DISARM" }, (state) => {
      if (state) renderState(state);
    });
  }
  async function initPopup() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
        renderState(state);
        document.getElementById("activate-btn")?.addEventListener("click", handleActivate);
        document.getElementById("confirm-btn")?.addEventListener("click", handleConfirm);
        document.getElementById("disarm-btn")?.addEventListener("click", handleDisarm);
        document.getElementById("sidepanel-btn")?.addEventListener("click", () => {
          chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });
          window.close();
        });
        loadSettings();
        document.getElementById("paper-capital-input")?.addEventListener("input", updateRiskHint);
        document.getElementById("risk-pct-input")?.addEventListener("input", updateRiskHint);
        document.getElementById("save-settings-btn")?.addEventListener("click", saveSettings);
        resolve();
      });
    });
  }
  function armedStateCssClass(armedState) {
    switch (armedState) {
      case "ARMED":
        return "state-armed";
      case "ARMED_PENDING":
        return "state-armed-pending";
      default:
        return "state-disarmed";
    }
  }
  function pnlCssClass(pnl) {
    if (pnl > 0) return "pnl-positive";
    if (pnl < 0) return "pnl-negative";
    return "pnl-neutral";
  }
  function setVisible(el, visible) {
    if (visible) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }
  function loadSettings() {
    fetch("http://localhost:3002/settings").then((r) => r.json()).then((s) => {
      const capitalEl = document.getElementById("paper-capital-input");
      const riskEl = document.getElementById("risk-pct-input");
      if (capitalEl) capitalEl.value = parseFloat(s.paperStartingCapital).toFixed(0);
      if (riskEl) riskEl.value = parseFloat(s.defaultRiskPercentage).toFixed(1);
      updateRiskHint();
    }).catch(() => {
    });
  }
  function updateRiskHint() {
    const capitalEl = document.getElementById("paper-capital-input");
    const riskEl = document.getElementById("risk-pct-input");
    const hintEl = document.getElementById("risk-hint");
    if (!capitalEl || !riskEl || !hintEl) return;
    const capital = parseFloat(capitalEl.value) || 0;
    const riskPct = parseFloat(riskEl.value) || 1;
    const riskPerTrade = (capital * riskPct / 100).toFixed(0);
    const dailyLimit = (capital * 2 / 100).toFixed(0);
    hintEl.textContent = `Risk/trade: \u20B9${riskPerTrade} \xB7 Daily limit: \u20B9${dailyLimit}`;
  }
  function saveSettings() {
    const capitalEl = document.getElementById("paper-capital-input");
    const riskEl = document.getElementById("risk-pct-input");
    const statusEl = document.getElementById("settings-status");
    const saveBtn = document.getElementById("save-settings-btn");
    if (!capitalEl || !riskEl) return;
    const capital = parseFloat(capitalEl.value);
    const riskPct = parseFloat(riskEl.value);
    if (isNaN(capital) || capital < 1e4) {
      if (statusEl) {
        statusEl.style.color = "#f44336";
        statusEl.textContent = "Min capital: \u20B910,000";
      }
      return;
    }
    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) {
      statusEl.style.color = "#9e9e9e";
      statusEl.textContent = "Saving\u2026";
    }
    fetch("http://localhost:3002/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paperStartingCapital: capital.toFixed(2),
        defaultRiskPercentage: riskPct.toFixed(4)
      })
    }).then((r) => {
      if (r.ok) {
        if (statusEl) {
          statusEl.style.color = "#4caf50";
          statusEl.textContent = "\u2713 Saved";
        }
        updateRiskHint();
      } else {
        if (statusEl) {
          statusEl.style.color = "#f44336";
          statusEl.textContent = "Save failed";
        }
      }
    }).catch(() => {
      if (statusEl) {
        statusEl.style.color = "#f44336";
        statusEl.textContent = "Server unreachable";
      }
    }).finally(() => {
      if (saveBtn) saveBtn.disabled = false;
      setTimeout(() => {
        if (statusEl) statusEl.textContent = "";
      }, 3e3);
    });
  }
  if (typeof document !== "undefined" && (typeof process === "undefined" || true)) {
    document.addEventListener("DOMContentLoaded", () => {
      initPopup().catch(console.error);
    });
  }
})();
//# sourceMappingURL=popup.js.map
