/**
 * Jest setup file for the Chrome Extension test suite.
 *
 * Runs BEFORE each test file is loaded (setupFilesAfterEnv), so the global
 * `chrome` and `WebSocket` objects are available when background.ts registers
 * its MV3 event listeners at module-load time.
 */

// ─── Minimal chrome global mock ────────────────────────────────────────────────
// Using simple jest.fn() stubs so each test can inspect and re-configure them.

(global as Record<string, unknown>)['chrome'] = {
  storage: {
    session: {
      set: jest.fn((_, cb?: () => void) => { if (cb) cb(); }),
      get: jest.fn((_, cb: (r: Record<string, unknown>) => void) => cb({})),
      remove: jest.fn((_, cb?: () => void) => { if (cb) cb(); }),
    },
  },
  runtime: {
    lastError: undefined as { message: string } | undefined,
    sendMessage: jest.fn(),
    onInstalled: { addListener: jest.fn() },
    onStartup: { addListener: jest.fn() },
  },
};

// ─── Minimal WebSocket mock ────────────────────────────────────────────────────

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  private _listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  constructor(public readonly url: string) {}

  addEventListener(event: string, listener: (...args: unknown[]) => void): void {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(listener);
  }

  /** Trigger a socket event from tests. */
  emit(event: string, ...args: unknown[]): void {
    (this._listeners[event] ?? []).forEach((l) => l(...args));
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

(global as Record<string, unknown>)['WebSocket'] = MockWebSocket;
