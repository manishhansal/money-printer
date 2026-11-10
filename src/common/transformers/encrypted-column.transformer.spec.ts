/**
 * Unit tests for EncryptedColumnTransformer (AES-256-GCM).
 *
 * Covers:
 *  - to()   encrypts and returns a non-empty base64 string
 *  - to()   returns null for null/undefined input
 *  - from() decrypts back to the original value (round-trip)
 *  - from() returns null for null/undefined input
 *  - Two to() calls for the same value produce different ciphertext (random IV)
 *  - from() returns null gracefully when decryption fails (key mismatch)
 *  - Key accepts 64-char hex format
 *  - Key accepts 32-char UTF-8 format
 *
 * Requirements: 16.8 (field-level AES-256-GCM encryption on ENCRYPTED columns)
 */

import * as fc from 'fast-check';
import {
  EncryptedColumnTransformer,
  encryptedColumnTransformer,
} from './encrypted-column.transformer';

// ─── Constants ────────────────────────────────────────────────────────────────

/** A valid 32-byte key encoded as a 64-character hex string. */
const HEX_KEY_64 = 'a'.repeat(64); // 0xaaaa...aa — valid 32-byte hex
/** A valid 32-character UTF-8 key (32 ASCII chars = 32 bytes). */
const UTF8_KEY_32 = '12345678901234567890123456789012'; // exactly 32 chars

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true iff the string is a valid base64-encoded value. */
function isBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]+=*$/.test(s) && s.length > 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EncryptedColumnTransformer', () => {
  let transformer: EncryptedColumnTransformer;

  beforeEach(() => {
    // Use the 64-char hex key as the default for all tests.
    process.env.ENCRYPTION_KEY = HEX_KEY_64;
    transformer = new EncryptedColumnTransformer();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  // ── to() — null / undefined passthrough ─────────────────────────────────

  describe('to() null/undefined passthrough', () => {
    it('returns null when given null', () => {
      expect(transformer.to(null)).toBeNull();
    });

    it('returns null when given undefined', () => {
      expect(transformer.to(undefined)).toBeNull();
    });
  });

  // ── to() — encrypts a string ─────────────────────────────────────────────

  describe('to() encryption', () => {
    it('returns a non-empty base64 string for a non-empty input', () => {
      const result = transformer.to('secret-api-key');
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
      expect(isBase64(result as string)).toBe(true);
    });

    it('returns a non-empty base64 string for an empty-string input', () => {
      const result = transformer.to('');
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
      expect(isBase64(result as string)).toBe(true);
    });

    it('produces different ciphertext on two calls with the same plaintext (random IV)', () => {
      const plaintext = 'same-value-every-time';
      const first = transformer.to(plaintext);
      const second = transformer.to(plaintext);
      // Both must be valid ciphertext but never equal (random IV guarantees this).
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first).not.toBe(second);
    });
  });

  // ── from() — null / undefined passthrough ────────────────────────────────

  describe('from() null/undefined passthrough', () => {
    it('returns null when given null', () => {
      expect(transformer.from(null)).toBeNull();
    });

    it('returns null when given undefined', () => {
      expect(transformer.from(undefined)).toBeNull();
    });
  });

  // ── Round-trip ───────────────────────────────────────────────────────────

  describe('round-trip: to() → from()', () => {
    it('decrypts ciphertext back to the original plaintext', () => {
      const original = 'super-secret-session-token';
      const encrypted = transformer.to(original);
      expect(encrypted).not.toBeNull();
      const decrypted = transformer.from(encrypted!);
      expect(decrypted).toBe(original);
    });

    it('round-trips an empty string', () => {
      const encrypted = transformer.to('');
      const decrypted = transformer.from(encrypted!);
      expect(decrypted).toBe('');
    });

    it('round-trips a string with special characters and unicode', () => {
      const original = '日本語テスト — €£¥ — emoji: 🔑';
      const encrypted = transformer.to(original);
      const decrypted = transformer.from(encrypted!);
      expect(decrypted).toBe(original);
    });
  });

  // ── from() — graceful failure on bad ciphertext / key mismatch ──────────

  describe('from() graceful decryption failure', () => {
    it('returns null when given an invalid base64 blob (corrupt ciphertext)', () => {
      // Suppress the expected console.warn so test output stays clean.
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = transformer.from('this-is-not-a-valid-ciphertext-blob');
      expect(result).toBeNull();
      warnSpy.mockRestore();
    });

    it('returns null when decryption fails due to key mismatch (simulated key rotation)', () => {
      // Encrypt with the original key.
      const encrypted = transformer.to('sensitive-data');
      expect(encrypted).not.toBeNull();

      // Switch to a different key — decryption should fail gracefully.
      process.env.ENCRYPTION_KEY = 'b'.repeat(64);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = transformer.from(encrypted!);
      expect(result).toBeNull();
      warnSpy.mockRestore();
    });

    it('logs a warning on decryption failure', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      transformer.from('not-a-valid-payload');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ── Key format acceptance ────────────────────────────────────────────────

  describe('key format acceptance', () => {
    it('accepts a 64-char hex key', () => {
      process.env.ENCRYPTION_KEY = HEX_KEY_64;
      const result = transformer.to('test-value');
      expect(result).not.toBeNull();
      expect(isBase64(result as string)).toBe(true);
    });

    it('accepts a 32-char UTF-8 key', () => {
      process.env.ENCRYPTION_KEY = UTF8_KEY_32;
      const result = transformer.to('test-value');
      expect(result).not.toBeNull();
      expect(isBase64(result as string)).toBe(true);
    });

    it('round-trips correctly with a 32-char UTF-8 key', () => {
      process.env.ENCRYPTION_KEY = UTF8_KEY_32;
      const original = 'access-token-abc123';
      const encrypted = transformer.to(original);
      const decrypted = transformer.from(encrypted!);
      expect(decrypted).toBe(original);
    });

    it('throws when ENCRYPTION_KEY is absent', () => {
      delete process.env.ENCRYPTION_KEY;
      expect(() => transformer.to('anything')).toThrow('ENCRYPTION_KEY');
    });

    it('throws when ENCRYPTION_KEY has an unsupported length/format', () => {
      process.env.ENCRYPTION_KEY = 'too-short';
      expect(() => transformer.to('anything')).toThrow('ENCRYPTION_KEY');
    });
  });

  // ── Singleton export ─────────────────────────────────────────────────────

  describe('encryptedColumnTransformer singleton', () => {
    it('is an instance of EncryptedColumnTransformer', () => {
      expect(encryptedColumnTransformer).toBeInstanceOf(EncryptedColumnTransformer);
    });

    it('behaves identically to a fresh instance', () => {
      process.env.ENCRYPTION_KEY = HEX_KEY_64;
      const original = 'singleton-test';
      const encrypted = encryptedColumnTransformer.to(original);
      expect(encryptedColumnTransformer.from(encrypted!)).toBe(original);
    });
  });

  // ── Property-based tests ─────────────────────────────────────────────────
  // **Validates: Requirements 16.8**

  describe('property: round-trip holds for arbitrary strings', () => {
    it('always decrypts back to the original value for any non-empty ASCII string', () => {
      process.env.ENCRYPTION_KEY = HEX_KEY_64;
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 512 }), (plaintext) => {
          const encrypted = transformer.to(plaintext);
          const decrypted = transformer.from(encrypted!);
          return decrypted === plaintext;
        }),
      );
    });

    it('always produces different ciphertext for the same plaintext (random IV)', () => {
      process.env.ENCRYPTION_KEY = HEX_KEY_64;
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 128 }), (plaintext) => {
          const first = transformer.to(plaintext);
          const second = transformer.to(plaintext);
          return first !== second;
        }),
      );
    });

    it('always returns null for null input regardless of the key', () => {
      process.env.ENCRYPTION_KEY = HEX_KEY_64;
      fc.assert(
        fc.property(fc.constant(null), (value) => {
          return transformer.to(value) === null && transformer.from(value) === null;
        }),
      );
    });
  });
});
