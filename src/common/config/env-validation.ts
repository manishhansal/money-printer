/**
 * env-validation.ts
 *
 * Validates required environment variables at startup. Called from main.ts
 * before the NestJS app is created so that mis-configurations fail fast
 * with a clear diagnostic message rather than a cryptic runtime error.
 *
 * Required vars fall into two categories:
 *  - CRITICAL: absence causes immediate process.exit(1)
 *  - WARNED:   absence logs a WARNING but lets the app continue (useful for
 *              optional features such as DHAN_SESSION_TOKEN in paper-only mode)
 *
 * Requirements: Phase 10 — Production Hardening (startup validation)
 */

import { Logger } from '@nestjs/common';

const logger = new Logger('EnvValidation');

/** Environment variables that MUST be present for the app to function. */
const CRITICAL_VARS: { key: string; description: string }[] = [
  { key: 'DATABASE_URL', description: 'PostgreSQL connection string' },
  { key: 'REDIS_HOST', description: 'Redis hostname (or use REDIS_URL)' },
  { key: 'ENCRYPTION_KEY', description: '32-byte AES-256 key for EncryptedColumn' },
  { key: 'JWT_PRIVATE_KEY', description: 'RS256 private key for JWT signing' },
];

/**
 * Environment variables for live trading. Absence is warned (paper-only mode
 * is a valid configuration without these).
 */
const LIVE_TRADING_VARS: { key: string; description: string }[] = [
  { key: 'DHAN_SESSION_TOKEN', description: '24h Dhan session token for live orders' },
  { key: 'DHAN_CLIENT_ID', description: 'Dhan platform client ID' },
];

/**
 * Validates required environment variables.
 *
 * @param strict When true (default in production), exits on any CRITICAL var
 *               missing. When false (test environments), only warns.
 */
export function validateEnv(strict = true): void {
  const missing: string[] = [];

  for (const { key, description } of CRITICAL_VARS) {
    const value = process.env[key];
    if (!value || value.trim() === '') {
      missing.push(`  ❌ ${key}: ${description}`);
    }
  }

  // Handle the REDIS_HOST / REDIS_URL alternative.
  const hasRedis =
    (process.env.REDIS_HOST && process.env.REDIS_HOST.trim() !== '') ||
    (process.env.REDIS_URL && process.env.REDIS_URL.trim() !== '');
  if (!hasRedis) {
    missing.push('  ❌ REDIS_HOST or REDIS_URL: Redis connection target');
  }

  // Remove the base REDIS_HOST check if REDIS_URL is present (alternative form).
  const redisHostIdx = missing.findIndex((l) => l.includes('REDIS_HOST'));
  if (redisHostIdx !== -1 && process.env.REDIS_URL?.trim()) {
    missing.splice(redisHostIdx, 1);
  }

  if (missing.length > 0) {
    logger.error('='.repeat(60));
    logger.error('STARTUP FAILED: Required environment variables are missing:');
    logger.error('='.repeat(60));
    for (const msg of missing) logger.error(msg);
    logger.error('');
    logger.error('Copy .env.example to .env and fill in the required values.');
    logger.error('='.repeat(60));

    if (strict && process.env.NODE_ENV !== 'test') {
      process.exit(1);
    }
  } else {
    logger.log('✓ All required environment variables are present');
  }

  // Warn about live-trading vars (non-fatal).
  for (const { key, description } of LIVE_TRADING_VARS) {
    if (!process.env[key] || process.env[key]!.trim() === '') {
      logger.warn(`⚠ ${key} not set — ${description}. Live trading will be unavailable.`);
    }
  }

  // Warn if DAILY_LOSS_LIMIT_RUPEES is not set (defaults apply, but explicit config is safer).
  if (!process.env.DAILY_LOSS_LIMIT_RUPEES) {
    logger.warn(
      '⚠ DAILY_LOSS_LIMIT_RUPEES not set — DailyLossStateMachine will use the default limit.',
    );
  }
}
