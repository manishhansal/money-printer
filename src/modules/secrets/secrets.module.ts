import { Global, Module } from '@nestjs/common';
import { SecretsService } from './secrets.service';

/**
 * SecretsModule — NestJS global module providing `SecretsService` to all
 * modules in the application without requiring explicit imports.
 *
 * Backend selection at startup (via `SECRETS_BACKEND` env var):
 *  - `env`   — process.env look-up; default for development and test.
 *  - `aws`   — AWS Secrets Manager via @aws-sdk/client-secrets-manager.
 *  - `vault` — HashiCorp Vault KV v2 via HTTP API.
 *
 * Security invariants (Requirements 16.1, 16.2, 3.3):
 *  - No secret value appears in application logs, error messages, or API responses.
 *  - The module exports `SecretsService` globally so it is available to the
 *    AuthModule, DhanApiClient, and any other module that stores or retrieves
 *    credentials without each needing to re-import this module.
 */
@Global()
@Module({
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
