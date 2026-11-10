/**
 * Unit tests for Extension security invariants.
 *
 * Requirements validated: 1.2, 1.6, 16.2
 *
 * Coverage:
 *  1. checkStorageViolation returns key name for a forbidden key ('sessionToken')
 *  2. checkStorageViolation returns null for a safe key
 *  3. assertSecureUrl accepts 'wss://' prefix
 *  4. assertSecureUrl accepts 'https://' prefix
 *  5. assertSecureUrl throws for 'ws://' (insecure WebSocket)
 *  6. assertSecureUrl throws for 'http://' (insecure HTTP)
 *  7. secureLocalStorageSet blocks 'sessionToken' and never calls chrome.storage.local.set
 *  8. secureLocalStorageSet allows safe keys and delegates to chrome.storage.local.set
 */

import {
  checkStorageViolation,
  assertSecureUrl,
  secureLocalStorageSet,
  SecurityError,
} from './security-invariants';

// ---------------------------------------------------------------------------
// Mock chrome.storage.local for the Node.js test environment.
// The chrome global is not available outside extension contexts; we install a
// minimal stub before each test so the module code that calls
// chrome.storage.local.set() resolves correctly.
// ---------------------------------------------------------------------------
const mockStorageLocalSet = jest.fn<Promise<void>, [Record<string, unknown>]>();

beforeEach(() => {
  mockStorageLocalSet.mockReset();
  mockStorageLocalSet.mockResolvedValue(undefined);

  // Install the stub on the global object so the runtime chrome reference in
  // security-invariants.ts resolves to this mock.
  (global as unknown as Record<string, unknown>).chrome = {
    storage: {
      local: {
        set: mockStorageLocalSet,
      },
    },
  };
});

// ---------------------------------------------------------------------------
// checkStorageViolation
// ---------------------------------------------------------------------------

describe('checkStorageViolation', () => {
  test('returns the key name for the forbidden key "sessionToken"', () => {
    const result = checkStorageViolation('sessionToken');
    expect(result).toBe('sessionToken');
  });

  test('returns null for a safe (non-forbidden) key', () => {
    const result = checkStorageViolation('theme');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assertSecureUrl
// ---------------------------------------------------------------------------

describe('assertSecureUrl', () => {
  test('accepts a URL with the "wss://" prefix (secure WebSocket)', () => {
    expect(() => assertSecureUrl('wss://cloudengine.example.com/ws')).not.toThrow();
  });

  test('accepts a URL with the "https://" prefix (secure HTTP)', () => {
    expect(() => assertSecureUrl('https://cloudengine.example.com/api')).not.toThrow();
  });

  test('throws SecurityError for a URL with the "ws://" prefix (insecure WebSocket)', () => {
    expect(() => assertSecureUrl('ws://cloudengine.example.com/ws')).toThrow(SecurityError);
  });

  test('throws SecurityError for a URL with the "http://" prefix (insecure HTTP)', () => {
    expect(() => assertSecureUrl('http://cloudengine.example.com/api')).toThrow(SecurityError);
  });
});

// ---------------------------------------------------------------------------
// secureLocalStorageSet
// ---------------------------------------------------------------------------

describe('secureLocalStorageSet', () => {
  test('throws SecurityError for the forbidden key "sessionToken" and never writes to storage', async () => {
    await expect(secureLocalStorageSet({ sessionToken: 'tok_abc123' })).rejects.toThrow(
      SecurityError,
    );
    // The underlying chrome API must not be called — the invariant must abort
    // before any data reaches local storage.
    expect(mockStorageLocalSet).not.toHaveBeenCalled();
  });

  test('allows safe keys and delegates the write to chrome.storage.local.set', async () => {
    const safeItems = { theme: 'dark', language: 'en', notificationsEnabled: true };

    await expect(secureLocalStorageSet(safeItems)).resolves.toBeUndefined();

    expect(mockStorageLocalSet).toHaveBeenCalledTimes(1);
    expect(mockStorageLocalSet).toHaveBeenCalledWith(safeItems);
  });
});
