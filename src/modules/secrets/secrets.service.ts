import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  UpdateSecretCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported backend identifiers. */
export type SecretsBackend = 'env' | 'aws' | 'vault';

/** Structured audit record for a rotate operation (never contains secret values). */
export interface RotateAuditRecord {
  key: string;
  backend: SecretsBackend;
  rotatedAt: string; // ISO-8601 UTC
  outcome: 'success' | 'failure';
}

// ---------------------------------------------------------------------------
// Helper — redact a value for safe logging
// ---------------------------------------------------------------------------

/**
 * Returns a fixed placeholder string. Secret values are NEVER included in logs.
 * Only the key name and operation outcome are logged.
 *
 * Requirements: 16.1, 16.2
 */
function redact(_value: string): string {
  return '[REDACTED]';
}

// ---------------------------------------------------------------------------
// SecretsService
// ---------------------------------------------------------------------------

/**
 * SecretsService
 *
 * A unified interface for secret retrieval, storage, and rotation across three
 * backend implementations selected by the `SECRETS_BACKEND` environment variable:
 *
 *  - `env`   (default) — process.env look-up; suitable for development/test.
 *  - `aws`             — AWS Secrets Manager via @aws-sdk/client-secrets-manager.
 *  - `vault`           — HashiCorp Vault KV v2 via HTTP API.
 *
 * Security invariants (Requirements 16.1, 16.2, 3.3):
 *  1. Secret VALUES are NEVER written to application logs — only key names and
 *     operation outcomes are logged.
 *  2. Error messages thrown by this service contain only the key name and a
 *     generic description; the secret value is never included.
 *  3. Callers must not expose the return value of `get()` in API responses or
 *     logs; the service itself ensures its own log calls are safe.
 */
@Injectable()
export class SecretsService implements OnModuleInit {
  private readonly logger = new Logger(SecretsService.name);
  private readonly backend: SecretsBackend;

  // AWS backend client — initialised lazily when backend === 'aws'
  private awsClient?: SecretsManagerClient;

  // Vault backend config
  private vaultAddr?: string;
  private vaultToken?: string;

  constructor(private readonly config: ConfigService) {
    const raw = this.config.get<string>('SECRETS_BACKEND', 'env').toLowerCase();
    if (raw === 'aws' || raw === 'vault' || raw === 'env') {
      this.backend = raw as SecretsBackend;
    } else {
      this.logger.warn(`Unknown SECRETS_BACKEND "${raw}"; falling back to "env".`);
      this.backend = 'env';
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    this.logger.log(`SecretsService initialised with backend: ${this.backend}`);

    if (this.backend === 'aws') {
      this.awsClient = new SecretsManagerClient({
        region: this.config.getOrThrow<string>('AWS_REGION'),
        credentials: this.config.get<string>('AWS_ACCESS_KEY_ID')
          ? {
              accessKeyId: this.config.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
              secretAccessKey: this.config.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
            }
          : undefined, // fall back to SDK's default credential chain (IAM role, etc.)
      });
      this.logger.log('AWS Secrets Manager client created');
    }

    if (this.backend === 'vault') {
      this.vaultAddr = this.config.getOrThrow<string>('VAULT_ADDR');
      this.vaultToken = this.config.getOrThrow<string>('VAULT_TOKEN');
      this.logger.log(`HashiCorp Vault client configured (addr: ${this.vaultAddr})`);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a secret by key.
   *
   * Logs only the key name and result outcome — never the value.
   *
   * @param key  Logical secret identifier.
   * @returns    The secret value as a plain string.
   * @throws     Error with key name and failure reason; no value in message.
   */
  async get(key: string): Promise<string> {
    this.logger.debug(`get: key="${key}" backend=${this.backend}`);

    let value: string;
    try {
      switch (this.backend) {
        case 'env':
          value = this.envGet(key);
          break;
        case 'aws':
          value = await this.awsGet(key);
          break;
        case 'vault':
          value = await this.vaultGet(key);
          break;
      }
    } catch (err) {
      // Re-throw without leaking the value; only record the key.
      const safeMessage = `SecretsService.get failed for key="${key}": ${(err as Error).message}`;
      this.logger.error(safeMessage);
      throw new Error(safeMessage);
    }

    // Log outcome using redaction — value itself is never logged.
    this.logger.debug(`get: key="${key}" result=${redact(value)} backend=${this.backend}`);
    return value;
  }

  /**
   * Store or update a secret.
   *
   * The value is never logged; only the key name and success/failure outcome.
   *
   * @param key    Logical secret identifier.
   * @param value  Secret value to store.
   */
  async set(key: string, value: string): Promise<void> {
    this.logger.debug(`set: key="${key}" backend=${this.backend}`);

    try {
      switch (this.backend) {
        case 'env':
          this.envSet(key, value);
          break;
        case 'aws':
          await this.awsSet(key, value);
          break;
        case 'vault':
          await this.vaultSet(key, value);
          break;
      }
    } catch (err) {
      const safeMessage = `SecretsService.set failed for key="${key}": ${(err as Error).message}`;
      this.logger.error(safeMessage);
      throw new Error(safeMessage);
    }

    this.logger.log(`set: key="${key}" stored successfully backend=${this.backend}`);
  }

  /**
   * Atomically rotate a secret: update the stored value and emit an audit record.
   *
   * The audit record contains only the key name, backend, timestamp, and
   * outcome — the new value is never included.
   *
   * @param key       Logical secret identifier.
   * @param newValue  Replacement secret value.
   */
  async rotate(key: string, newValue: string): Promise<void> {
    this.logger.debug(`rotate: key="${key}" backend=${this.backend}`);

    const audit: RotateAuditRecord = {
      key,
      backend: this.backend,
      rotatedAt: new Date().toISOString(),
      outcome: 'failure',
    };

    try {
      switch (this.backend) {
        case 'env':
          this.envSet(key, newValue);
          break;
        case 'aws':
          await this.awsSet(key, newValue);
          break;
        case 'vault':
          await this.vaultSet(key, newValue);
          break;
      }
      audit.outcome = 'success';
    } catch (err) {
      const safeMessage = `SecretsService.rotate failed for key="${key}": ${(err as Error).message}`;
      this.logger.error(safeMessage);
      // Emit audit with failure outcome before re-throwing.
      this.emitRotateAudit(audit);
      throw new Error(safeMessage);
    }

    this.emitRotateAudit(audit);
    this.logger.log(`rotate: key="${key}" rotated successfully backend=${this.backend}`);
  }

  // ---------------------------------------------------------------------------
  // Internal — env backend
  // ---------------------------------------------------------------------------

  private envGet(key: string): string {
    const value = process.env[key];
    if (value === undefined || value === null) {
      // Throw a clear message with no value — the key doesn't exist in env.
      throw new Error(`Key "${key}" not found in environment`);
    }
    return value;
  }

  private envSet(key: string, value: string): void {
    // Store at runtime in process.env; not persisted across restarts.
    // Values are intentionally not logged.
    process.env[key] = value;
  }

  // ---------------------------------------------------------------------------
  // Internal — AWS Secrets Manager backend
  // ---------------------------------------------------------------------------

  private get awsSafe(): SecretsManagerClient {
    if (!this.awsClient) {
      throw new Error('AWS Secrets Manager client not initialised');
    }
    return this.awsClient;
  }

  private async awsGet(key: string): Promise<string> {
    const cmd = new GetSecretValueCommand({ SecretId: key });
    const response = await this.awsSafe.send(cmd);

    if (response.SecretString === undefined) {
      throw new Error(`Secret "${key}" is binary-type; only string secrets are supported`);
    }
    return response.SecretString;
  }

  private async awsSet(key: string, value: string): Promise<void> {
    // Try to update first; create if the secret does not yet exist.
    try {
      const cmd = new PutSecretValueCommand({
        SecretId: key,
        SecretString: value,
      });
      await this.awsSafe.send(cmd);
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        // Secret does not exist — create it.
        try {
          const create = new CreateSecretCommand({
            Name: key,
            SecretString: value,
          });
          await this.awsSafe.send(create);
        } catch (createErr) {
          if (createErr instanceof ResourceExistsException) {
            // Race condition: another process created it between our check and create.
            // Fall back to update.
            const update = new UpdateSecretCommand({
              SecretId: key,
              SecretString: value,
            });
            await this.awsSafe.send(update);
          } else {
            throw createErr;
          }
        }
      } else {
        throw err;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — HashiCorp Vault KV v2 backend
  // ---------------------------------------------------------------------------

  private vaultPath(key: string): string {
    // KV v2 data path convention: /v1/{mount}/data/{secret-path}
    // Default mount is "secret"; callers may embed a custom prefix in the key.
    return `${this.vaultAddr}/v1/secret/data/${encodeURIComponent(key)}`;
  }

  private vaultHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // Token is used as a bearer header; its value is never logged by this service.
      'X-Vault-Token': this.vaultToken!,
    };
  }

  private async vaultGet(key: string): Promise<string> {
    const url = this.vaultPath(key);
    const response = await fetch(url, {
      method: 'GET',
      headers: this.vaultHeaders(),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Key "${key}" not found in Vault`);
      }
      throw new Error(`Vault GET failed for key="${key}": HTTP ${response.status}`);
    }

    // KV v2 response: { data: { data: { [key]: value } } }
    const body = (await response.json()) as {
      data?: { data?: Record<string, string> };
    };

    const secretData = body?.data?.data;
    if (!secretData || !Object.prototype.hasOwnProperty.call(secretData, 'value')) {
      throw new Error(`Vault response for key="${key}" missing expected "value" field`);
    }

    return secretData['value'];
  }

  private async vaultSet(key: string, value: string): Promise<void> {
    const url = this.vaultPath(key);
    const response = await fetch(url, {
      method: 'POST',
      headers: this.vaultHeaders(),
      // KV v2 write format: { data: { value: <secret> } }
      // The value is sent over the wire to Vault — never logged by this service.
      body: JSON.stringify({ data: { value: value } }),
    });

    if (!response.ok) {
      throw new Error(`Vault POST failed for key="${key}": HTTP ${response.status}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — audit helpers
  // ---------------------------------------------------------------------------

  /**
   * Emits a structured audit log entry for a rotate operation.
   * The record intentionally contains NO secret value.
   */
  private emitRotateAudit(record: RotateAuditRecord): void {
    this.logger.log(
      `AUDIT rotate key="${record.key}" backend=${record.backend} ` +
        `rotatedAt=${record.rotatedAt} outcome=${record.outcome}`,
    );
  }
}
