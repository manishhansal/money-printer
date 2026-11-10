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
  var DEFAULT_WSS_URL = "wss://localhost:3003";
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
    });
    socket.addEventListener("close", () => {
      if (activeSocket === socket) {
        activeSocket = null;
      }
      updateState({ connectionState: "disconnected" }).catch(() => {
      });
      setTimeout(() => connectWebSocket(url), RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", () => {
      if (activeSocket === socket) {
        activeSocket = null;
      }
      updateState({ connectionState: "disconnected" }).catch(() => {
      });
    });
    return socket;
  }
  function notifyUser(message) {
    try {
      chrome.runtime.sendMessage({ type: "RECOVERY_NOTIFICATION", message });
    } catch {
    }
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
