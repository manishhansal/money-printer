/**
 * Security invariants for the MoneyPrinter Chrome Extension.
 *
 * Requirements: 1.2, 1.6, 16.2
 *
 * Design contract:
 * - Broker credentials, API keys, and Dhan session tokens must NEVER be stored
 *   in extension local storage, content script context, window.postMessage, or
 *   any DOM-accessible location.
 * - Session tokens belong exclusively in chrome.storage.session (BSW-only scope).
 * - All Extension ↔ CloudEngine communication must use WSS or HTTPS — no
 *   plaintext HTTP is permitted under any circumstances.
 */

// Minimal Chrome Storage API type for the extension context.
// The full @types/chrome package is not required here; only the surface we use.
declare const chrome: {
  storage: {
    local: {
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Keys that must NEVER be stored in chrome.storage.local (content-script-accessible).
 * These should only ever live in chrome.storage.session (BSW-only scope).
 */
export const FORBIDDEN_LOCAL_STORAGE_KEYS = [
  'sessionToken',
  'brokerCredentials',
  'apiKey',
  'dhanToken',
  'accessToken',
  'refreshToken',
] as const;

export type ForbiddenKey = (typeof FORBIDDEN_LOCAL_STORAGE_KEYS)[number];

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown whenever a security invariant is violated.
 */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
    // Restore prototype chain for environments that transpile classes to ES5
    Object.setPrototypeOf(this, SecurityError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a storage write would violate the security invariants.
 *
 * @returns The violating key name if `key` is in FORBIDDEN_LOCAL_STORAGE_KEYS,
 *          or `null` if the key is safe to persist in local storage.
 */
export function checkStorageViolation(key: string): string | null {
  if ((FORBIDDEN_LOCAL_STORAGE_KEYS as readonly string[]).includes(key)) {
    return key;
  }
  return null;
}

/**
 * Validate that a URL uses WSS or HTTPS protocol.
 *
 * All Extension ↔ CloudEngine communication must travel over an encrypted
 * channel.  Plain `ws://` and `http://` URLs are rejected unconditionally.
 *
 * @throws {SecurityError} when the URL does not start with `wss://` or `https://`
 */
export function assertSecureUrl(url: string): void {
  if (!url.startsWith('wss://') && !url.startsWith('https://')) {
    throw new SecurityError(
      `Insecure URL rejected: "${url}". Only WSS (wss://) and HTTPS (https://) connections are permitted per security invariant 1.2.`,
    );
  }
}

/**
 * Secure wrapper around chrome.storage.local.set that blocks forbidden keys.
 *
 * Before delegating to the Chrome API, every key in `items` is checked against
 * FORBIDDEN_LOCAL_STORAGE_KEYS.  If any match is found the write is aborted and
 * a SecurityError is thrown — no data is written to storage.
 *
 * @throws {SecurityError} if any key in `items` is in FORBIDDEN_LOCAL_STORAGE_KEYS
 */
export async function secureLocalStorageSet(items: Record<string, unknown>): Promise<void> {
  for (const key of Object.keys(items)) {
    const violation = checkStorageViolation(key);
    if (violation !== null) {
      throw new SecurityError(
        `Security invariant violated: forbidden key "${violation}" must not be stored in chrome.storage.local (content-script-accessible). ` +
          `Use chrome.storage.session for session tokens and credentials.`,
      );
    }
  }

  await chrome.storage.local.set(items);
}
