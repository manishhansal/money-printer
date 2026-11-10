"use strict";
(() => {
  // extension/src/background/background.types.ts
  var INITIAL_STATE = {
    armedState: "DISARMED",
    sessionToken: null,
    connectionState: "disconnected"
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
  var DEFAULT_WSS_URL = "wss://localhost:3000";
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
          connectionState: "disconnected"
          // Fresh WSS connection will be established
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
