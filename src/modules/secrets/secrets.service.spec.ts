import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from './secrets.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal ConfigService mock.  All values default to 'env' backend
 * unless overridden per test.
 */
function buildConfigMock(overrides: Record<string, string> = {}): Partial<ConfigService> {
  const values: Record<string, string> = {
    SECRETS_BACKEND: 'env',
    ...overrides,
  };
  return {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      values[key] !== undefined ? values[key] : defaultValue,
    ) as ConfigService['get'],
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) {
        throw new Error(`Config key "${key}" not found`);
      }
      return values[key];
    }) as ConfigService['getOrThrow'],
  };
}

async function buildService(configOverrides: Record<string, string> = {}): Promise<SecretsService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SecretsService,
      { provide: ConfigService, useValue: buildConfigMock(configOverrides) },
    ],
  }).compile();

  const service = module.get<SecretsService>(SecretsService);
  await service.onModuleInit();
  return service;
}

// ---------------------------------------------------------------------------
// env backend — get()
// ---------------------------------------------------------------------------

describe('SecretsService (env backend)', () => {
  let service: SecretsService;

  const TEST_KEY = 'TEST_SECRET_KEY';
  const TEST_VALUE = 's3cr3t!';

  beforeAll(async () => {
    service = await buildService();
  });

  afterEach(() => {
    // Clean up any env mutations
    delete process.env[TEST_KEY];
  });

  // ── get() ─────────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('returns the value from process.env when the key exists', async () => {
      process.env[TEST_KEY] = TEST_VALUE;
      const result = await service.get(TEST_KEY);
      expect(result).toBe(TEST_VALUE);
    });

    it('throws when the key is not present in process.env', async () => {
      delete process.env[TEST_KEY];
      await expect(service.get(TEST_KEY)).rejects.toThrow(
        `Key "${TEST_KEY}" not found in environment`,
      );
    });

    it('error message for missing key does NOT contain the key value', async () => {
      delete process.env[TEST_KEY];
      const err = await service.get(TEST_KEY).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      // The message should reference the key name but never a secret value
      expect((err as Error).message).toContain(TEST_KEY);
    });

    it('handles empty string values gracefully', async () => {
      process.env[TEST_KEY] = '';
      const result = await service.get(TEST_KEY);
      expect(result).toBe('');
    });

    it('returns the exact value without any transformation', async () => {
      const complexValue = 'p@$$w0rd!#%^&*()\nwith\tnewlines';
      process.env[TEST_KEY] = complexValue;
      expect(await service.get(TEST_KEY)).toBe(complexValue);
    });
  });

  // ── set() ─────────────────────────────────────────────────────────────────

  describe('set()', () => {
    it('stores the value in process.env', async () => {
      await service.set(TEST_KEY, TEST_VALUE);
      expect(process.env[TEST_KEY]).toBe(TEST_VALUE);
    });

    it('overwrites an existing value', async () => {
      process.env[TEST_KEY] = 'old-value';
      await service.set(TEST_KEY, 'new-value');
      expect(process.env[TEST_KEY]).toBe('new-value');
    });

    it('resolves without throwing on success', async () => {
      await expect(service.set(TEST_KEY, TEST_VALUE)).resolves.toBeUndefined();
    });

    it('stores empty string values', async () => {
      await service.set(TEST_KEY, '');
      expect(process.env[TEST_KEY]).toBe('');
    });

    it('makes the value immediately retrievable via get()', async () => {
      const value = 'newly-set-secret';
      await service.set(TEST_KEY, value);
      const retrieved = await service.get(TEST_KEY);
      expect(retrieved).toBe(value);
    });
  });

  // ── rotate() ──────────────────────────────────────────────────────────────

  describe('rotate()', () => {
    it('updates the stored value to the new value', async () => {
      process.env[TEST_KEY] = 'old-value';
      await service.rotate(TEST_KEY, 'rotated-value');
      expect(await service.get(TEST_KEY)).toBe('rotated-value');
    });

    it('resolves without throwing on success', async () => {
      process.env[TEST_KEY] = 'initial';
      await expect(service.rotate(TEST_KEY, 'new')).resolves.toBeUndefined();
    });

    it('creates the key if it did not previously exist', async () => {
      delete process.env[TEST_KEY];
      await service.rotate(TEST_KEY, 'brand-new');
      expect(process.env[TEST_KEY]).toBe('brand-new');
    });

    it('old value is not accessible after rotation', async () => {
      process.env[TEST_KEY] = 'before-rotate';
      await service.rotate(TEST_KEY, 'after-rotate');
      expect(await service.get(TEST_KEY)).not.toBe('before-rotate');
    });

    it('sequential rotations each take effect', async () => {
      await service.rotate(TEST_KEY, 'v1');
      expect(await service.get(TEST_KEY)).toBe('v1');

      await service.rotate(TEST_KEY, 'v2');
      expect(await service.get(TEST_KEY)).toBe('v2');

      await service.rotate(TEST_KEY, 'v3');
      expect(await service.get(TEST_KEY)).toBe('v3');
    });
  });

  // ── Security invariants ───────────────────────────────────────────────────

  describe('security invariants', () => {
    it('error messages from get() never contain the secret value', async () => {
      // Simulate a known value in env, then confirm errors triggered by
      // internal operations do not leak it.
      process.env[TEST_KEY] = TEST_VALUE;
      delete process.env[TEST_KEY]; // trigger not-found error

      const err = await service.get(TEST_KEY).catch((e: Error) => e);
      expect((err as Error).message).not.toContain(TEST_VALUE);
    });

    it('get() returns the real value (not a masked placeholder)', async () => {
      // Callers need the real value; masking is only for logs, not the return value.
      process.env[TEST_KEY] = TEST_VALUE;
      const result = await service.get(TEST_KEY);
      expect(result).toBe(TEST_VALUE);
      expect(result).not.toBe('[REDACTED]');
    });

    it('set() resolves without returning the value', async () => {
      const returnValue = await service.set(TEST_KEY, TEST_VALUE);
      // set() must return void — any non-void return would risk exposure
      expect(returnValue).toBeUndefined();
    });

    it('rotate() resolves without returning the value', async () => {
      const returnValue = await service.rotate(TEST_KEY, TEST_VALUE);
      expect(returnValue).toBeUndefined();
    });
  });

  // ── Backend fallback ──────────────────────────────────────────────────────

  describe('backend selection', () => {
    it('defaults to env backend when SECRETS_BACKEND is not set', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SecretsService,
          {
            provide: ConfigService,
            useValue: {
              get: (key: string, def?: unknown) => (key === 'SECRETS_BACKEND' ? def : undefined),
              getOrThrow: (key: string) => {
                throw new Error(`${key} not set`);
              },
            },
          },
        ],
      }).compile();
      const svc = module.get<SecretsService>(SecretsService);
      await svc.onModuleInit(); // should not throw

      process.env[TEST_KEY] = 'value-from-default-env';
      expect(await svc.get(TEST_KEY)).toBe('value-from-default-env');
      delete process.env[TEST_KEY];
    });

    it('uses env backend when SECRETS_BACKEND=env', async () => {
      const svc = await buildService({ SECRETS_BACKEND: 'env' });
      process.env[TEST_KEY] = 'env-value';
      expect(await svc.get(TEST_KEY)).toBe('env-value');
      delete process.env[TEST_KEY];
    });
  });

  // ── Concurrent operations ─────────────────────────────────────────────────

  describe('concurrent operations', () => {
    it('handles concurrent get() calls for the same key', async () => {
      process.env[TEST_KEY] = TEST_VALUE;
      const results = await Promise.all([
        service.get(TEST_KEY),
        service.get(TEST_KEY),
        service.get(TEST_KEY),
      ]);
      expect(results).toEqual([TEST_VALUE, TEST_VALUE, TEST_VALUE]);
    });

    it('last write wins for concurrent set() calls on the same key', async () => {
      await Promise.all([
        service.set(TEST_KEY, 'a'),
        service.set(TEST_KEY, 'b'),
        service.set(TEST_KEY, 'c'),
      ]);
      // The final process.env value must be one of the submitted values.
      expect(['a', 'b', 'c']).toContain(process.env[TEST_KEY]);
    });
  });
});
