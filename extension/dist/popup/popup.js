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
  if (typeof document !== "undefined" && (typeof process === "undefined" || true)) {
    document.addEventListener("DOMContentLoaded", () => {
      initPopup().catch(console.error);
    });
  }
})();
//# sourceMappingURL=popup.js.map
