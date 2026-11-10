/**
 * AES-256-GCM TypeORM column transformer.
 *
 * Encrypts plaintext to a base64-encoded payload on the way into the database
 * (`to`) and decrypts it on the way out (`from`).
 *
 * Payload wire format (base64 of):
 *   <iv-hex> : <authTag-hex> : <ciphertext-hex>
 *
 * Key resolution:
 *   The ENCRYPTION_KEY env-var is read lazily so that the transformer can be
 *   imported at module-load time without requiring the env-var at import time.
 *   Accepted formats:
 *     - 64-char hex string  → decoded to 32 bytes
 *     - 44-char base64 string → decoded to 32 bytes
 *     - 32-char UTF-8 string → used directly as 32 bytes
 *
 * Requirements: 16.8 (field-level encryption on ENCRYPTED columns)
 */

import { ValueTransformer } from 'typeorm';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // GCM standard — 96-bit IV
const AUTH_TAG_LENGTH_BYTES = 16; // 128-bit authentication tag

/**
 * Resolve and validate the 32-byte encryption key from the environment.
 * Throws if ENCRYPTION_KEY is absent or cannot be decoded to 32 bytes.
 */
function resolveKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is required for field-level AES-256-GCM encryption. ' +
        'Set a 32-byte key as a 64-char hex string, 44-char base64 string, or 32-char UTF-8 string.',
    );
  }

  // 64-char hex → 32 bytes
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // 44-char base64 → 32 bytes
  if (raw.length === 44) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
  }

  // 32-char UTF-8 → 32 bytes
  if (Buffer.byteLength(raw, 'utf8') === 32) {
    return Buffer.from(raw, 'utf8');
  }

  throw new Error(
    'ENCRYPTION_KEY must resolve to exactly 32 bytes. ' +
      'Provide it as a 64-char hex string, 44-char base64 string, or a 32-byte UTF-8 string.',
  );
}

/**
 * AES-256-GCM TypeORM `ValueTransformer`.
 *
 * Usage in an entity column:
 * ```ts
 * @Column({ type: 'varchar', transformer: encryptedColumnTransformer })
 * apiKey: string;
 * ```
 */
export class EncryptedColumnTransformer implements ValueTransformer {
  /**
   * Encrypt `value` before writing to the database.
   * Returns a base64-encoded payload string, or `null` for null/undefined input.
   */
  to(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    const key = resolveKey();
    const iv = crypto.randomBytes(IV_LENGTH_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });

    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Encode as: base64( ivHex:authTagHex:ciphertextHex )
    const payload = `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
    return Buffer.from(payload, 'utf8').toString('base64');
  }

  /**
   * Decrypt `value` when reading from the database.
   * Returns the plaintext string, or `null` for null/undefined input.
   * Returns `null` and logs a warning if decryption fails (e.g. key rotation).
   */
  from(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    try {
      const key = resolveKey();
      const payload = Buffer.from(value, 'base64').toString('utf8');
      const parts = payload.split(':');

      if (parts.length !== 3) {
        throw new Error(
          `Invalid encrypted payload: expected 3 colon-separated segments, got ${parts.length}`,
        );
      }

      const [ivHex, authTagHex, ciphertextHex] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const ciphertext = Buffer.from(ciphertextHex, 'hex');

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      decipher.setAuthTag(authTag);

      return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
    } catch (err) {
      // Decryption failure is non-fatal at the transformer layer so that a
      // key-rotation scenario does not crash the entire query result.  The
      // caller receives null and must handle it appropriately.
      console.warn(
        '[EncryptedColumnTransformer] Decryption failed — returning null. ' +
          'This may indicate a key mismatch or data corruption.',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
}

/**
 * Pre-instantiated singleton for use in `@Column({ transformer: ... })`.
 * Using a singleton avoids allocating a new object per entity class definition.
 */
export const encryptedColumnTransformer = new EncryptedColumnTransformer();
