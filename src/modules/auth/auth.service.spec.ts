/**
 * AuthService unit tests.
 *
 * Covers the core behaviour of login, refresh, logout, and getStatus.
 * Token-expiry state-transition tests (login → expiry → disconnect → disarmed)
 * are in the dedicated task-4.5 test file.
 *
 * All TypeORM repositories and external services are mocked so these tests run
 * without a database or Redis connection.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { BrokerAccounts } from '../../database/entities/broker-accounts.entity';
import { BrokerSessions } from '../../database/entities/broker-sessions.entity';
import { AuditLogs } from '../../database/entities/audit-logs.entity';
import { RedisService } from '../redis/redis.service';
import { JwtPayload } from './jwt.strategy';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a minimal mock for a TypeORM repository. */
function buildMockRepo() {
  return {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;
  // Using 'any' for repo mocks avoids the TypeORM ObjectLiteral generic constraint
  // while still letting us call jest.fn() methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let brokerAccountsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let brokerSessionsRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auditLogsRepo: any;
  let jwtService: jest.Mocked<Pick<JwtService, 'signAsync' | 'decode'>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redisService: any;

  const MOCK_ACCOUNT: BrokerAccounts = {
    id: 'acct-uuid',
    userId: 'user-1',
    broker: 'DHAN',
    clientId: 'DH-001',
    apiKey: 'secret-api-key',
    accessToken: 'access-token',
    isActive: true,
    staticIp: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const MOCK_SESSION: BrokerSessions = {
    id: 'sess-uuid',
    brokerAccountId: 'acct-uuid',
    brokerAccount: MOCK_ACCOUNT,
    sessionToken: 'jwt-token',
    expiresAt: new Date(Date.now() + 1_800_000),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const MOCK_JWT_PAYLOAD: JwtPayload = {
    sub: 'user-1',
    clientId: 'DH-001',
    sid: 'sess-uuid',
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 1740,
  };

  beforeEach(async () => {
    brokerAccountsRepo = buildMockRepo();
    brokerSessionsRepo = buildMockRepo();
    auditLogsRepo = buildMockRepo();

    jwtService = {
      signAsync: jest.fn().mockResolvedValue('signed-jwt'),
      decode: jest.fn(),
    };

    redisService = {
      get: jest.fn().mockResolvedValue('DISARMED'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(BrokerAccounts), useValue: brokerAccountsRepo },
        { provide: getRepositoryToken(BrokerSessions), useValue: brokerSessionsRepo },
        { provide: getRepositoryToken(AuditLogs), useValue: auditLogsRepo },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: { get: () => '1800', getOrThrow: () => '1800' },
        },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ─── expirySeconds cap ──────────────────────────────────────────────────────

  describe('expirySeconds', () => {
    it('defaults to 1800 when JWT_EXPIRY_SECONDS is not set', () => {
      expect(service.expirySeconds).toBe(1800);
    });

    it('caps at 1800 even when a higher value is configured', async () => {
      const overrideMockRepo = buildMockRepo();
      const module = await Test.createTestingModule({
        providers: [
          AuthService,
          { provide: getRepositoryToken(BrokerAccounts), useValue: overrideMockRepo },
          { provide: getRepositoryToken(BrokerSessions), useValue: overrideMockRepo },
          { provide: getRepositoryToken(AuditLogs), useValue: overrideMockRepo },
          { provide: JwtService, useValue: jwtService },
          {
            provide: ConfigService,
            useValue: { get: () => '9999', getOrThrow: () => '9999' },
          },
          { provide: RedisService, useValue: redisService },
        ],
      }).compile();

      const svc = module.get<AuthService>(AuthService);
      expect(svc.expirySeconds).toBe(1800);
    });
  });

  // ─── login ──────────────────────────────────────────────────────────────────

  describe('login()', () => {
    beforeEach(() => {
      brokerAccountsRepo.findOne.mockResolvedValue(MOCK_ACCOUNT);
      brokerSessionsRepo.create.mockReturnValue(MOCK_SESSION);
      brokerSessionsRepo.save.mockResolvedValue(MOCK_SESSION);
      brokerSessionsRepo.update.mockResolvedValue({ affected: 1, generatedMaps: [], raw: [] });
      auditLogsRepo.create.mockReturnValue({});
      auditLogsRepo.save.mockResolvedValue({});
    });

    it('returns sessionToken and expiresAt on valid credentials', async () => {
      const result = await service.login('DH-001', 'secret-api-key', '127.0.0.1');

      expect(result.sessionToken).toBe('signed-jwt');
      expect(result.expiresAt).toBeDefined();
      // Verify it is a valid ISO 8601 date string
      expect(() => new Date(result.expiresAt)).not.toThrow();
    });

    it('calls JwtService.signAsync with the correct payload fields', async () => {
      await service.login('DH-001', 'secret-api-key');

      expect(jwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: MOCK_ACCOUNT.userId,
          clientId: MOCK_ACCOUNT.clientId,
          sid: MOCK_SESSION.id,
        }),
        expect.objectContaining({ expiresIn: 1800 }),
      );
    });

    it('writes a LOGIN SUCCESS audit log with userId and ipAddress', async () => {
      await service.login('DH-001', 'secret-api-key', '10.0.0.1');

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: MOCK_ACCOUNT.userId,
          eventType: 'LOGIN',
          outcome: 'SUCCESS',
          ipAddress: '10.0.0.1',
        }),
      );
    });

    it('throws 401 and writes LOGIN_FAILURE audit log when account not found', async () => {
      brokerAccountsRepo.findOne.mockResolvedValue(null);

      await expect(service.login('DH-001', 'wrong-key')).rejects.toThrow(UnauthorizedException);

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'LOGIN_FAILURE',
          outcome: 'FAILURE',
        }),
      );
    });

    it('throws 401 and writes LOGIN_FAILURE audit log on apiKey mismatch', async () => {
      await expect(service.login('DH-001', 'wrong-key')).rejects.toThrow(UnauthorizedException);

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'LOGIN_FAILURE',
          outcome: 'FAILURE',
        }),
      );
    });
  });

  // ─── refresh ────────────────────────────────────────────────────────────────

  describe('refresh()', () => {
    beforeEach(() => {
      brokerSessionsRepo.findOne.mockResolvedValue(MOCK_SESSION);
      brokerSessionsRepo.create.mockReturnValue({ ...MOCK_SESSION, id: 'new-sess-uuid' });
      brokerSessionsRepo.save.mockResolvedValue({ ...MOCK_SESSION, id: 'new-sess-uuid' });
      brokerSessionsRepo.update.mockResolvedValue({ affected: 1, generatedMaps: [], raw: [] });
      auditLogsRepo.create.mockReturnValue({});
      auditLogsRepo.save.mockResolvedValue({});
    });

    it('returns a new session token and expiresAt', async () => {
      const result = await service.refresh(MOCK_JWT_PAYLOAD, '127.0.0.1');

      expect(result.sessionToken).toBe('signed-jwt');
      expect(result.expiresAt).toBeDefined();
    });

    it('invalidates the old session before creating a new one', async () => {
      await service.refresh(MOCK_JWT_PAYLOAD);

      // First update call should deactivate the old session
      expect(brokerSessionsRepo.update).toHaveBeenCalledWith(MOCK_SESSION.id, { isActive: false });
    });

    it('writes a TOKEN_REFRESH SUCCESS audit log', async () => {
      await service.refresh(MOCK_JWT_PAYLOAD, '10.0.0.2');

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: MOCK_JWT_PAYLOAD.sub,
          eventType: 'TOKEN_REFRESH',
          outcome: 'SUCCESS',
        }),
      );
    });

    it('throws 401 and writes TOKEN_REFRESH FAILURE when session is inactive', async () => {
      brokerSessionsRepo.findOne.mockResolvedValue(null);

      await expect(service.refresh(MOCK_JWT_PAYLOAD)).rejects.toThrow(UnauthorizedException);

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'TOKEN_REFRESH',
          outcome: 'FAILURE',
        }),
      );
    });
  });

  // ─── logout ─────────────────────────────────────────────────────────────────

  describe('logout()', () => {
    beforeEach(() => {
      brokerSessionsRepo.update.mockResolvedValue({ affected: 1, generatedMaps: [], raw: [] });
      auditLogsRepo.create.mockReturnValue({});
      auditLogsRepo.save.mockResolvedValue({});
    });

    it('updates the session to isActive=false', async () => {
      await service.logout(MOCK_JWT_PAYLOAD, '127.0.0.1');

      expect(brokerSessionsRepo.update).toHaveBeenCalledWith(
        { id: MOCK_JWT_PAYLOAD.sid, isActive: true },
        { isActive: false },
      );
    });

    it('writes a LOGOUT SUCCESS audit log when session was active', async () => {
      await service.logout(MOCK_JWT_PAYLOAD, '127.0.0.1');

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: MOCK_JWT_PAYLOAD.sub,
          eventType: 'LOGOUT',
          outcome: 'SUCCESS',
        }),
      );
    });

    it('writes a LOGOUT FAILURE audit log when session was already inactive', async () => {
      brokerSessionsRepo.update.mockResolvedValue({ affected: 0, generatedMaps: [], raw: [] });

      await service.logout(MOCK_JWT_PAYLOAD);

      expect(auditLogsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'LOGOUT',
          outcome: 'FAILURE',
        }),
      );
    });
  });

  // ─── getStatus ───────────────────────────────────────────────────────────────

  describe('getStatus()', () => {
    it('returns authenticated=true when session is active', async () => {
      brokerSessionsRepo.findOne.mockResolvedValue(MOCK_SESSION);

      const result = await service.getStatus(MOCK_JWT_PAYLOAD);

      expect(result.authenticated).toBe(true);
      expect(result.armedState).toBe('DISARMED');
      expect(result.sessionExpiresAt).toBe(MOCK_SESSION.expiresAt.toISOString());
    });

    it('returns authenticated=false when session is not found', async () => {
      brokerSessionsRepo.findOne.mockResolvedValue(null);

      const result = await service.getStatus(MOCK_JWT_PAYLOAD);

      expect(result.authenticated).toBe(false);
    });

    it('reflects the armedState from Redis', async () => {
      brokerSessionsRepo.findOne.mockResolvedValue(MOCK_SESSION);
      redisService.get.mockResolvedValue('ARMED');

      const result = await service.getStatus(MOCK_JWT_PAYLOAD);

      expect(result.armedState).toBe('ARMED');
    });

    it('defaults armedState to DISARMED when Redis key is absent', async () => {
      brokerSessionsRepo.findOne.mockResolvedValue(MOCK_SESSION);
      redisService.get.mockResolvedValue(null);

      const result = await service.getStatus(MOCK_JWT_PAYLOAD);

      expect(result.armedState).toBe('DISARMED');
    });
  });

  // ─── audit log resilience ───────────────────────────────────────────────────

  describe('audit log resilience', () => {
    it('does not throw when auditLogs.save() fails during login', async () => {
      brokerAccountsRepo.findOne.mockResolvedValue(MOCK_ACCOUNT);
      brokerSessionsRepo.create.mockReturnValue(MOCK_SESSION);
      brokerSessionsRepo.save.mockResolvedValue(MOCK_SESSION);
      brokerSessionsRepo.update.mockResolvedValue({ affected: 1, generatedMaps: [], raw: [] });
      auditLogsRepo.create.mockReturnValue({});
      // Simulate audit DB write failure — login must still succeed
      auditLogsRepo.save.mockRejectedValue(new Error('DB write failure'));

      const result = await service.login('DH-001', 'secret-api-key');
      expect(result.sessionToken).toBe('signed-jwt');
    });
  });
});
