import { ExtensionState } from './background.types';

const STORAGE_KEY = 'extensionState';

/**
 * Persist the current ExtensionState to chrome.storage.session.
 * chrome.storage.session is ephemeral (cleared on browser-session end) and
 * is NOT accessible to content scripts, satisfying Requirement 1.6.
 */
export function saveState(state: ExtensionState): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.storage.session.set({ [STORAGE_KEY]: state }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Load the previously persisted ExtensionState from chrome.storage.session.
 * Returns null when no state has been stored yet (fresh install or session cleared).
 */
export function loadState(): Promise<ExtensionState | null> {
  return new Promise<ExtensionState | null>((resolve, reject) => {
    chrome.storage.session.get([STORAGE_KEY], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        const stored = result[STORAGE_KEY];
        resolve(stored ? (stored as ExtensionState) : null);
      }
    });
  });
}

/**
 * Remove the persisted ExtensionState from chrome.storage.session.
 * Useful during logout or factory-reset scenarios.
 */
export function clearState(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.storage.session.remove(STORAGE_KEY, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}
