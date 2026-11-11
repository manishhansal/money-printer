"use strict";
(() => {
  // extension/src/background/background.types.ts
  var INITIAL_STATE = {
    armedState: "DISARMED",
    sessionToken: null,
    connectionState: "disconnected",
    sessionPnl: 0,
    activePositionsCount: 0,
    healthStatus: "Healthy"
  };

  // extension/src/background/state.manager.ts
  var STORAGE_KEY = "extensionState";
  function saveState(state) {
    return new Promise((resolve, reject) => {
      chrome.storage.session.set({ [STORAGE_KEY]: state }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }
  function loadState() {
    return new Promise((resolve, reject) => {
      chrome.storage.session.get([STORAGE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          const stored = result[STORAGE_KEY];
          resolve(stored ? stored : null);
        }
      });
    });
  }

  // extension/src/background/background.ts
  var DEFAULT_WSS_URL = "ws://localhost:3003";
  var DEFAULT_HTTP_URL = "http://localhost:3002";
  var RECOVERY_TIMEOUT_MS = 5e3;
  var RECONNECT_DELAY_MS = 3e3;
  var TIMEOUT_SENTINEL = /* @__PURE__ */ Symbol("RECOVERY_TIMEOUT");
  var currentState = { ...INITIAL_STATE };
  var activeSocket = null;
  function getCurrentState() {
    return { ...currentState };
  }
  async function updateState(updates) {
    currentState = { ...currentState, ...updates };
    await saveState(currentState);
  }
  async function recoverState(timeoutMs = RECOVERY_TIMEOUT_MS) {
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });
    try {
      const result = await Promise.race([loadState(), timeoutPromise]);
      if (result === TIMEOUT_SENTINEL) {
        currentState = { ...INITIAL_STATE };
        await saveState(currentState);
        notifyUser("Manual re-authorization required");
        return;
      }
      if (result !== null) {
        currentState = {
          armedState: "DISARMED",
          // Never auto-re-arm
          sessionToken: result.sessionToken,
          // Preserved for re-authentication
          connectionState: "disconnected",
          // Fresh WSS connection will be established
          sessionPnl: 0,
          activePositionsCount: 0,
          healthStatus: "Healthy"
        };
      } else {
        currentState = { ...INITIAL_STATE };
      }
      await saveState(currentState);
    } catch {
      currentState = { ...INITIAL_STATE };
      await saveState(currentState);
      notifyUser("Manual re-authorization required");
    }
  }
  function connectWebSocket(url = DEFAULT_WSS_URL) {
    if (activeSocket && (activeSocket.readyState === WebSocket.OPEN || activeSocket.readyState === WebSocket.CONNECTING)) {
      return activeSocket;
    }
    updateState({ connectionState: "connecting" }).catch(() => {
    });
    const socket = new WebSocket(url);
    activeSocket = socket;
    socket.addEventListener("open", () => {
      updateState({ connectionState: "connected" }).catch(() => {
      });
      startSignalPolling();
    });
    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.event === "notification") {
          const alert = msg.data;
          chrome.runtime.sendMessage({ type: "ALERT", payload: alert }, () => {
            void chrome.runtime.lastError;
          });
        }
      } catch {
      }
    });
    socket.addEventListener("close", () => {
      if (activeSocket === socket) {
        activeSocket = null;
      }
      updateState({ connectionState: "disconnected" }).catch(() => {
      });
      stopSignalPolling();
      setTimeout(() => connectWebSocket(url), RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", () => {
      if (activeSocket === socket) {
        activeSocket = null;
      }
      updateState({ connectionState: "disconnected" }).catch(() => {
      });
      stopSignalPolling();
    });
    return socket;
  }
  function notifyUser(message) {
    chrome.runtime.sendMessage({ type: "RECOVERY_NOTIFICATION", message }, () => {
      void chrome.runtime.lastError;
    });
  }
  function _resetStateForTesting() {
    currentState = { ...INITIAL_STATE };
    activeSocket = null;
  }
  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
      if (message.type === "GET_STATE") {
        fetchSessionPnl().then((pnl) => {
          sendResponse({ ...currentState, ...pnl });
        }).catch(() => {
          sendResponse({
            ...currentState,
            sessionPnl: 0,
            activePositionsCount: 0,
            healthStatus: "Down"
          });
        });
        return true;
      }
      if (message.type === "REQUEST_ARM") {
        updateState({ armedState: "ARMED_PENDING" }).then(() => sendResponse({ ...currentState })).catch(() => sendResponse({ ...currentState }));
        return true;
      }
      if (message.type === "CONFIRM_ARM") {
        updateState({ armedState: "ARMED" }).then(() => sendResponse({ ...currentState })).catch(() => sendResponse({ ...currentState }));
        return true;
      }
      if (message.type === "DISARM") {
        updateState({ armedState: "DISARMED" }).then(() => sendResponse({ ...currentState })).catch(() => sendResponse({ ...currentState }));
        return true;
      }
      if (message.type === "OPEN_SIDE_PANEL") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.windowId) {
            chrome.sidePanel.open({ windowId: tabs[0].windowId }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
          } else {
            sendResponse({ ok: false });
          }
        });
        return true;
      }
    }
  );
  async function fetchSessionPnl() {
    const token = currentState.sessionToken;
    const baseUrl = DEFAULT_HTTP_URL;
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}/portfolio/summary`, { headers });
    if (!res.ok) {
      return { sessionPnl: 0, activePositionsCount: 0, healthStatus: "Degraded" };
    }
    const data = await res.json();
    const isLive = currentState.armedState === "ARMED";
    const netPnl = isLive ? data.live?.netPnl ?? 0 : data.paper?.netPnl ?? 0;
    return {
      sessionPnl: netPnl,
      activePositionsCount: 0,
      // Extended in future via /portfolio/positions
      healthStatus: "Healthy"
    };
  }
  async function fetchAndBroadcastPositions() {
    try {
      const res = await fetch(`${DEFAULT_HTTP_URL}/paper-trading/positions`);
      if (!res.ok) return;
      const positions = await res.json();
      for (const p of positions) {
        const entryPrice = parseFloat(p.average_entry_price);
        const unrealized = parseFloat(p.unrealized_pnl);
        const currentPrice = unrealized !== 0 ? entryPrice + unrealized / p.quantity : entryPrice;
        const payload = {
          id: p.id,
          symbol: p.instrument_id.slice(0, 8),
          // short display until symbol lookup added
          entryPrice,
          currentPrice,
          unrealizedPnl: unrealized,
          direction: p.direction
        };
        chrome.runtime.sendMessage({ type: "POSITION_UPDATE", payload }, () => {
          void chrome.runtime.lastError;
        });
      }
    } catch {
    }
  }
  async function fetchAndBroadcastSignals() {
    try {
      const res = await fetch(`${DEFAULT_HTTP_URL}/signals/ranked`);
      if (!res.ok) return;
      const ranked = await res.json();
      for (const item of ranked) {
        const sig = item.signal;
        const payload = {
          id: sig.id,
          strategyCode: sig.strategy?.code ?? "N/A",
          score: Math.round(parseFloat(sig.compositeScore)),
          status: sig.status,
          timestamp: new Date(sig.signalTimestamp),
          rejectionReason: sig.rejectionReason ?? void 0
        };
        chrome.runtime.sendMessage({ type: "SIGNAL_UPDATE", payload }, () => {
          void chrome.runtime.lastError;
        });
      }
    } catch {
    }
  }
  var signalPollInterval = null;
  function startSignalPolling() {
    if (signalPollInterval !== null) return;
    void fetchAndBroadcastSignals();
    void fetchAndBroadcastPositions();
    signalPollInterval = setInterval(() => {
      void fetchAndBroadcastSignals();
      void fetchAndBroadcastPositions();
    }, 15e3);
  }
  function stopSignalPolling() {
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
})();
//# sourceMappingURL=background.js.map
